import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSlug, prepare, publishNotice, readRemarks } from "../../src/prreview/run.js";
import type { ReadinessRule } from "../../src/readiness/types.js";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,2 @@
 one
+two
`;

function gh(viewerIsAuthor = false) {
  return (args: string[]) => {
    if (args[0] === "api") return viewerIsAuthor ? "someone" : "someone-else";
    if (args[1] === "view") {
      return JSON.stringify({
        number: 12,
        title: "t",
        body: "b",
        author: { login: "someone" },
        baseRefName: "develop",
        headRefOid: "d".repeat(40),
      });
    }
    return DIFF;
  };
}

const rules: ReadinessRule[] = [{ id: "ADR-012", ask: "?", severity: "advise" }];

function tmpFile(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "shipkit-remarks-")), "r.json");
  writeFileSync(path, contents, "utf8");
  return path;
}

describe("reading a repository from what a person typed", () => {
  it("reads owner/name", () => {
    expect(parseSlug("acme/widget")).toEqual({ owner: "acme", repo: "widget" });
  });

  // An enterprise forge is the case the inbox already handles, and a review posted to the
  // wrong host is not recoverable.
  it("reads host/owner/name", () => {
    expect(parseSlug("git.example.com/acme/widget")).toMatchObject({
      host: "git.example.com",
      owner: "acme",
      repo: "widget",
    });
  });

  it("refuses something that is not a repository", () => {
    expect(() => parseSlug("widget")).toThrow(/owner\/name/);
  });
});

describe("reading the agent's remarks", () => {
  it("takes a bare array", () => {
    const path = tmpFile('[{"ruleId":"ADR-012","body":"x"}]');

    expect(readRemarks(path)).toHaveLength(1);
  });

  // Both shapes are what agents actually write. Insisting on one would be a rule about
  // formatting rather than about the review.
  it("takes an object with the array under remarks", () => {
    const path = tmpFile('{"remarks":[{"ruleId":"ADR-012","body":"x"}]}');

    expect(readRemarks(path)).toHaveLength(1);
  });

  it("says so when the file is not JSON", () => {
    expect(() => readRemarks(tmpFile("nope"))).toThrow(/not JSON/);
  });

  it("says so when there is no list in it", () => {
    expect(() => readRemarks(tmpFile('{"x":1}'))).toThrow(/no list/);
  });

  it("says so when the file is missing", () => {
    expect(() => readRemarks("/nowhere/at/all.json")).toThrow(/could not read/i);
  });
});

describe("preparing a review", () => {
  it("sorts the remarks and pins the target to the head it read", () => {
    const prepared = prepare(
      "acme/widget",
      12,
      [
        { ruleId: "ADR-012", path: "src/a.ts", line: 2, side: "RIGHT", body: "no" },
        { ruleId: "ADR-999", body: "invented" },
      ],
      rules,
      gh(),
    );

    expect(prepared.validation.accepted).toHaveLength(1);
    expect(prepared.validation.rejected).toHaveLength(1);
    expect(prepared.target.headSha).toBe("d".repeat(40));
  });
});

describe("what a person is told before it becomes public", () => {
  const prepared = (mine: boolean) =>
    prepare(
      "acme/widget",
      12,
      [{ ruleId: "ADR-012", path: "src/a.ts", line: 2, side: "RIGHT", body: "no" }],
      rules,
      gh(mine),
    );

  // The publish is immediate and a notification cannot be withdrawn, so the sentence has to
  // carry enough for a person to notice this is the wrong pull request.
  it("names whose pull request it is, which one, and how many comments", () => {
    const notice = publishNotice(prepared(false));

    expect(notice).toContain("someone's");
    expect(notice).toContain("acme/widget#12");
    expect(notice).toContain("1 comment");
    expect(notice).toMatch(/cannot be withdrawn/);
  });

  it("says so plainly when the pull request is your own", () => {
    expect(publishNotice(prepared(true))).toContain("your own");
  });
});
