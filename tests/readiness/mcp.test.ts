import { describe, expect, it } from "vitest";
import type { Brief } from "../../src/brief/types.js";
import { loadConfig } from "../../src/config/load.js";
import { applyContent, briefContent, previewContent } from "../../src/mcp/result.js";
import { handleBrief, handlePreview, readinessAnswers } from "../../src/mcp/tools.js";
import type { ToolDeps } from "../../src/mcp/tools.js";
import type { ReadinessRule } from "../../src/readiness/types.js";
import type { SubmitDeps, SubmitOptions, SubmitResult } from "../../src/submit/run.js";

const CONFIG = loadConfig("tests/fixtures/valid.shipkit.yml");

const SCOPED: ReadinessRule = {
  id: "design-tokens",
  ask: "Do the colours use the right semantic token?",
  appliesTo: ["**/*.swift"],
  severity: "warn",
};
const ALWAYS: ReadinessRule = {
  id: "all-entry-paths",
  ask: "Does the new check hold on every entry path?",
  severity: "warn",
};

const ARGS = {
  repo: "/repo",
  base: "develop",
  title: "[ABC-1] fix(x): y",
  commitMessage: "fix(x): y",
  sections: { Summary: "s" },
};

function makeDeps(over: Partial<ToolDeps> = {}) {
  const seen: SubmitOptions[] = [];
  const submitFor: { repo?: string; configPath?: string } = {};
  const deps: ToolDeps = {
    submitDeps: (repo: string, configPath: string) => {
      submitFor.repo = repo;
      submitFor.configPath = configPath;
      return {} as SubmitDeps;
    },
    loadConfig: () => CONFIG,
    readRepoState: () => ({ branch: "bugfix/x/1-y", changedFiles: [], diffstat: "", commits: [] }),
    readPushChangedFiles: () => [],
    readPushChangedPaths: () => ["Sources/View.swift"],
    loadReadiness: () => [SCOPED, ALWAYS],
    runSubmit: async (options: SubmitOptions) => {
      seen.push(options);
      return {
        code: 0, findings: [], warnings: [], body: "## Summary\n\ns\n",
        url: "https://example.com/pr/1", updated: false, committed: true, pushed: true,
      } satisfies SubmitResult;
    },
    ...over,
  };
  return { deps, seen, submitFor };
}

describe("shipkit_brief", () => {
  it("carries the applicable rules in its structured content", async () => {
    const { deps } = makeDeps();

    const shaped = await handleBrief({ repo: "/repo", base: "develop" }, deps);

    expect(shaped.isError).toBe(false);
    expect((shaped.structuredContent as unknown as Brief).readiness).toEqual([
      { id: "design-tokens", ask: "Do the colours use the right semantic token?", severity: "warn" },
      { id: "all-entry-paths", ask: "Does the new check hold on every entry path?", severity: "warn" },
    ]);
  });

  it("names them in the prose too, so an agent reading only the text still answers", async () => {
    const { deps } = makeDeps();
    const shaped = await handleBrief({ repo: "/repo", base: "develop" }, deps);
    expect(shaped.content[0]?.text).toContain("design-tokens, all-entry-paths");
  });

  it("filters by the changed paths of the repository the caller named", async () => {
    const { deps } = makeDeps({ readPushChangedPaths: () => ["docs/README.md"] });
    const shaped = await handleBrief({ repo: "/repo", base: "develop" }, deps);
    expect((shaped.structuredContent as unknown as Brief).readiness?.map((r) => r.id)).toEqual([
      "all-entry-paths",
    ]);
  });

  it("carries every rule when the changed-paths read fails, and is not an error", async () => {
    const { deps } = makeDeps({
      readPushChangedPaths: () => {
        throw new Error("git add --all failed: clean filter 'lfs' failed");
      },
    });

    const shaped = await handleBrief({ repo: "/repo", base: "develop" }, deps);

    expect(shaped.isError).toBe(false);
    expect((shaped.structuredContent as unknown as Brief).readiness).toHaveLength(2);
  });

  it("reports a broken rules file as an error rather than an empty checklist", async () => {
    const { deps } = makeDeps({
      loadReadiness: () => {
        throw new Error("Invalid readiness rules at /x/r.yml: rules.0.severity: Required");
      },
    });

    const shaped = await handleBrief({ repo: "/repo", base: "develop" }, deps);

    expect(shaped.isError).toBe(true);
    expect(shaped.content[0]?.text).toContain("Invalid readiness rules");
  });

  it("carries no readiness key when the repository configures none", async () => {
    const { deps } = makeDeps({ loadReadiness: () => undefined });
    const shaped = await handleBrief({ repo: "/repo", base: "develop" }, deps);
    expect(shaped.structuredContent).not.toHaveProperty("readiness");
  });
});

describe("readinessAnswers", () => {
  it("passes well-formed answers through", () => {
    expect(
      readinessAnswers([
        { id: "a", status: "pass" },
        { id: "b", status: "n/a", note: "not this change" },
      ]),
    ).toEqual([
      { id: "a", status: "pass" },
      { id: "b", status: "n/a", note: "not this change" },
    ]);
  });

  it("stays undefined when the caller sent nothing", () => {
    expect(readinessAnswers(undefined)).toBeUndefined();
    expect(readinessAnswers("all good")).toBeUndefined();
  });

  it("drops a malformed entry rather than repairing it, so the rule reads as unanswered", () => {
    // Fail closed: a repaired entry would satisfy a rule nobody actually answered, and
    // `evaluate` refuses an unanswered rule.
    expect(
      readinessAnswers([
        { id: "a", status: "maybe" },
        { id: 7, status: "pass" },
        null,
        "a",
        { id: "b", status: "pass", note: 9 },
      ]),
    ).toEqual([{ id: "b", status: "pass" }]);
  });
});

describe("shipkit_preview and shipkit_apply", () => {
  it("hands the answers to runSubmit as part of the response", async () => {
    const { deps, seen } = makeDeps();

    await handlePreview(
      { ...ARGS, readiness: [{ id: "design-tokens", status: "pass" }] },
      deps,
    );

    expect(seen[0]?.response.readiness).toEqual([{ id: "design-tokens", status: "pass" }]);
  });

  it("carries no readiness key when the caller sent none", async () => {
    const { deps, seen } = makeDeps();
    await handlePreview(ARGS, deps);
    expect(seen[0]?.response).not.toHaveProperty("readiness");
  });

  it("tells the submit dependencies which config path to resolve rules against", async () => {
    // A long-lived server serves several repositories, and each may name its own rules
    // file; without the path the closure would resolve against whichever config the
    // process happened to start with.
    const { deps, submitFor } = makeDeps();

    await handlePreview({ ...ARGS, config: "team/.shipkit.yml" }, deps);

    expect(submitFor).toEqual({ repo: "/repo", configPath: "/repo/team/.shipkit.yml" });
  });
});

describe("the tool content for readiness verdicts", () => {
  const base: SubmitResult = { code: 0, findings: [], warnings: [], committed: false, pushed: false };

  it("shows a readiness finding the way it shows any other", () => {
    const shaped = previewContent({
      ...base,
      code: 1,
      findings: [{ rule: "readiness-unanswered", message: "No readiness answer for: concurrency." }],
    });
    expect(shaped.isError).toBe(true);
    expect(shaped.content[0]?.text).toContain("readiness-unanswered: No readiness answer for");
    expect(shaped.structuredContent.findings).toEqual([
      "readiness-unanswered: No readiness answer for: concurrency.",
    ]);
  });

  it("shows a readiness warning with its id, so it can be acknowledged", () => {
    const warning = { check: "readiness-concurrency", message: "Is shared state consistent? — no" };
    const shaped = previewContent({ ...base, warnings: [warning] });
    expect(shaped.content[0]?.text).toContain("readiness-concurrency");
    expect(shaped.structuredContent.warnings).toEqual([warning]);
  });

  it("keeps a readiness advisory out of the warnings an agent would acknowledge", () => {
    const shaped = applyContent({
      ...base,
      code: 0,
      url: "https://example.com/pr/1",
      advice: [{ topic: "readiness-constants-deliberate", message: "Are the magic values deliberate? — no" }],
    });
    expect(shaped.structuredContent.warnings).toEqual([]);
    expect(shaped.structuredContent.advice).toEqual([
      { topic: "readiness-constants-deliberate", message: "Are the magic values deliberate? — no" },
    ]);
    expect(shaped.content[0]?.text).toContain("Are the magic values deliberate?");
  });

  it("says nothing about readiness in a brief that has none", () => {
    const brief = {
      change: { branch: "b", files: [], diffstat: "", commits: [] },
      target: { branch: "develop", reason: "given by the caller" },
      template: { sections: [{ name: "Summary", required: true }] },
      rules: {
        titlePattern: "x", branchPattern: "y", keyPattern: "z",
        forbidden: [], issuesSection: "Issues Addressed", linkPolicy: "story" as const,
      },
    } satisfies Brief;
    expect(briefContent(brief).content[0]?.text).not.toContain("Readiness");
  });
});
