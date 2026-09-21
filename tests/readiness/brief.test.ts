import { describe, expect, it } from "vitest";
import { assembleBrief } from "../../src/brief/assemble.js";
import { loadConfig } from "../../src/config/load.js";
import { applicable } from "../../src/readiness/apply.js";
import { loadReadiness } from "../../src/readiness/load.js";
import type { ReadinessRule } from "../../src/readiness/types.js";

const config = loadConfig("tests/fixtures/valid.shipkit.yml");
const repo = {
  branch: "bugfix/squad/31087-invoice",
  changedFiles: ["Sources/Scenes/Payment/View.swift"],
  diffstat: " 1 file changed",
  commits: ["fix(invoice): default citizenship"],
};
const target = { branch: "develop", reason: "given with --base" };

const SCOPED: ReadinessRule = {
  id: "design-tokens",
  ask: "Do the colours use\nthe right semantic token?\n",
  why: "25 of 80 root comments\n",
  appliesTo: ["**/*.swift"],
  severity: "warn",
};
const ALWAYS: ReadinessRule = {
  id: "all-entry-paths",
  ask: "Does the new check hold on every entry path?",
  severity: "warn",
};

describe("the brief's readiness questions", () => {
  it("carries no key at all when the repository configures no rules", () => {
    // A brief with an empty key invites an agent to look for something that is not there,
    // and every `.shipkit.yml` in existence today is this case.
    expect(assembleBrief({ repo, target, config })).not.toHaveProperty("readiness");
  });

  it("carries no key when rules exist but none of them apply", () => {
    expect(
      assembleBrief({ repo, target, config, readiness: applicable([SCOPED], ["docs/README.md"]) }),
    ).not.toHaveProperty("readiness");
  });

  it("carries the applicable subset, each with its question, reason and stakes", () => {
    const brief = assembleBrief({
      repo,
      target,
      config,
      readiness: applicable([SCOPED, ALWAYS], ["Sources/Scenes/Payment/View.swift"]),
    });

    expect(brief.readiness).toEqual([
      {
        id: "design-tokens",
        ask: "Do the colours use\nthe right semantic token?",
        why: "25 of 80 root comments",
        severity: "warn",
      },
      { id: "all-entry-paths", ask: "Does the new check hold on every entry path?", severity: "warn" },
    ]);
  });

  it("never carries the path patterns", () => {
    // The agent is asked whether the work is ready, not asked to re-derive why it was asked.
    const brief = assembleBrief({ repo, target, config, readiness: [SCOPED] });
    expect(JSON.stringify(brief)).not.toContain("appliesTo");
    expect(JSON.stringify(brief)).not.toContain("*.swift");
  });

  it("asks every rule whose scope the change matches, end to end against the example", () => {
    // Against the shipped file rather than a fixture: the example is what a reader copies,
    // so a scope in it that matches nothing is a rule nobody would ever be asked.
    const rules = loadReadiness("docs/examples/example.shipkit.yml", "./example.readiness.yml");
    const brief = assembleBrief({
      repo,
      target,
      config,
      readiness: applicable(rules, ["Common/Sheets/View.swift"]),
    });

    const asked = brief.readiness?.map((item) => item.id) ?? [];
    expect(asked).toContain("tests-mean-something");
    expect(asked).toContain("shared-component-blast-radius");
    expect(asked).toContain("leftovers");
  });

  // The discriminating half of the pair above: a change touching no code must drop the
  // code-scoped rules and keep only the ones about the change as a whole.
  it("drops the scoped rules for a change that touches no code", () => {
    const rules = loadReadiness("docs/examples/example.shipkit.yml", "./example.readiness.yml");
    const brief = assembleBrief({
      repo,
      target,
      config,
      readiness: applicable(rules, ["README.md", "fastlane/Fastfile"]),
    });

    const asked = brief.readiness?.map((item) => item.id) ?? [];
    expect(asked).not.toContain("tests-mean-something");
    expect(asked).not.toContain("shared-component-blast-radius");
    expect(asked).toContain("leftovers");
  });
});
