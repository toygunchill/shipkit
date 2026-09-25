import { describe, expect, it } from "vitest";
import { baseRef, explainBaseRules, rulesAtBase } from "../../src/prreview/baserules.js";

const CONFIG = `
pr:
  titlePattern: '^(feat|fix): .+'
  sections:
    - name: Summary
      required: true
branch:
  pattern: '^feature/.+'
jira:
  baseUrl: https://jira.example.com
  keyPattern: 'ABC-\\d+'
readiness: ./checklist.yml
`;

const CHECKLIST = `
version: 1
rules:
  - id: errors-handled
    ask: Is every error path handled?
    severity: advise
  - id: tests-mean-something
    ask: Does each test fail when its behaviour breaks?
    severity: advise
`;

/** A git that answers from a map of `ref:path`, and knows which refs exist. */
function git(files: Record<string, string>, refs = ["origin/develop"]) {
  const calls: string[][] = [];
  const run = (args: string[]): string | undefined => {
    calls.push(args);
    if (args[0] === "rev-parse") {
      const named = (args[3] ?? "").replace(/\^\{commit\}$/, "");
      return refs.includes(named) ? "abc123" : undefined;
    }
    if (args[0] === "ls-tree") {
      const ref = args[3] as string;
      const paths = Object.keys(files)
        .filter((key) => key.startsWith(`${ref}:`))
        .map((key) => key.slice(ref.length + 1));
      return paths.join("\n");
    }
    if (args[0] === "show") return files[args[1] as string];
    return undefined;
  };
  return { calls, run };
}

describe("choosing the ref to read the rules from", () => {
  // A reviewer's local `develop` can be weeks behind, and judging a change against stale
  // rules is the failure this module exists to avoid.
  it("prefers the remote-tracking branch over a local one", () => {
    expect(baseRef("develop", git({}, ["origin/develop", "develop"]).run)).toBe("origin/develop");
  });

  it("falls back to the local branch when there is no remote one", () => {
    expect(baseRef("develop", git({}, ["develop"]).run)).toBe("develop");
  });

  it("says nothing when the branch is not there at all", () => {
    expect(baseRef("nope", git({}, []).run)).toBeUndefined();
  });
});

describe("reading the rules a pull request will merge into", () => {
  // The case that prompted this: rules merged to develop, reviewer on a branch cut before
  // they landed. Nothing here touches the working tree.
  it("finds a config under docs and the checklist beside it", () => {
    const { run } = git({
      "origin/develop:docs/rules/pull-request-conventions.yml": CONFIG,
      "origin/develop:docs/rules/checklist.yml": CHECKLIST,
    });

    const outcome = rulesAtBase("develop", run);

    expect(outcome.found).toBe("one");
    expect(outcome.found === "one" && outcome.configPath).toBe("docs/rules/pull-request-conventions.yml");
    expect(outcome.found === "one" && outcome.rules.map((r) => r.id)).toEqual([
      "errors-handled",
      "tests-mean-something",
    ]);
  });

  it("never reads the working tree, only the ref", () => {
    const { calls, run } = git({
      "origin/develop:.shipkit.yml": CONFIG,
      "origin/develop:checklist.yml": CHECKLIST,
    });

    rulesAtBase("develop", run);

    for (const call of calls) {
      if (call[0] === "show") expect(call[1]).toMatch(/^origin\/develop:/);
    }
  });

  it("reads a config at the repository root", () => {
    const { run } = git({
      "origin/develop:.shipkit.yml": CONFIG,
      "origin/develop:checklist.yml": CHECKLIST,
    });

    expect(rulesAtBase("develop", run).found).toBe("one");
  });

  // A YAML that is not a config must not become one; this repository has workflows and
  // linter configs and none of them is a set of pull-request conventions.
  it("does not mistake another tool's YAML for a config", () => {
    const { run } = git({
      "origin/develop:.github/workflows/ci.yml": "name: CI\non: [push]\n",
      "origin/develop:.swiftlint.yml": "disabled_rules:\n  - todo\n",
    });

    expect(rulesAtBase("develop", run).found).toBe("none");
  });

  it("refuses two configs rather than picking by path order", () => {
    const { run } = git({
      "origin/develop:.shipkit.yml": CONFIG,
      "origin/develop:docs/rules/other.yml": CONFIG,
    });

    const outcome = rulesAtBase("develop", run);

    expect(outcome.found).toBe("several");
    expect(outcome.found === "several" && outcome.paths).toHaveLength(2);
  });

  // Not a walk of the ref: a config-shaped YAML buried in the source tree was not offered
  // as one.
  it("does not search the whole tree", () => {
    const { run } = git({ "origin/develop:Sources/Deep/conventions.yml": CONFIG });

    expect(rulesAtBase("develop", run).found).toBe("none");
  });

  // A review with no rules to cite produces no remarks, which is correct and visible. A
  // crash is neither.
  it("reads an unreadable checklist as no rules, not as a failure", () => {
    const { run } = git({ "origin/develop:.shipkit.yml": CONFIG });

    const outcome = rulesAtBase("develop", run);

    expect(outcome.found).toBe("one");
    expect(outcome.found === "one" && outcome.rules).toEqual([]);
  });

  it("says the target branch carries none, not that yours does", () => {
    const message = explainBaseRules({ found: "none", ref: "develop" }, "develop");

    expect(message).toContain("not from your own checkout");
  });
});
