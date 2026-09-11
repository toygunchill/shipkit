import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonical,
  fingerprint,
  sortWarnings,
  type Situation,
} from "../../src/approval/fingerprint.js";

const BASE: Situation = {
  repo: "/Users/x/example-app",
  branch: "bugfix/squadb/31087-invoice",
  base: "release/3.76.0",
  head: "a44dcf5d9f8a0c59fb282d667cfab5e1e809d6bd",
  title: "fix(invoice): default citizenship",
  commitMessage: "fix(invoice): default citizenship",
  diffstat: "12 files changed, 148 insertions(+), 37 deletions(-)",
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
    expect(form.split("\n")[0]).toBe("shipkit-approval-v2");
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

  // The application displays the title and the commit message alongside the rest of the
  // situation, so a call that times out and is repeated with the same warnings and head but
  // different prose must not produce the same fingerprint — otherwise the person approves the
  // pending request and the retried call opens a pull request with prose nobody saw.
  it("changes when the title changes", () => {
    expect(fingerprint({ ...BASE, title: "fix(invoice): something else entirely" })).not.toBe(
      fingerprint(BASE),
    );
  });

  it("changes when the commit message changes", () => {
    expect(fingerprint({ ...BASE, commitMessage: "fix(invoice): something else entirely" })).not.toBe(
      fingerprint(BASE),
    );
  });

  // The panel renders the diffstat directly under the title, because the size of
  // the change is half of what the reader is judging. A field that is displayed
  // and not bound is a field the reader can be shown one version of while another
  // is committed — "3 files changed" on screen, four hundred in the push.
  it("changes when the diffstat changes", () => {
    expect(
      fingerprint({ ...BASE, diffstat: "400 files changed, 90000 insertions(+)" }),
    ).not.toBe(fingerprint(BASE));
  });

  // An empty diffstat is a real value, not a missing one: a branch whose work is
  // all uncommitted used to produce exactly that. It must not hash like any other.
  it("distinguishes an empty diffstat from a non-empty one", () => {
    expect(fingerprint({ ...BASE, diffstat: "" })).not.toBe(fingerprint(BASE));
  });

  // The diffstat sits between the commit message and the warning count, and it is
  // length-prefixed like every other field, so a diffstat that looks like the
  // encoding cannot be mistaken for the fields that follow it.
  it("keeps a diffstat that looks like the encoding in its own field", () => {
    const diffstat = "2\n7:spoofed";
    const lines = canonical({ ...BASE, diffstat, warnings: [] }).split("\n");
    // Line 7, after the version, repo, branch, base, head, title and commit
    // message — and its own newline makes it span two lines of the form.
    expect(lines[7]).toBe(`${Buffer.byteLength(diffstat, "utf8")}:2`);
    expect(lines[8]).toBe("7:spoofed");
    // The warning count follows it, and is the count, not the "7" above.
    expect(lines[9]).toBe("0");
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

  // Warnings are sorted by check id, then message, using code-unit order (the
  // order that < and > produce). Two warnings with the same id sort by message
  // using code-unit order, so uppercase comes before lowercase.
  it("normalizes warning order by sorting with code-unit order", () => {
    const swapped = [BASE.warnings[1], BASE.warnings[0]];
    expect(fingerprint({ ...BASE, warnings: swapped })).toBe(fingerprint(BASE));
  });

  // Code-unit order means uppercase sorts before lowercase (e.g. "Alpha" < "alpha").
  // This is the order that < produces in JavaScript and Swift, ensuring both
  // implementations agree without locale-dependent collation.
  it("sorts by code-unit order, with uppercase before lowercase", () => {
    const uppercase = { check: "x", message: "Alpha" };
    const lowercase = { check: "x", message: "alpha" };
    const swapped = [lowercase, uppercase];
    expect(fingerprint({ ...BASE, warnings: swapped })).toBe(
      fingerprint({ ...BASE, warnings: [uppercase, lowercase] }),
    );
  });

  // The one pair where the two languages can disagree about equality. Swift's
  // `String ==` compares by canonical equivalence and calls these check ids the
  // same; `!==` here compares code units and calls them different, so the order
  // is decided by the check id and not by the message. The guard in front of
  // Swift's comparator has to say the same thing, and the shared fixture pins it.
  it("orders check ids that are canonically equal by their code units", () => {
    const decomposed = { check: "caf\u0065\u0301", message: "b" };
    const precomposed = { check: "caf\u00e9", message: "a" };
    expect(sortWarnings([precomposed, decomposed])).toEqual([decomposed, precomposed]);
    expect(sortWarnings([decomposed, precomposed])).toEqual([decomposed, precomposed]);
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

    expect(vectors.length).toBeGreaterThanOrEqual(11);
    for (const vector of vectors) {
      expect(fingerprint(vector.situation), vector.name).toBe(vector.fingerprint);
    }
  });
});
