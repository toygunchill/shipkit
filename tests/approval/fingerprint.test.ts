import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonical, fingerprint, type Situation } from "../../src/approval/fingerprint.js";

const BASE: Situation = {
  repo: "/Users/x/example-app",
  branch: "bugfix/squadb/31087-invoice",
  base: "release/3.76.0",
  head: "a44dcf5d9f8a0c59fb282d667cfab5e1e809d6bd",
  warnings: [
    { check: "approvals-dismissed", message: "Pushing will dismiss 4 approval(s) on #881" },
    { check: "blocking-label", message: 'Label(s) in test will block the merge gate' },
  ],
};

describe("canonical", () => {
  // Length prefixes, not escaping. Two implementations have to agree byte for
  // byte, and a delimiter that can appear inside a message is a disagreement
  // waiting for the first warning that contains one.
  it("prefixes every field with its UTF-8 byte length", () => {
    const form = canonical({ ...BASE, warnings: [] });
    expect(form.split("\n")[0]).toBe("shipkit-approval-v1");
    expect(form).toContain(`${Buffer.byteLength(BASE.repo, "utf8")}:${BASE.repo}`);
  });

  it("counts bytes, not characters", () => {
    const form = canonical({ ...BASE, branch: "bugfix/ödeme", warnings: [] });
    // "bugfix/ödeme" is 12 characters and 13 bytes.
    expect(form).toContain("13:bugfix/ödeme");
  });

  it("states how many warnings follow", () => {
    expect(canonical(BASE)).toContain("\n2\n");
  });

  it("survives a message containing a newline and a colon", () => {
    const nasty = { check: "x", message: "a:1\n5:fake" };
    const form = canonical({ ...BASE, warnings: [nasty] });
    expect(form).toContain(`${Buffer.byteLength(nasty.message, "utf8")}:${nasty.message}`);
  });
});

describe("fingerprint", () => {
  it("is a lowercase hex sha-256", () => {
    expect(fingerprint(BASE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the head commit changes", () => {
    expect(fingerprint({ ...BASE, head: "b".repeat(40) })).not.toBe(fingerprint(BASE));
  });

  // The reason messages are hashed and not only ids: a fifth approval landing
  // while the request waits leaves the id set identical and the situation
  // different.
  it("changes when a warning's message changes but its id does not", () => {
    const fewer = BASE.warnings.map((w) =>
      w.check === "approvals-dismissed"
        ? { ...w, message: "Pushing will dismiss 5 approval(s) on #881" }
        : w,
    );
    expect(fingerprint({ ...BASE, warnings: fewer })).not.toBe(fingerprint(BASE));
  });

  it("changes when a warning is added", () => {
    const more = [...BASE.warnings, { check: "untracked-files", message: "one file" }];
    expect(fingerprint({ ...BASE, warnings: more })).not.toBe(fingerprint(BASE));
  });

  // Order is taken as given rather than sorted. preflight pushes its checks in a
  // fixed order, so the same situation always renders the same way; sorting
  // would need a byte-wise comparator agreed across two languages for no gain.
  it("distinguishes a different order, and preflight never produces one", () => {
    const swapped = [BASE.warnings[1], BASE.warnings[0]];
    expect(fingerprint({ ...BASE, warnings: swapped })).not.toBe(fingerprint(BASE));
  });

  it("is stable across calls", () => {
    expect(fingerprint(BASE)).toBe(fingerprint(structuredClone(BASE)));
  });
});

describe("the shared fixture", () => {
  // The Swift application computes this hash too, and a disagreement is
  // invisible until someone tries to approve something. This file is the
  // contract; both test suites read it.
  it("matches every recorded vector", () => {
    const vectors = JSON.parse(
      readFileSync("tests/fixtures/fingerprint-vectors.json", "utf8"),
    ) as { name: string; situation: Situation; fingerprint: string }[];

    expect(vectors.length).toBeGreaterThanOrEqual(4);
    for (const vector of vectors) {
      expect(fingerprint(vector.situation), vector.name).toBe(vector.fingerprint);
    }
  });
});
