import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import type { ShipkitConfig } from "../../src/config/schema.js";
import type { IssueFacts } from "../../src/jira/types.js";
import { renderBody, ResponseError, type SubmitResponse } from "../../src/submit/response.js";
import { runSubmit, type SubmitDeps, type SubmitOptions } from "../../src/submit/run.js";
import { VcsError } from "../../src/vcs/git.js";
import type { PullRequestState } from "../../src/vcs/types.js";

// Loaded once from the real fixture — runSubmit never reads a file itself, this is only the
// object the fake `loadConfig` hands back.
const CONFIG = loadConfig("tests/fixtures/valid.shipkit.yml");

// A branch that satisfies config.branch.pattern and contains no Jira key, so the happy path
// below needs neither a ticket nor a Jira token to stay clean.
const BRANCH = "bugfix/squadb/31087-invoice";

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
  input: "irrelevant.json",
  base: "develop",
  config: "irrelevant.yml",
  yes: false,
};

const NO_PR: PullRequestState | null = null;

type Call = { fn: string; args: unknown[] };

/**
 * Every fake records into a shared call log, in the order runSubmit invokes them, so ordering
 * (test 8) and "was this ever touched" (tests 1, 4, 5) can both be asserted from one place.
 * `poison` makes the ten domain dependencies throw instead of running a default — used to prove
 * a dependency was truly never called rather than merely never asserted on.
 */
function makeDeps(
  overrides: Partial<SubmitDeps> = {},
  options: { poison?: boolean } = {},
): { deps: SubmitDeps; calls: Call[]; out: string[]; err: string[] } {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];

  // Overrides are raw implementations, not pre-wrapped fakes. They get wrapped in `record`
  // below alongside the defaults, so overriding e.g. pushBranch still lands it in `calls` at
  // the right position instead of silently escaping the call log.
  function record<A extends unknown[], R>(fn: string, impl: (...args: A) => R): (...args: A) => R {
    return (...args: A) => {
      calls.push({ fn, args });
      return impl(...args);
    };
  }

  function poisoned(fn: string): () => never {
    return () => {
      throw new Error(`unexpected call: ${fn}`);
    };
  }

  const defaults: SubmitDeps = options.poison
    ? {
        loadConfig: poisoned("loadConfig"),
        loadResponse: poisoned("loadResponse"),
        renderBody: poisoned("renderBody"),
        currentBranch: poisoned("currentBranch"),
        resolveIssue: poisoned("resolveIssue"),
        readRepoState: poisoned("readRepoState"),
        findPullRequest: poisoned("findPullRequest"),
        commitAll: poisoned("commitAll"),
        pushBranch: poisoned("pushBranch"),
        createPullRequest: poisoned("createPullRequest"),
        out: (line) => out.push(line),
        err: (line) => err.push(line),
      }
    : {
        loadConfig: () => CONFIG,
        loadResponse: () => VALID_RESPONSE,
        renderBody: (sections: Record<string, string>, config: ShipkitConfig) => renderBody(sections, config),
        currentBranch: () => BRANCH,
        resolveIssue: () => Promise.resolve(undefined as IssueFacts | undefined),
        readRepoState: () => ({ branch: BRANCH, changedFiles: [], diffstat: "", commits: [] }),
        findPullRequest: () => NO_PR,
        commitAll: () => undefined,
        pushBranch: () => undefined,
        createPullRequest: () => "https://github.com/x/y/pull/1",
        out: (line) => out.push(line),
        err: (line) => err.push(line),
      };

  const merged: SubmitDeps = { ...defaults, ...overrides };

  const deps: SubmitDeps = {
    loadConfig: record("loadConfig", merged.loadConfig),
    loadResponse: record("loadResponse", merged.loadResponse),
    renderBody: record("renderBody", merged.renderBody),
    currentBranch: record("currentBranch", merged.currentBranch),
    resolveIssue: record("resolveIssue", merged.resolveIssue),
    readRepoState: record("readRepoState", merged.readRepoState),
    findPullRequest: record("findPullRequest", merged.findPullRequest),
    commitAll: record("commitAll", merged.commitAll),
    pushBranch: record("pushBranch", merged.pushBranch),
    createPullRequest: record("createPullRequest", merged.createPullRequest),
    out: merged.out,
    err: merged.err,
  };

  return { deps, calls, out, err };
}

const DOMAIN_DEPS = [
  "loadConfig",
  "loadResponse",
  "renderBody",
  "currentBranch",
  "resolveIssue",
  "readRepoState",
  "findPullRequest",
  "commitAll",
  "pushBranch",
  "createPullRequest",
];

describe("runSubmit", () => {
  it("returns 2 and calls no dependency for an option-shaped --base", async () => {
    const { deps, calls, err } = makeDeps({}, { poison: true });

    const code = await runSubmit({ ...OPTIONS, base: "--output=/tmp/x" }, deps);

    expect(code).toBe(2);
    expect(calls.filter((c) => DOMAIN_DEPS.includes(c.fn))).toEqual([]);
    expect(err.join("\n")).toContain("--output=/tmp/x");
  });

  it("returns 2 and mutates nothing when loadResponse throws ResponseError", async () => {
    const { deps, calls } = makeDeps({
      loadResponse: () => {
        throw new ResponseError("Cannot read response at nope.json");
      },
    });

    const code = await runSubmit(OPTIONS, deps);

    expect(code).toBe(2);
    expect(calls.some((c) => ["commitAll", "pushBranch", "createPullRequest"].includes(c.fn))).toBe(false);
  });

  it("returns 2 and reports the message when renderBody throws ResponseError on a level-two heading", async () => {
    // The real renderBody (task 3), not a stub — this is the exact case it exists to refuse:
    // a section whose content smuggles a "##" heading.
    const { deps, calls, err } = makeDeps({
      loadResponse: () => ({
        ...VALID_RESPONSE,
        sections: { ...VALID_RESPONSE.sections, Summary: "Some text\n\n## Nested\n\nMore text" },
      }),
    });

    const code = await runSubmit(OPTIONS, deps);

    expect(code).toBe(2);
    expect(err.join("\n")).toContain("level-two headings");
    expect(calls.some((c) => ["commitAll", "pushBranch", "createPullRequest"].includes(c.fn))).toBe(false);
  });

  it("returns 1, names the failing rule, and never touches commit/push/create when validation fails", async () => {
    const { deps, calls, err } = makeDeps({
      loadResponse: () => ({ ...VALID_RESPONSE, title: "nope" }),
    });

    const code = await runSubmit(OPTIONS, deps);

    expect(code).toBe(1);
    expect(err.join("\n")).toContain("title-pattern");
    expect(calls.some((c) => c.fn === "commitAll")).toBe(false);
    expect(calls.some((c) => c.fn === "pushBranch")).toBe(false);
    expect(calls.some((c) => c.fn === "createPullRequest")).toBe(false);
  });

  it("returns 2, reports warnings, and mutates nothing when preflight warns without --yes", async () => {
    const pr: PullRequestState = { number: 1, baseRefName: "develop", labels: [], approvals: ["alice", "bob"] };
    const { deps, calls, err } = makeDeps({ findPullRequest: () => pr });

    const code = await runSubmit({ ...OPTIONS, yes: false }, deps);

    expect(code).toBe(2);
    expect(err.join("\n")).toContain("approvals-dismissed");
    expect(calls.some((c) => c.fn === "commitAll")).toBe(false);
    expect(calls.some((c) => c.fn === "pushBranch")).toBe(false);
    expect(calls.some((c) => c.fn === "createPullRequest")).toBe(false);
  });

  it("returns 0 and proceeds when preflight warns and --yes is given", async () => {
    const pr: PullRequestState = { number: 1, baseRefName: "develop", labels: [], approvals: ["alice"] };
    const { deps, calls, out, err } = makeDeps({ findPullRequest: () => pr });

    const code = await runSubmit({ ...OPTIONS, yes: true }, deps);

    expect(code).toBe(0);
    expect(err.join("\n")).toContain("approvals-dismissed");
    expect(calls.some((c) => c.fn === "commitAll")).toBe(true);
    expect(calls.some((c) => c.fn === "pushBranch")).toBe(true);
    expect(calls.some((c) => c.fn === "createPullRequest")).toBe(true);
    expect(out).toEqual(["https://github.com/x/y/pull/1"]);
  });

  it("returns 0, prints the URL, and needs no --yes on a clean run", async () => {
    const { deps, out } = makeDeps();

    const code = await runSubmit({ ...OPTIONS, yes: false }, deps);

    expect(code).toBe(0);
    expect(out).toEqual(["https://github.com/x/y/pull/1"]);
  });

  it("commits, pushes and creates the pull request in that exact order", async () => {
    const { deps, calls } = makeDeps();

    await runSubmit(OPTIONS, deps);

    const order = calls
      .filter((c) => ["commitAll", "pushBranch", "createPullRequest"].includes(c.fn))
      .map((c) => c.fn);
    expect(order).toEqual(["commitAll", "pushBranch", "createPullRequest"]);
  });

  it("returns 2 when pushBranch throws VcsError, after commitAll already ran", async () => {
    const { deps, calls } = makeDeps({
      pushBranch: () => {
        throw new VcsError("git push --set-upstream origin failed: rejected");
      },
    });

    const code = await runSubmit(OPTIONS, deps);

    expect(code).toBe(2);
    // By the time push fails, commitAll has already been invoked and createPullRequest has
    // not — see the report for what this means for the real adapters (a local commit with
    // nothing pushed and no pull request opened).
    const order = calls.filter((c) => ["commitAll", "pushBranch", "createPullRequest"].includes(c.fn)).map((c) => c.fn);
    expect(order).toEqual(["commitAll", "pushBranch"]);
  });
});
