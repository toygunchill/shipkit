import { describe, expect, it } from "vitest";
import { applyContent, briefContent, failureContent, previewContent } from "../../src/mcp/result.js";
import { loadConfig } from "../../src/config/load.js";
import { renderBody, type SubmitResponse } from "../../src/submit/response.js";
import { runSubmit, type SubmitDeps } from "../../src/submit/run.js";
import type { SubmitResult } from "../../src/submit/run.js";
import type { Brief } from "../../src/brief/types.js";

const CONFIG = loadConfig("tests/fixtures/valid.shipkit.yml");

// A branch that satisfies config.branch.pattern, matching tests/submit/run.test.ts's own
// fixture, so this response reaches pre-flight rather than failing validate() first.
const VALID_RESPONSE: SubmitResponse = {
  title: "[ABC-1] fix(x): y",
  commitMessage: "fix(x): y",
  sections: {
    Summary: "It was broken; now it is not.",
    "Screenshots / Screen Recordings": "Nothing to show — logic only.",
    "What to Test": "- one\n- two\n- three",
    "Issues Addressed": "- [ABC-1](https://jira.example.com/browse/ABC-1)",
  },
};

const BRIEF: Brief = {
  change: { branch: "bugfix/x/1-y", files: ["a.ts"], diffstat: "1 file", commits: ["fix: y"] },
  target: { branch: "develop", reason: "given" },
  template: { sections: [{ name: "Summary", required: true }] },
  rules: {
    titlePattern: "^x", branchPattern: "^y", keyPattern: "DCP-\\d+",
    forbidden: ["TBD"], issuesSection: "Issues Addressed", linkPolicy: "story",
  },
};

const OK: SubmitResult = {
  code: 0, findings: [], warnings: [], body: "## Summary\n\ns\n",
  url: "https://example.com/pr/1", updated: false, committed: true, pushed: true,
};

describe("briefContent", () => {
  it("carries the brief as structured data, not only as prose", () => {
    expect(briefContent(BRIEF).structuredContent).toEqual(BRIEF as unknown as Record<string, unknown>);
  });

  it("is not an error", () => {
    expect(briefContent(BRIEF).isError).toBe(false);
  });
});

describe("previewContent", () => {
  it("returns the body so the caller can see what would be posted", () => {
    const shaped = previewContent({ ...OK, url: undefined, committed: false, pushed: false });
    expect(shaped.structuredContent.body).toBe("## Summary\n\ns\n");
  });

  it("names every warning id, because those ids are what apply will ask for", () => {
    const shaped = previewContent({
      code: 0, findings: [],
      warnings: [
        { check: "untracked-files", message: "two files" },
        { check: "base-mismatch", message: "targets develop" },
      ],
      body: "b", committed: false, pushed: false,
    });
    expect(shaped.structuredContent.warnings).toEqual([
      { check: "untracked-files", message: "two files" },
      { check: "base-mismatch", message: "targets develop" },
    ]);
    expect(shaped.content[0].text).toContain("untracked-files");
    expect(shaped.content[0].text).toContain("base-mismatch");
  });

  // A preview reports; it never refuses. Only a wrong answer makes it an error.
  it("is not an error when there are warnings", () => {
    const shaped = previewContent({
      code: 0, findings: [], warnings: [{ check: "untracked-files", message: "m" }],
      body: "b", committed: false, pushed: false,
    });
    expect(shaped.isError).toBe(false);
  });

  it("is an error when the answer does not validate", () => {
    const shaped = previewContent({
      code: 1, findings: [{ rule: "title-pattern", message: "bad" }], warnings: [],
      body: "b", committed: false, pushed: false,
    });
    expect(shaped.isError).toBe(true);
    expect(shaped.content[0].text).toContain("title-pattern");
  });

  // runSubmit returns code 2 as data (not a throw) for an unreadable config and for every
  // other ConfigError/VcsError/ResponseError/JiraError it catches — none of which reach
  // handlePreview's try/catch. Without a code-2 branch this fell through to "Ready to apply.
  // No warnings.", telling an agent its draft was clean when shipkit never read the rules.
  it("is an error when the config could not be read, not a clean preview", () => {
    const shaped = previewContent({
      code: 2, findings: [], warnings: [],
      message: "Cannot read config at /repo/.shipkit.yml",
      committed: false, pushed: false,
    });
    expect(shaped.isError).toBe(true);
    expect(shaped.content[0].text).toContain("Cannot read config at /repo/.shipkit.yml");
    expect(shaped.content[0].text).not.toContain("Ready to apply");
  });

  it("is an error when the base is invalid, not a clean preview", () => {
    const shaped = previewContent({
      code: 2, findings: [], warnings: [],
      message: 'Refusing to use "-x" as a base branch',
      committed: false, pushed: false,
    });
    expect(shaped.isError).toBe(true);
    expect(shaped.content[0].text).toContain('Refusing to use "-x" as a base branch');
    expect(shaped.content[0].text).not.toContain("Ready to apply");
  });
});

describe("applyContent", () => {
  it("returns the url and whether the pull request already existed", () => {
    const shaped = applyContent(OK);
    expect(shaped.isError).toBe(false);
    expect(shaped.structuredContent.url).toBe("https://example.com/pr/1");
    expect(shaped.structuredContent.updated).toBe(false);
  });

  // The ids are the actionable part: they are exactly what has to come back in acknowledge.
  it("tells a refused caller which ids to acknowledge", () => {
    const shaped = applyContent({
      code: 2, findings: [],
      warnings: [{ check: "untracked-files", message: "m" }],
      body: "b", message: "Refusing to proceed",
      committed: false, pushed: false,
    });
    expect(shaped.isError).toBe(true);
    expect(shaped.structuredContent.warnings).toEqual([
      { check: "untracked-files", message: "m" },
    ]);
    expect(shaped.content[0].text).toContain(`Call again with acknowledge: ["untracked-files"] to proceed.`);
  });

  // Drives the real runSubmit (fake deps, no git/gh) rather than a hand-built SubmitResult,
  // so this test actually depends on what runSubmit's refusal message says. runSubmit serves
  // both the CLI (which has --yes) and MCP (which has no such flag, only acknowledge: [...]);
  // its message must stay neutral, and applyContent must supply MCP's own guidance without
  // ever surfacing a flag this interface does not have. Regressing the core's message back to
  // naming --yes (as run.ts briefly did) makes this fail — see the discrimination check in
  // the report.
  it("gives acknowledge guidance, never --yes, on a real refused result", async () => {
    const deps: SubmitDeps = {
      loadConfig: () => CONFIG,
      renderBody,
      currentBranch: () => "bugfix/squadb/31087-invoice",
      resolveIssue: async () => undefined,
      readRepoState: () => ({
        branch: "bugfix/squadb/31087-invoice", changedFiles: [], diffstat: "", commits: [],
      }),
      findPullRequest: () => null,
      readUntrackedFiles: () => [".env.local"],
      readRepoRoot: () => "/repo",
      realpath: (path) => path,
      readHeadSha: () => "a".repeat(40),
      requestApproval: async () => "no-surface" as const,
      commitAll: () => {
        throw new Error("must not commit on a refusal");
      },
      pushBranch: () => {
        throw new Error("must not push on a refusal");
      },
      createPullRequest: () => {
        throw new Error("must not open a pull request on a refusal");
      },
      out: () => undefined,
      err: () => undefined,
    };

    const result = await runSubmit(
      {
        base: "develop",
        config: "tests/fixtures/valid.shipkit.yml",
        response: VALID_RESPONSE,
        mode: "apply",
        acknowledge: [],
      },
      deps,
    );

    expect(result.code).toBe(2);
    const shaped = applyContent(result);
    expect(shaped.isError).toBe(true);
    expect(shaped.content[0].text).toContain("acknowledge:");
    expect(shaped.content[0].text).toContain("to proceed.");
    expect(shaped.content[0].text).not.toContain("--yes");
  });

  it("builds acknowledge guidance from all refused ids, not just the first", () => {
    const shaped = applyContent({
      code: 2, findings: [],
      warnings: [
        { check: "untracked-files", message: "m1" },
        { check: "base-mismatch", message: "m2" },
      ],
      body: "b", message: "Refusing to proceed",
      committed: false, pushed: false,
    });
    expect(shaped.isError).toBe(true);
    expect(shaped.structuredContent.warnings).toEqual([
      { check: "untracked-files", message: "m1" },
      { check: "base-mismatch", message: "m2" },
    ]);
    expect(shaped.content[0].text).toContain(`acknowledge: ["untracked-files", "base-mismatch"]`);
  });

  // Half-done is the state a caller most needs told, and the one it is least likely to guess.
  it("says what was left behind when the sequence failed part way", () => {
    const shaped = applyContent({
      code: 2, findings: [], warnings: [], body: "b",
      message: "git push failed: rejected", committed: true, pushed: false,
    });
    expect(shaped.isError).toBe(true);
    expect(shaped.structuredContent.committed).toBe(true);
    expect(shaped.structuredContent.pushed).toBe(false);
    expect(shaped.content[0].text).toContain("commit");
  });
});

describe("failureContent", () => {
  it("reports a message as content rather than as a thrown fault", () => {
    const shaped = failureContent("Cannot read .shipkit.yml");
    expect(shaped.isError).toBe(true);
    expect(shaped.content[0].text).toContain("Cannot read .shipkit.yml");
  });
});
