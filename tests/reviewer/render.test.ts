import { describe, expect, it } from "vitest";
import type { ReadinessRule } from "../../src/readiness/types.js";
import { agentName, renderReviewer } from "../../src/reviewer/render.js";

const rules: ReadinessRule[] = [
  { id: "layering", ask: "Does the change keep its layer?", why: "measured across 40 pull requests", severity: "advise" },
  { id: "tests-mean-something", ask: "Does each test fail when its behaviour breaks?", severity: "block" },
];

describe("naming the agent after the repository", () => {
  it("takes the repository's own name", () => {
    expect(agentName("acme/widget")).toBe("widget-reviewer");
    expect(agentName("git.example.com/acme/widget")).toBe("widget-reviewer");
  });

  it("makes a name an agent can actually carry", () => {
    expect(agentName("acme/My App (iOS)")).toBe("my-app-ios-reviewer");
  });

  it("falls back rather than producing a nameless agent", () => {
    expect(agentName("")).toBe("repo-reviewer");
  });
});

describe("drafting a reviewer from the rules a repository already has", () => {
  const files = renderReviewer("acme/widget", "docs/rules", rules);

  it("writes one for each agent the team might use", () => {
    expect(files.map((f) => f.path)).toEqual([
      ".claude/agents/widget-reviewer.md",
      ".claude/commands/review.md",
      ".github/prompts/review.prompt.md",
    ]);
  });

  it("puts the rules in, because the rules are the reviewer", () => {
    for (const file of files) {
      expect(file.contents).toContain("layering");
      expect(file.contents).toContain("Does the change keep its layer?");
      expect(file.contents).toContain("measured across 40 pull requests");
    }
  });

  // A repository whose Claude reviewer and Copilot reviewer disagree has two rulesets
  // pretending to be one, and nobody finds out until two people get different answers
  // about the same line.
  it("says the same thing to every agent", () => {
    const bodies = files.map((file) => file.contents.split("---\n").pop());

    expect(new Set(bodies.map((b) => b?.includes("Every finding cites the id"))).size).toBe(1);
  });

  it("gives the subagent the frontmatter its host reads", () => {
    const subagent = files[0]?.contents ?? "";

    expect(subagent).toMatch(/^---\nname: widget-reviewer\n/);
    expect(subagent).toContain("tools: Read, Grep, Glob, Bash");
  });

  // The reviewer must not be able to change what it is reviewing.
  it("says read-only, in every flavour", () => {
    for (const file of files) {
      expect(file.contents).toContain("read-only");
      expect(file.contents).toMatch(/never edit, create or delete a file/i);
    }
  });

  // The citation requirement is the whole noise control, and it has to survive into the
  // generated file or the draft is worse than nothing.
  it("requires a rule id on every finding", () => {
    for (const file of files) {
      expect(file.contents).toMatch(/cites the id of the rule/);
      expect(file.contents).toMatch(/Finding nothing is a valid review/);
    }
  });

  it("names where the rules live, so a reader can go and read them", () => {
    expect(files[0]?.contents).toContain("docs/rules");
  });

  // Drafting against an empty ruleset must say so rather than producing a confident
  // reviewer with nothing behind it.
  it("says so when there are no rules to review against", () => {
    const empty = renderReviewer("acme/widget", "docs/rules", []);

    expect(empty[0]?.contents).toContain("ruleset is empty");
  });
});
