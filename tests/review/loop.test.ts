import { describe, expect, it } from "vitest";
import { assembleBrief } from "../../src/brief/assemble.js";
import { loadConfig } from "../../src/config/load.js";
import type { IssueFacts } from "../../src/jira/types.js";
import type { FixRequest } from "../../src/review/fixrequest.js";
import { renderBody, type SubmitResponse } from "../../src/submit/response.js";
import { runSubmit, type SubmitDeps, type SubmitOptions } from "../../src/submit/run.js";
import type { PullRequestState, RepoState } from "../../src/vcs/types.js";

const CONFIG = loadConfig("tests/fixtures/valid.shipkit.yml");
const BRANCH = "bugfix/squad/31087-invoice";

const REPO: RepoState = { branch: BRANCH, changedFiles: [], diffstat: "", commits: [] };

const SELECTION: FixRequest = {
  version: 1,
  createdAt: "2026-09-17T10:00:00.000Z",
  base: "develop",
  branch: BRANCH,
  items: [
    { kind: "warning", id: "untracked-files", message: "Staging sweeps .env.local", note: "delete it" },
    { kind: "advice", id: "uikit-to-swiftui", message: "Looks like a conversion", note: "open the tech task" },
  ],
};

describe("brief carries the selection first", () => {
  it("puts fixRequest before everything else in the JSON, not merely in the object", () => {
    const brief = assembleBrief({
      repo: REPO,
      target: { branch: "develop", reason: "given with --base" },
      config: CONFIG,
      fixRequest: SELECTION,
    });

    const keys = Object.keys(JSON.parse(JSON.stringify(brief)));
    expect(keys[0]).toBe("fixRequest");
    expect(JSON.stringify(brief, null, 2).indexOf('"fixRequest"')).toBeLessThan(
      JSON.stringify(brief, null, 2).indexOf('"change"'),
    );
  });

  it("carries each item's id, message and note", () => {
    const brief = assembleBrief({
      repo: REPO,
      target: { branch: "develop", reason: "given with --base" },
      config: CONFIG,
      fixRequest: SELECTION,
    });

    expect(brief.fixRequest?.items).toEqual(SELECTION.items);
    expect(brief.fixRequest?.createdAt).toBe("2026-09-17T10:00:00.000Z");
  });

  // The framing is the whole point of the feature: everything else in a brief is shipkit's
  // opinion, and an agent that cannot tell this apart will weigh it like one.
  it("says in the brief's own words that a person chose these", () => {
    const brief = assembleBrief({
      repo: REPO,
      target: { branch: "develop", reason: "given with --base" },
      config: CONFIG,
      fixRequest: SELECTION,
    });

    expect(brief.fixRequest?.instruction).toContain("A person");
    expect(brief.fixRequest?.instruction).toContain("shipkit review");
    expect(brief.fixRequest?.instruction).toContain("not shipkit's");
  });

  it("carries no fixRequest key at all when nobody has reviewed anything", () => {
    const brief = assembleBrief({
      repo: REPO,
      target: { branch: "develop", reason: "given with --base" },
      config: CONFIG,
    });

    expect("fixRequest" in brief).toBe(false);
  });

  it("carries no fixRequest key for a selection that names nothing", () => {
    const brief = assembleBrief({
      repo: REPO,
      target: { branch: "develop", reason: "given with --base" },
      config: CONFIG,
      fixRequest: { ...SELECTION, items: [] },
    });

    expect("fixRequest" in brief).toBe(false);
  });
});

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

const OPTIONS: SubmitOptions = {
  base: "develop",
  config: "tests/fixtures/valid.shipkit.yml",
  response: VALID_RESPONSE,
  responsePath: "/repo/scratch/response.json",
  mode: "apply",
  acknowledge: "all",
};

type Call = { fn: string; args: unknown[] };

function makeDeps(overrides: Partial<SubmitDeps> = {}): {
  deps: SubmitDeps;
  calls: Call[];
  err: string[];
  archived: number;
} {
  const calls: Call[] = [];
  const err: string[] = [];
  const counter = { archived: 0 };

  function record<A extends unknown[], R>(fn: string, impl: (...args: A) => R): (...args: A) => R {
    return (...args: A) => {
      calls.push({ fn, args });
      return impl(...args);
    };
  }

  const defaults: SubmitDeps = {
    loadConfig: () => CONFIG,
    renderBody: (sections, config) => renderBody(sections, config),
    currentBranch: () => BRANCH,
    resolveIssue: (key: string) => Promise.resolve({ key, type: "Story", summary: "" } as IssueFacts),
    readRepoState: () => REPO,
    readPushDiffstat: () => " a.ts | 2 +-",
    readPushChangedFiles: () => [],
    readPushAddedLines: () => [],
    findPullRequest: () => null as PullRequestState | null,
    readUntrackedFiles: () => [],
    fixRequestExclusions: () => [".shipkit/fix-request.json"],
    archiveFixRequest: () => {
      counter.archived += 1;
      return { kind: "moved" as const, path: "/repo/.shipkit/fix-request-2026-09-17T10-00-00-000Z.json" };
    },
    readRepoRoot: () => "/repo",
    realpath: (path: string) => path,
    readHeadSha: () => "a".repeat(40),
    requestApproval: async () => ({ outcome: "no-surface" as const }),
    commitAll: () => undefined,
    pushBranch: () => undefined,
    createPullRequest: () => "https://github.com/x/y/pull/1",
    out: () => undefined,
    err: (line) => err.push(line),
  };

  const merged: SubmitDeps = { ...defaults, ...overrides };
  const deps: SubmitDeps = {
    ...merged,
    readPushDiffstat: record("readPushDiffstat", merged.readPushDiffstat),
    readPushChangedFiles: record("readPushChangedFiles", merged.readPushChangedFiles),
    readPushAddedLines: record("readPushAddedLines", merged.readPushAddedLines),
    commitAll: record("commitAll", merged.commitAll),
    pushBranch: record("pushBranch", merged.pushBranch),
    ...(merged.readPushChangedPaths === undefined
      ? {}
      : { readPushChangedPaths: record("readPushChangedPaths", merged.readPushChangedPaths) }),
    ...(merged.archiveFixRequest === undefined
      ? {}
      : { archiveFixRequest: record("archiveFixRequest", merged.archiveFixRequest) }),
  };

  // A getter, not a snapshot: the count is read after the run that increments it.
  return {
    deps,
    calls,
    err,
    get archived(): number {
      return counter.archived;
    },
  };
}

describe("submit keeps the selection out of the change", () => {
  const EXPECTED = ["scratch/response.json", ".shipkit/fix-request.json"];

  it("passes it to every read the push is measured from, and to the commit", async () => {
    const { deps, calls } = makeDeps({
      readPushChangedPaths: () => [],
      loadReadiness: () => [{ id: "a", ask: "?", severity: "warn" }],
    });

    const result = await runSubmit(
      { ...OPTIONS, response: { ...VALID_RESPONSE, readiness: [{ id: "a", status: "pass" }] } },
      deps,
    );

    expect(result.code).toBe(0);
    for (const fn of ["readPushChangedFiles", "readPushAddedLines", "readPushChangedPaths"]) {
      const call = calls.find((c) => c.fn === fn);
      expect(call, `${fn} was never called`).toBeDefined();
      expect(call?.args[1], `${fn} got the wrong exclusion`).toEqual(EXPECTED);
    }
    expect(calls.find((c) => c.fn === "commitAll")?.args[1]).toEqual(EXPECTED);
  });

  // `readPushDiffstat` is only read when somebody is going to be asked, so it needs a
  // policy that asks. It is the one read whose answer a person sees and the fingerprint
  // binds, which makes a wrong exclusion here a stat that contradicts the commit.
  it("passes it to the diffstat a person is shown before approving", async () => {
    const { deps, calls } = makeDeps({
      loadConfig: () => loadConfig("tests/fixtures/human-approval.shipkit.yml"),
      // A warning, because nobody is asked about a change that has nothing to warn about.
      readUntrackedFiles: () => [".env.local"],
      requestApproval: async () => ({ outcome: "approved" as const }),
    });

    const result = await runSubmit({ ...OPTIONS, acknowledge: [] }, deps);

    expect(result.code).toBe(0);
    const stats = calls.filter((c) => c.fn === "readPushDiffstat");
    expect(stats.length).toBeGreaterThan(0);
    for (const call of stats) expect(call.args[1]).toEqual(EXPECTED);
  });

  it("does not warn about a selection staging will not carry", async () => {
    const { deps, err } = makeDeps({
      readUntrackedFiles: () => [".shipkit/fix-request.json"],
    });

    const result = await runSubmit({ ...OPTIONS, acknowledge: [] }, deps);

    expect(result.code).toBe(0);
    expect(err.join("\n")).not.toContain("untracked-files");
  });

  it("still warns about the other untracked files beside it", async () => {
    const { deps, err } = makeDeps({
      readUntrackedFiles: () => [".shipkit/fix-request.json", ".env.local"],
    });

    const result = await runSubmit({ ...OPTIONS, acknowledge: [] }, deps);

    expect(result.code).toBe(2);
    expect(err.join("\n")).toContain(".env.local");
    expect(err.join("\n")).not.toContain("fix-request");
  });
});

describe("submit and a consumed selection", () => {
  it("archives it once the push has landed, and says where it went", async () => {
    const harness = makeDeps();

    const result = await runSubmit(OPTIONS, harness.deps);

    expect(result.code).toBe(0);
    expect(harness.archived).toBe(1);
    expect(harness.err.join("\n")).toContain("fix-request-2026-09-17T10-00-00-000Z.json");
  });

  it("archives it after the push even when opening the pull request then fails", async () => {
    const harness = makeDeps({
      createPullRequest: () => {
        throw new (class extends Error {})("gh exploded");
      },
    });

    await expect(runSubmit(OPTIONS, harness.deps)).rejects.toThrow("gh exploded");
    expect(harness.archived).toBe(1);
  });

  // The whole point: a submit that refuses has not done the work a person asked for, so the
  // selection has to survive to reach the next brief.
  it("leaves it in place when the submit refuses on a warning", async () => {
    const harness = makeDeps({ readUntrackedFiles: () => [".env.local"] });

    const result = await runSubmit({ ...OPTIONS, acknowledge: [] }, harness.deps);

    expect(result.code).toBe(2);
    expect(harness.archived).toBe(0);
  });

  it("leaves it in place when the submit refuses on a finding", async () => {
    const harness = makeDeps();

    const result = await runSubmit(
      { ...OPTIONS, response: { ...VALID_RESPONSE, title: "no ticket here" } },
      harness.deps,
    );

    expect(result.code).toBe(1);
    expect(harness.archived).toBe(0);
  });

  it("leaves it in place when the push itself fails", async () => {
    const harness = makeDeps({
      pushBranch: () => {
        throw new (class extends Error {})("rejected");
      },
    });

    await expect(runSubmit(OPTIONS, harness.deps)).rejects.toThrow("rejected");
    expect(harness.archived).toBe(0);
  });

  it("asks for nothing at all from a caller that supplies neither hook", async () => {
    const { deps, calls } = makeDeps({});
    const without: SubmitDeps = { ...deps };
    delete (without as Partial<SubmitDeps>).fixRequestExclusions;
    delete (without as Partial<SubmitDeps>).archiveFixRequest;

    const result = await runSubmit(OPTIONS, without);

    expect(result.code).toBe(0);
    expect(calls.find((c) => c.fn === "commitAll")?.args[1]).toEqual(["scratch/response.json"]);
  });
});
