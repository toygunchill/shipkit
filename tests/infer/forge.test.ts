import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { blockingLabelsFromWorkflow, branchPatternFromRulesets } from "../../src/infer/forge.js";

const ruleset = JSON.parse(readFileSync("tests/fixtures/forge/ruleset.json", "utf8"));
const refScoped = JSON.parse(readFileSync("tests/fixtures/forge/ruleset-ref-scoped.json", "utf8"));
const workflow = readFileSync("tests/fixtures/forge/merge-gate.yml", "utf8");

/** One active ruleset with one branch_name_pattern rule, built around the part under test. */
function rulesetWith(parameters: Record<string, unknown>, conditions?: unknown) {
  return [
    {
      ...ruleset[0],
      ...(conditions === undefined ? {} : { conditions }),
      rules: [{ type: "branch_name_pattern", parameters }],
    },
  ];
}

describe("branchPatternFromRulesets", () => {
  it("takes the pattern from an active branch_name_pattern rule", () => {
    const got = branchPatternFromRulesets(ruleset);
    expect(got.kind).toBe("required");
    expect(got.kind === "required" && got.inferred.value).toBe(
      "^(feature|bugfix|livebug)/[a-z0-9]+/[0-9]+-[a-z0-9-]+$",
    );
    expect(got.kind === "required" && got.inferred.provenance).toBe("read");
  });

  // The ordinary GitHub layout. Taking the first match wrote the release pattern
  // into branch.pattern under a comment saying the forge proved it, and every
  // feature branch then failed branch-pattern on its first check.
  it("prefers the ruleset governing every ref over a ref-scoped one listed first", () => {
    const got = branchPatternFromRulesets(refScoped);
    expect(got.kind).toBe("required");
    expect(got.kind === "required" && got.inferred.value).toBe(
      "^(feature|bugfix|livebug)/[a-z0-9]+/[0-9]+-[a-z0-9-]+$",
    );
    expect(got.kind === "required" && got.inferred.value).not.toContain("release");
    expect(new RegExp(got.kind === "required" ? got.inferred.value : "$^").test("feature/toygun/1234-thing")).toBe(true);
  });

  it("reports ref-scoped rules as scoped rather than as the branch convention", () => {
    const got = branchPatternFromRulesets([refScoped[0]]);
    expect(got.kind).toBe("ref-scoped");
    expect(got.kind === "ref-scoped" && got.scopes.join(" ")).toContain("release branches");
    expect(got.kind === "ref-scoped" && got.scopes.join(" ")).toContain("refs/heads/release/*");
  });

  it("treats ~ALL with an exclusion as scoped, because the exclusion is the point", () => {
    const partial = rulesetWith(
      { operator: "regex", pattern: "^x$", negate: false },
      { ref_name: { include: ["~ALL"], exclude: ["refs/heads/legacy/*"] } },
    );
    const got = branchPatternFromRulesets(partial);
    expect(got.kind).toBe("ref-scoped");
    expect(got.kind === "ref-scoped" && got.scopes.join(" ")).toContain("refs/heads/legacy/*");
  });

  it("treats a ruleset with no conditions at all as governing every ref", () => {
    const { conditions: _dropped, ...unconditioned } = ruleset[0];
    const got = branchPatternFromRulesets([unconditioned]);
    expect(got.kind).toBe("required");
  });

  it("ignores a rule that is not being enforced", () => {
    const disabled = [{ ...ruleset[0], enforcement: "disabled" }];
    expect(branchPatternFromRulesets(disabled).kind).toBe("none");
  });

  it("ignores a negated rule, which forbids rather than requires", () => {
    const negated = rulesetWith({ operator: "regex", pattern: "x", negate: true });
    expect(branchPatternFromRulesets(negated).kind).toBe("none");
  });

  it("ignores a non-regex operator rather than treating it as one", () => {
    const starts = rulesetWith({ operator: "starts_with", pattern: "feature/" });
    expect(branchPatternFromRulesets(starts).kind).toBe("none");
  });

  it("refuses a pattern that is not a valid regular expression", () => {
    const broken = rulesetWith({ operator: "regex", pattern: "([", negate: false });
    expect(branchPatternFromRulesets(broken).kind).toBe("none");
  });

  // "" fails the schema's min(1), so it is a config that cannot load; "   " loads
  // and matches no branch anybody's is called, labelled `read`. Neither states a
  // requirement worth quoting the forge over.
  it.each(["", "   ", "\t"])("refuses an empty pattern (%j), which requires nothing", (pattern) => {
    const blank = rulesetWith({ operator: "regex", pattern, negate: false });
    expect(branchPatternFromRulesets(blank).kind).toBe("none");
  });

  it.each([null, undefined, 42, "nope", {}, [], [{}], [{ rules: null }]])(
    "returns none rather than throwing on %s",
    (payload) => {
      expect(() => branchPatternFromRulesets(payload)).not.toThrow();
      expect(branchPatternFromRulesets(payload).kind).toBe("none");
    },
  );

  it.each([
    [{ ref_name: null }],
    [{ ref_name: { include: "~ALL" } }],
    [{ ref_name: { include: [7, null] } }],
    ["conditions as a string"],
  ])("tolerates an unrecognised conditions shape (%j)", (conditions) => {
    const payload = rulesetWith({ operator: "regex", pattern: "^x$", negate: false }, conditions);
    expect(() => branchPatternFromRulesets(payload)).not.toThrow();
    expect(["required", "ref-scoped"]).toContain(branchPatternFromRulesets(payload).kind);
  });
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

  // `!contains(...)` runs the job when the label is ABSENT. Recording it as a
  // blocking label quotes the forge as proving the reverse of what it says.
  it.each([
    "!contains(github.event.pull_request.labels.*.name, 'skip changelog')",
    "! contains(github.event.pull_request.labels.*.name, 'skip changelog')",
    "!(contains(github.event.pull_request.labels.*.name, 'skip changelog'))",
    "${{ !contains(github.event.pull_request.labels.*.name, 'skip changelog') }}",
  ])("reads a negated condition as an opt-out, not a gate: %s", (condition) => {
    const text = `name: x\non: [pull_request]\njobs:\n  j:\n    steps:\n      - if: "${condition.replaceAll('"', '\\"')}"\n        run: echo\n`;
    expect(blockingLabelsFromWorkflow(text)).toBeUndefined();
  });

  it("keeps the real gate in a workflow that also carries an opt-out", () => {
    const text = [
      "name: x",
      "on: [pull_request]",
      "jobs:",
      "  changelog:",
      "    steps:",
      "      - if: \"!contains(github.event.pull_request.labels.*.name, 'skip changelog')\"",
      "        run: echo",
      "  gate:",
      "    steps:",
      "      - if: \"contains(github.event.pull_request.labels.*.name, 'in test')\"",
      "        run: exit 1",
    ].join("\n");
    expect(blockingLabelsFromWorkflow(text)?.value).toEqual(["in test"]);
  });

  // An `if:` in a nightly is not a merge gate: the workflow never runs on a pull
  // request at all.
  it("ignores a label condition in a workflow that does not run on pull requests", () => {
    const text = [
      "name: nightly",
      "on: [push, schedule]",
      "jobs:",
      "  nightly:",
      "    steps:",
      "      - if: \"contains(github.event.pull_request.labels.*.name, 'in test')\"",
      "        run: exit 1",
    ].join("\n");
    expect(blockingLabelsFromWorkflow(text)).toBeUndefined();
  });

  it.each([
    "on: pull_request",
    "on:\n  pull_request:\n    types: [opened, labeled]",
    "on: [push, pull_request]",
    "on:\n  pull_request_target:\n    types: [labeled]",
  ])("recognises the pull-request trigger written as %j", (on) => {
    const text = [
      "name: x",
      on,
      "jobs:",
      "  gate:",
      "    steps:",
      "      - if: \"contains(github.event.pull_request.labels.*.name, 'in test')\"",
      "        run: exit 1",
    ].join("\n");
    expect(blockingLabelsFromWorkflow(text)?.value).toEqual(["in test"]);
  });

  it.each(["", "[]", "- a\n- b", "42", "on: {}\njobs: {}"])(
    "returns undefined rather than throwing on %j",
    (text) => {
      expect(() => blockingLabelsFromWorkflow(text)).not.toThrow();
      expect(blockingLabelsFromWorkflow(text)).toBeUndefined();
    },
  );
});
