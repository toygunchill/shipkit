import { describe, expect, it } from "vitest";
import { assembleBrief } from "../../src/brief/assemble.js";
import { loadConfig } from "../../src/config/load.js";
import { citeTarget, STORY_LEVEL } from "../../src/jira/level.js";
import type { IssueFacts } from "../../src/jira/types.js";
import { validate } from "../../src/validate/rules.js";

const config = loadConfig("tests/fixtures/valid.shipkit.yml"); // linkPolicy: story
const TITLE = "[ABC-31087] fix(invoice): default citizenship from passenger info";
const goodBody = [
  "## Summary",
  "",
  "Add Invoice always defaulted citizenship to Turkish.",
  "",
  "## Screenshots / Screen Recordings",
  "",
  "| Before | After |",
  "",
  "## What to Test",
  "",
  "- one",
  "- two",
  "- three",
  "",
  "## Issues Addressed",
  "",
  "- [ABC-1](https://jira.example.com/browse/ABC-1)",
].join("\n");

describe("STORY_LEVEL", () => {
  it("is exactly Story and Bug", () => {
    expect([...STORY_LEVEL].sort()).toEqual(["Bug", "Story"]);
  });
});

describe("citeTarget", () => {
  it("returns the issue itself when it is already story-level", () => {
    expect(citeTarget({ key: "ABC-1", type: "Story", summary: "" }, "story")).toBe("ABC-1");
  });

  it("returns the parent when the issue is not story-level but its parent is", () => {
    const issue = {
      key: "ABC-2", type: "Development", summary: "",
      parent: { key: "ABC-1", type: "Story", summary: "" },
    };
    expect(citeTarget(issue, "story")).toBe("ABC-1");
  });

  it("falls back to the issue itself for a three-deep chain (parent not story-level either)", () => {
    // The data model (IssueFacts) only carries one hop of parent, so a chain
    // Development -> Task -> Story cannot be resolved past the Task. Recommending the
    // Task (also non-story) would be wrong advice that validate would then reject —
    // exactly the "cite X, then fail on X" contradiction this module exists to prevent.
    const issue = {
      key: "ABC-3", type: "Development", summary: "",
      parent: { key: "ABC-2", type: "Task", summary: "" },
    };
    expect(citeTarget(issue, "story")).toBe("ABC-3");
  });

  it("returns the issue itself under an 'any' link policy regardless of type", () => {
    const issue = { key: "ABC-4", type: "Development", summary: "" };
    expect(citeTarget(issue, "any")).toBe("ABC-4");
  });
});

describe("assembleBrief and validate agree on what to cite (cross-module)", () => {
  const repo = {
    branch: "bugfix/squad/1-ok",
    changedFiles: ["a.ts"],
    diffstat: " 1 file changed",
    commits: ["fix: x"],
  };
  const target = { branch: "main", reason: "test" };

  function bodyCiting(key: string): string {
    return goodBody.replace(
      "- [ABC-1](https://jira.example.com/browse/ABC-1)",
      `- [${key}](https://jira.example.com/browse/${key})`,
    );
  }

  // In the real CLI (post the IMPORTANT-4 fix), `issues` is built by fetching facts for
  // whatever key is actually cited in the body — not by reusing whatever facts happened to
  // be resolved for the branch's own key. This simulates that: if the agent followed
  // `ticket.cite`, the facts fed to validate are facts *for that cited key*.
  function factsForCitedKey(issue: IssueFacts, cite: string): IssueFacts {
    return cite === issue.key ? issue : { ...issue.parent! };
  }

  const subtask = {
    key: "ABC-31454", type: "Development", summary: "s",
    parent: { key: "ABC-31444", type: "Story", summary: "s" },
  };
  const deepChain = {
    key: "ABC-31454", type: "Development", summary: "s",
    parent: { key: "ABC-31444", type: "Task", summary: "s" },
  };
  const story = { key: "ABC-31444", type: "Story", summary: "s" };

  it("never fires issue-level against the key assembleBrief told the agent to cite (subtask -> story parent)", () => {
    const brief = assembleBrief({ repo, target, config, issue: subtask });
    expect(brief.ticket?.cite).toBe("ABC-31444");

    const result = validate({
      title: TITLE,
      body: bodyCiting(brief.ticket!.cite),
      config,
      issues: [factsForCitedKey(subtask, brief.ticket!.cite)],
    });
    expect(result.findings.map((f) => f.rule)).not.toContain("issue-level");
  });

  it("never fires issue-level against the key assembleBrief told the agent to cite (three-deep chain)", () => {
    const brief = assembleBrief({ repo, target, config, issue: deepChain });
    expect(brief.ticket?.cite).toBe("ABC-31454");

    const result = validate({
      title: TITLE,
      body: bodyCiting(brief.ticket!.cite),
      config,
      issues: [factsForCitedKey(deepChain, brief.ticket!.cite)],
    });
    expect(result.findings.map((f) => f.rule)).not.toContain("issue-level");
  });

  it("still fires issue-level for a Development issue cited directly (Story parent available but not cited)", () => {
    // Sanity check: the shared helper does not simply always pass — it still rejects
    // citing the wrong level when the *cited* key really is the non-compliant one.
    const issue = {
      key: "ABC-31454", type: "Development", summary: "s",
      parent: { key: "ABC-31444", type: "Story", summary: "s" },
    };
    const result = validate({
      title: TITLE,
      body: bodyCiting(issue.key),
      config,
      issues: [issue],
    });
    expect(result.findings.map((f) => f.rule)).toContain("issue-level");
  });
});
