import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { blockingLabelsFromWorkflow, branchPatternFromRulesets } from "../../src/infer/forge.js";

const ruleset = JSON.parse(readFileSync("tests/fixtures/forge/ruleset.json", "utf8"));
const workflow = readFileSync("tests/fixtures/forge/merge-gate.yml", "utf8");

describe("branchPatternFromRulesets", () => {
  it("takes the pattern from an active branch_name_pattern rule", () => {
    const got = branchPatternFromRulesets(ruleset);
    expect(got?.value).toBe("^(feature|bugfix|livebug)/[a-z0-9]+/[0-9]+-[a-z0-9-]+$");
    expect(got?.provenance).toBe("read");
  });

  it("ignores a rule that is not being enforced", () => {
    const disabled = [{ ...ruleset[0], enforcement: "disabled" }];
    expect(branchPatternFromRulesets(disabled)).toBeUndefined();
  });

  it("ignores a negated rule, which forbids rather than requires", () => {
    const negated = [
      { ...ruleset[0], rules: [{ type: "branch_name_pattern", parameters: { operator: "regex", pattern: "x", negate: true } }] },
    ];
    expect(branchPatternFromRulesets(negated)).toBeUndefined();
  });

  it("ignores a non-regex operator rather than treating it as one", () => {
    const starts = [
      { ...ruleset[0], rules: [{ type: "branch_name_pattern", parameters: { operator: "starts_with", pattern: "feature/" } }] },
    ];
    expect(branchPatternFromRulesets(starts)).toBeUndefined();
  });

  it("refuses a pattern that is not a valid regular expression", () => {
    const broken = [
      { ...ruleset[0], rules: [{ type: "branch_name_pattern", parameters: { operator: "regex", pattern: "([", negate: false } }] },
    ];
    expect(branchPatternFromRulesets(broken)).toBeUndefined();
  });

  it.each([null, undefined, 42, "nope", {}, [], [{}], [{ rules: null }]])(
    "returns undefined rather than throwing on %s",
    (payload) => {
      expect(() => branchPatternFromRulesets(payload)).not.toThrow();
      expect(branchPatternFromRulesets(payload)).toBeUndefined();
    },
  );
});

describe("blockingLabelsFromWorkflow", () => {
  it("finds every label the gate blocks on", () => {
    const got = blockingLabelsFromWorkflow(workflow);
    expect(got?.value).toEqual(["do not merge", "in test"]);
    expect(got?.provenance).toBe("read");
  });

  it("returns undefined rather than throwing on text that is not YAML", () => {
    expect(() => blockingLabelsFromWorkflow(":::not yaml:::")).not.toThrow();
  });

  it("returns undefined when no label gate is present", () => {
    expect(blockingLabelsFromWorkflow("name: x\non: [push]\njobs: {}\n")).toBeUndefined();
  });
});
