import { describe, expect, it } from "vitest";
import { commentableAnchors } from "../../src/prreview/anchors.js";
import { validateRemarks, type Remark } from "../../src/prreview/validate.js";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 one
+two
+three
`;

const anchors = commentableAnchors(DIFF);
const rules = new Set(["ADR-012", "ADR-004", "readiness-design-tokens"]);

function remark(over: Partial<Remark> = {}): Remark {
  return { ruleId: "ADR-012", path: "src/a.ts", line: 2, side: "RIGHT", body: "no", ...over };
}

describe("accepting or refusing what the agent wrote", () => {
  it("accepts a remark that cites a real rule and lands on a real line", () => {
    const { accepted, rejected } = validateRemarks([remark()], anchors, rules);

    expect(rejected).toHaveLength(0);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ placement: "line", path: "src/a.ts", line: 2 });
  });

  // The failure this check exists for. An agent asked to cite a rule will invent a
  // plausible id rather than stay silent, and a fabricated citation is worse than no
  // remark: it reads as authoritative.
  it("refuses a rule id the repository does not have", () => {
    const { accepted, rejected } = validateRemarks([remark({ ruleId: "ADR-999" })], anchors, rules);

    expect(accepted).toHaveLength(0);
    expect(rejected[0]?.reason).toContain("ADR-999");
  });

  it("refuses a line the diff does not touch", () => {
    const { rejected } = validateRemarks([remark({ line: 99 })], anchors, rules);

    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatch(/line/i);
  });

  it("refuses a file the diff does not touch", () => {
    const { rejected } = validateRemarks([remark({ path: "src/other.ts" })], anchors, rules);

    expect(rejected).toHaveLength(1);
  });

  // Line 2 exists on the right but never on the left — it is an addition. Getting the side
  // wrong is how a comment lands on the wrong version of the file.
  it("refuses the right line on the wrong side", () => {
    const { rejected } = validateRemarks([remark({ side: "LEFT" })], anchors, rules);

    expect(rejected).toHaveLength(1);
  });

  it("refuses an empty body, however well anchored", () => {
    const { rejected } = validateRemarks([remark({ body: "   " })], anchors, rules);

    expect(rejected).toHaveLength(1);
  });

  // Not every true observation belongs to a line. Discarding those would quietly lose the
  // most general remarks, which are often the ones worth reading.
  it("keeps a remark with no position as one about the pull request", () => {
    const { accepted } = validateRemarks(
      [{ ruleId: "ADR-004", body: "the whole change assumes a store that is never owned" }],
      anchors,
      rules,
    );

    expect(accepted[0]).toMatchObject({ placement: "pull", ruleId: "ADR-004" });
  });

  // One bad anchor is not a reason to throw away four good remarks, and the bad one is
  // reported rather than dropped — an agent that keeps inventing ids is worth knowing about.
  it("keeps the good remarks when one is refused, and reports the refusal", () => {
    const { accepted, rejected } = validateRemarks(
      [remark(), remark({ ruleId: "ADR-999" }), remark({ line: 3 })],
      anchors,
      rules,
    );

    expect(accepted).toHaveLength(2);
    expect(rejected).toHaveLength(1);
  });

  it("refuses a remark citing no rule at all", () => {
    const { rejected } = validateRemarks([remark({ ruleId: "" })], anchors, rules);

    expect(rejected).toHaveLength(1);
  });

  // A path with a line but no side is ambiguous, and guessing RIGHT would be a guess about
  // which version of the file the reader meant.
  it("refuses a position that names a line but not a side", () => {
    const { rejected } = validateRemarks(
      [{ ruleId: "ADR-012", path: "src/a.ts", line: 2, body: "no" }],
      anchors,
      rules,
    );

    expect(rejected).toHaveLength(1);
  });
});
