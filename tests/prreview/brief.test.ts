import { describe, expect, it } from "vitest";
import { commentableAnchors } from "../../src/prreview/anchors.js";
import { reviewBrief } from "../../src/prreview/brief.js";
import type { Gathered } from "../../src/prreview/gather.js";
import type { ReadinessRule } from "../../src/readiness/types.js";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
 one
-old
+new
`;

const gathered: Gathered = {
  pull: {
    owner: "acme",
    repo: "widget",
    number: 12,
    title: "fix: something",
    body: "## Summary",
    author: "someone",
    baseRef: "develop",
    headSha: "c".repeat(40),
    host: undefined,
    mine: false,
  },
  diff: DIFF,
  anchors: commentableAnchors(DIFF),
};

const rules: ReadinessRule[] = [
  { id: "ADR-012", ask: "Is navigation done through a router?", why: "measured", severity: "advise" },
  { id: "ADR-004", ask: "Is the model owned rather than observed?", severity: "block" },
];

describe("the brief handed to the agent", () => {
  it("lists the rules it may cite, with the question behind each", () => {
    const brief = reviewBrief(gathered, rules);

    expect(brief.rules.map((r) => r.id)).toEqual(["ADR-012", "ADR-004"]);
    expect(brief.rules[0]?.ask).toContain("router");
    expect(brief.rules[0]?.why).toBe("measured");
  });

  // Severity decides what a *submit* does with a rule — block, warn, advise. It says
  // nothing about whether a reviewer should raise it, and shipping it here would invite the
  // agent to skip `advise` rules, which are often exactly what a human would comment on.
  it("does not tell the agent how severe a rule is", () => {
    expect(JSON.stringify(reviewBrief(gathered, rules))).not.toContain("advise");
  });

  it("gives the anchors as plain line numbers, split by side", () => {
    const brief = reviewBrief(gathered, rules);
    const file = brief.anchors.find((a) => a.path === "src/a.ts");

    expect(file?.right).toEqual([1, 2]);
    expect(file?.left).toEqual([2]);
  });

  it("sorts anchors and lines, so the same diff always produces the same brief", () => {
    const two = `${DIFF}diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1,1 +1,1 @@
+x
`;
    const brief = reviewBrief({ ...gathered, diff: two, anchors: commentableAnchors(two) }, rules);

    expect(brief.anchors.map((a) => a.path)).toEqual(["b.ts", "src/a.ts"]);
  });

  it("carries the pull request's own words, which is the context the rules are judged in", () => {
    const brief = reviewBrief(gathered, rules);

    expect(brief.pull).toMatchObject({ repository: "acme/widget", number: 12, author: "someone", mine: false });
    expect(brief.diff).toContain("+new");
  });

  // The contract is the whole noise control. If it stops saying these things the feature
  // degrades into a model writing whatever it likes on a colleague's pull request.
  it("states the constraints that keep the review to the written rules", () => {
    const contract = reviewBrief(gathered, rules).contract.join(" ");

    expect(contract).toContain("ruleId");
    expect(contract).toMatch(/do not write the remark/i);
    expect(contract).toMatch(/do not invent/i);
    expect(contract).toMatch(/anchors/i);
    expect(contract).toMatch(/empty list/i);
  });

  it("still produces a usable brief when the repository has no rules", () => {
    const brief = reviewBrief(gathered, []);

    expect(brief.rules).toEqual([]);
    // With nothing to cite, the contract's own requirement means the honest answer is an
    // empty review — which is better than a review with nothing behind it.
    expect(brief.contract.length).toBeGreaterThan(0);
  });
});
