import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChangedFile } from "../../src/advice/uikit.js";
import { fingerprint } from "../../src/approval/fingerprint.js";
import type { ApprovalRequest } from "../../src/approval/protocol.js";
import { ConfigError, loadConfig } from "../../src/config/load.js";
import type { ShipkitConfig } from "../../src/config/schema.js";
import type { IssueFacts } from "../../src/jira/types.js";
import { renderBody, type SubmitResponse } from "../../src/submit/response.js";
import { runSubmit, type SubmitDeps, type SubmitOptions } from "../../src/submit/run.js";
import { VcsError } from "../../src/vcs/git.js";
import type { PullRequestState } from "../../src/vcs/types.js";

// Loaded once from the real fixture — runSubmit never reads a file itself, this is only the
// object the fake `loadConfig` hands back.
const CONFIG = loadConfig("tests/fixtures/valid.shipkit.yml");

// A branch that satisfies config.branch.pattern and contains no Jira key, so the happy path
// below needs neither a ticket nor a Jira token to stay clean.
const BRANCH = "bugfix/squad/31087-invoice";

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
        renderBody: poisoned("renderBody"),
        currentBranch: poisoned("currentBranch"),
        resolveIssue: poisoned("resolveIssue"),
        readRepoState: poisoned("readRepoState"),
        readPushDiffstat: poisoned("readPushDiffstat"),
        readPushChangedFiles: poisoned("readPushChangedFiles"),
        readPushAddedLines: poisoned("readPushAddedLines"),
        findPullRequest: poisoned("findPullRequest"),
        readUntrackedFiles: poisoned("readUntrackedFiles"),
        readRepoRoot: poisoned("readRepoRoot"),
        realpath: poisoned("realpath"),
        readHeadSha: poisoned("readHeadSha"),
        requestApproval: poisoned("requestApproval"),
        commitAll: poisoned("commitAll"),
        pushBranch: poisoned("pushBranch"),
        createPullRequest: poisoned("createPullRequest"),
        out: (line) => out.push(line),
        err: (line) => err.push(line),
      }
    : {
        loadConfig: () => CONFIG,
        renderBody: (sections: Record<string, string>, config: ShipkitConfig) => renderBody(sections, config),
        currentBranch: () => BRANCH,
        // VALID_RESPONSE's title and Issues Addressed section both cite ABC-1 — resolving it
        // as Story-level keeps issue-level and issue-unverified silent by default, the same
        // way a real run with a working SHIPKIT_JIRA_TOKEN would. Tests that care about the
        // unresolved/non-story cases override this explicitly.
        resolveIssue: (key: string) => Promise.resolve({ key, type: "Story", summary: "" } as IssueFacts),
        readRepoState: () => ({ branch: BRANCH, changedFiles: [], diffstat: "", commits: [] }),
        // What the push will deliver, which is what the panel shows and what the
        // fingerprint binds — deliberately not the empty string `readRepoState`
        // returns here, so a run that fell back to the committed-work diffstat
        // would be visible rather than indistinguishable.
        readPushDiffstat: () => " a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)",
        // No conversion by default, so `advice` is empty unless a test asks for one.
        readPushChangedFiles: () => [],
        readPushAddedLines: () => [],
        findPullRequest: () => NO_PR,
        readUntrackedFiles: () => [],
        readRepoRoot: () => "/repo",
        realpath: (path: string) => path,
        readHeadSha: () => "a".repeat(40),
        requestApproval: async () => ({ outcome: "no-surface" as const }) /* extra args ignored */,
        commitAll: () => undefined,
        pushBranch: () => undefined,
        createPullRequest: () => "https://github.com/x/y/pull/1",
        out: (line) => out.push(line),
        err: (line) => err.push(line),
      };

  const merged: SubmitDeps = { ...defaults, ...overrides };

  const deps: SubmitDeps = {
    loadConfig: record("loadConfig", merged.loadConfig),
    renderBody: record("renderBody", merged.renderBody),
    currentBranch: record("currentBranch", merged.currentBranch),
    resolveIssue: record("resolveIssue", merged.resolveIssue),
    readRepoState: record("readRepoState", merged.readRepoState),
    readPushDiffstat: record("readPushDiffstat", merged.readPushDiffstat),
    readPushChangedFiles: record("readPushChangedFiles", merged.readPushChangedFiles),
    readPushAddedLines: record("readPushAddedLines", merged.readPushAddedLines),
    findPullRequest: record("findPullRequest", merged.findPullRequest),
    readUntrackedFiles: record("readUntrackedFiles", merged.readUntrackedFiles),
    readRepoRoot: record("readRepoRoot", merged.readRepoRoot),
    realpath: record("realpath", merged.realpath),
    readHeadSha: record("readHeadSha", merged.readHeadSha),
    requestApproval: record("requestApproval", merged.requestApproval),
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
  "renderBody",
  "currentBranch",
  "resolveIssue",
  "readRepoState",
  "readPushDiffstat",
  "readPushChangedFiles",
  "readPushAddedLines",
  "findPullRequest",
  "readUntrackedFiles",
  "readRepoRoot",
  "realpath",
  "readHeadSha",
  "requestApproval",
  "commitAll",
  "pushBranch",
  "createPullRequest",
];

describe("runSubmit", () => {
  it("returns 2 and calls no dependency for an option-shaped --base", async () => {
    const { deps, calls, err } = makeDeps({}, { poison: true });

    const result = await runSubmit({ ...OPTIONS, base: "--output=/tmp/x" }, deps);

    expect(result.code).toBe(2);
    expect(calls.filter((c) => DOMAIN_DEPS.includes(c.fn))).toEqual([]);
    expect(err.join("\n")).toContain("--output=/tmp/x");
  });

  it("returns 2 and reports the message when renderBody throws ResponseError on a level-two heading", async () => {
    // The real renderBody (task 3), not a stub — this is the exact case it exists to refuse:
    // a section whose content smuggles a "##" heading.
    const { deps, calls, err } = makeDeps({});

    const result = await runSubmit(
      {
        ...OPTIONS,
        response: {
          ...VALID_RESPONSE,
          sections: { ...VALID_RESPONSE.sections, Summary: "Some text\n\n## Nested\n\nMore text" },
        },
      },
      deps,
    );

    expect(result.code).toBe(2);
    expect(err.join("\n")).toContain("level-two headings");
    expect(calls.some((c) => ["commitAll", "pushBranch", "createPullRequest"].includes(c.fn))).toBe(false);
  });

  it("returns 1, names the failing rule, and never touches commit/push/create when validation fails", async () => {
    const { deps, calls, err } = makeDeps({});

    const result = await runSubmit({ ...OPTIONS, response: { ...VALID_RESPONSE, title: "nope" } }, deps);

    expect(result.code).toBe(1);
    expect(err.join("\n")).toContain("title-pattern");
    expect(calls.some((c) => c.fn === "commitAll")).toBe(false);
    expect(calls.some((c) => c.fn === "pushBranch")).toBe(false);
    expect(calls.some((c) => c.fn === "createPullRequest")).toBe(false);
  });

  it("returns 2, reports warnings, and mutates nothing when preflight warns without --yes", async () => {
    const pr: PullRequestState = {
      number: 1,
      url: "https://github.com/x/y/pull/1",
      baseRefName: "develop",
      labels: [],
      approvals: ["alice", "bob"],
    };
    const { deps, calls, err } = makeDeps({ findPullRequest: () => pr });

    const result = await runSubmit({ ...OPTIONS, acknowledge: [] }, deps);

    expect(result.code).toBe(2);
    expect(err.join("\n")).toContain("approvals-dismissed");
    expect(calls.some((c) => c.fn === "commitAll")).toBe(false);
    expect(calls.some((c) => c.fn === "pushBranch")).toBe(false);
    expect(calls.some((c) => c.fn === "createPullRequest")).toBe(false);
  });

  it("returns 0, pushes, and stops without calling createPullRequest when preflight warns and --yes is given, because a pull request already exists", async () => {
    // Finding 2: `gh pr create` refuses outright when an open pull request already exists
    // for the head branch — exactly the state approvals-dismissed exists to warn about. The
    // push is the job in that case; createPullRequest must not be called at all.
    const pr: PullRequestState = {
      number: 1,
      url: "https://github.com/x/y/pull/1",
      baseRefName: "develop",
      labels: [],
      approvals: ["alice"],
    };
    const { deps, calls, out, err } = makeDeps({ findPullRequest: () => pr });

    const result = await runSubmit({ ...OPTIONS, acknowledge: "all" }, deps);

    expect(result.code).toBe(0);
    expect(err.join("\n")).toContain("approvals-dismissed");
    expect(calls.some((c) => c.fn === "commitAll")).toBe(true);
    expect(calls.some((c) => c.fn === "pushBranch")).toBe(true);
    expect(calls.some((c) => c.fn === "createPullRequest")).toBe(false);
    expect(out).toEqual([pr.url]);
    expect(err.join("\n")).toContain("updated, not opened");
  });

  it("pushes and stops without creating a pull request when one already exists for the branch, even with no warnings", async () => {
    // Same fix as above, but with nothing for preflight to warn about — the create-refusal
    // bug in the sequence being fixed here does not depend on --yes or on any warning having
    // fired; it depends only on whether a pull request already exists for the branch.
    const pr: PullRequestState = {
      number: 42,
      url: "https://github.com/x/y/pull/42",
      baseRefName: "develop",
      labels: [],
      approvals: [],
    };
    const { deps, calls, out, err } = makeDeps({ findPullRequest: () => pr });

    const result = await runSubmit({ ...OPTIONS, acknowledge: [] }, deps);

    expect(result.code).toBe(0);
    expect(calls.some((c) => c.fn === "commitAll")).toBe(true);
    expect(calls.some((c) => c.fn === "pushBranch")).toBe(true);
    expect(calls.some((c) => c.fn === "createPullRequest")).toBe(false);
    expect(out).toEqual([pr.url]);
    expect(err.join("\n")).toContain("updated, not opened");
  });

  it("returns 0, prints the URL, and needs no --yes on a clean run", async () => {
    const { deps, out } = makeDeps();

    const result = await runSubmit({ ...OPTIONS, acknowledge: [] }, deps);

    expect(result.code).toBe(0);
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
    const { deps, calls, err } = makeDeps({
      pushBranch: () => {
        throw new VcsError("git push --set-upstream origin failed: rejected");
      },
    });

    const result = await runSubmit(OPTIONS, deps);

    expect(result.code).toBe(2);
    // By the time push fails, commitAll has already been invoked and createPullRequest has
    // not — see the report for what this means for the real adapters (a local commit with
    // nothing pushed and no pull request opened).
    const order = calls.filter((c) => ["commitAll", "pushBranch", "createPullRequest"].includes(c.fn)).map((c) => c.fn);
    expect(order).toEqual(["commitAll", "pushBranch"]);
    // The underlying git message is still reported, plus a line saying a commit now exists
    // locally and was never pushed — otherwise a re-run's "nothing to commit" failure from
    // commitAll would be the reader's first clue that anything was left behind.
    expect(err.join("\n")).toContain("git push --set-upstream origin failed: rejected");
    expect(err.join("\n")).toContain("A commit was created locally and has not been pushed.");
    expect(err.join("\n")).not.toContain("already pushed");
  });

  it("returns 2 when createPullRequest throws VcsError, and says the commit was already pushed", async () => {
    const { deps, calls, err } = makeDeps({
      createPullRequest: () => {
        throw new VcsError("gh pr create failed: not authenticated");
      },
    });

    const result = await runSubmit(OPTIONS, deps);

    expect(result.code).toBe(2);
    const order = calls.filter((c) => ["commitAll", "pushBranch", "createPullRequest"].includes(c.fn)).map((c) => c.fn);
    expect(order).toEqual(["commitAll", "pushBranch", "createPullRequest"]);
    // By this point the commit has been pushed to the remote branch, so a claim of "has not
    // been pushed" would be false — the wording must reflect that no pull request exists yet
    // rather than reusing the pre-push sentence verbatim.
    expect(err.join("\n")).toContain("gh pr create failed: not authenticated");
    expect(err.join("\n")).toContain("A commit was created and already pushed to the remote branch");
    expect(err.join("\n")).not.toContain("has not been pushed");
  });

  it("does not claim a commit exists when a VcsError is raised before commitAll runs", async () => {
    const { deps, calls, err } = makeDeps({
      readRepoState: () => {
        throw new VcsError("git log --end-of-options develop..HEAD failed: unknown revision");
      },
    });

    const result = await runSubmit(OPTIONS, deps);

    expect(result.code).toBe(2);
    expect(calls.some((c) => c.fn === "commitAll")).toBe(false);
    expect(err.join("\n")).toContain("git log --end-of-options develop..HEAD failed: unknown revision");
    expect(err.join("\n")).not.toContain("commit was created");
  });

  describe("Finding 1: the Jira gate must not depend on the branch carrying a key", () => {
    // The exact reproduction from the review, and it has since sharpened. Under the
    // reference config, branch.pattern admits only lowercase while jira.keyPattern is
    // `ABC-\d+`, so a branch that satisfies branch.pattern never carries a key. The title
    // no longer carries one either: that repository's workflow derives the ticket tag from
    // the branch and prepends it when the pull request opens, so titlePattern dropped it.
    //
    // Two of the three possible sources are therefore empty by construction, and only the
    // body cites a key. If the identity is taken from either of the other two, issue-level,
    // foreign-commits and issue-unverified all fall silent together and the run exits 0 with
    // an empty stderr. This is not a synthetic fixture — it is the real reference config,
    // loaded exactly as the CLI would.
    const REFERENCE_CONFIG = loadConfig("docs/examples/example.shipkit.yml");
    const REPRO_BRANCH = "bugfix/squad/31087-invoice"; // passes branch.pattern; carries no issue key at all
    const REPRO_RESPONSE: SubmitResponse = {
      title: "fix(x): y", // passes titlePattern; carries no issue key either
      commitMessage: "fix(x): y",
      sections: {
        Summary: "It was broken; now it is not.",
        "Screenshots / Screen Recordings": "Nothing to show — logic only.",
        "What to Test": "- one\n- two\n- three",
        "Issues Addressed": "- [ABC-1](https://jira.example.com/browse/ABC-1)",
      },
    };
    // Story-level, so issue-level has nothing to flag — isolates the foreign-commits
    // assertion below from an unrelated issue-level finding.
    const STORY_FACTS: IssueFacts = { key: "ABC-1", type: "Story", summary: "s" };

    function reproDeps(overrides: Partial<SubmitDeps> = {}) {
      return makeDeps({
        loadConfig: () => REFERENCE_CONFIG,
        currentBranch: () => REPRO_BRANCH,
        resolveIssue: (key: string) => Promise.resolve(key === "ABC-1" ? STORY_FACTS : undefined),
        readRepoState: () => ({
          branch: REPRO_BRANCH,
          changedFiles: [],
          diffstat: "",
          // Cites a different key than the response title (ABC-1) — this is the stray
          // commit foreign-commits exists to catch.
          commits: ["[ABC-27975] fix(split-passenger): popup"],
        }),
        ...overrides,
      });
    }

    it("resolves the key the body cites (issue-level) and warns about the stray commit (foreign-commits), instead of running silently", async () => {
      const { deps, calls, err } = reproDeps();

      const result = await runSubmit({ ...OPTIONS, response: REPRO_RESPONSE, acknowledge: [] }, deps);

      // issue-level actually ran: resolveIssue was called with the body's cited key, ABC-1 —
      // before the fix, ticketFromBranch(REPRO_BRANCH, ...) is undefined, so this call would
      // never happen with that key.
      expect(calls.some((c) => c.fn === "resolveIssue" && c.args[0] === "ABC-1")).toBe(true);

      // foreign-commits actually ran and caught the stray commit — before the fix, ticketKey
      // is undefined so the whole check is skipped and the run exits 0 with empty stderr.
      expect(result.code).toBe(2);
      expect(err.join("\n")).toContain("foreign-commits");
      expect(err.join("\n")).toContain("ABC-27975");
    });

    it("discriminates: without the fix (ticketFromBranch on this branch), the exact same run is silent", async () => {
      // Pins the "before" half of the reproduction directly, rather than relying on reading
      // the review by eye: deriving the identity from the branch (this test's stand-in for
      // the old, unfixed code path) is undefined here, which is exactly why the whole gate
      // went silent. ticketFromBranch is still exported and behaves the same as ever — it is
      // simply no longer what run.ts uses for this purpose.
      const { ticketFromBranch } = await import("../../src/cli-support.js");
      expect(ticketFromBranch(REPRO_BRANCH, REFERENCE_CONFIG.jira.keyPattern)).toBeUndefined();
    });
  });
});

describe("runSubmit result shape", () => {
  it("returns the findings as data, not only an exit code", async () => {
    const { deps } = makeDeps({});

    const result = await runSubmit(
      { ...OPTIONS, response: { ...VALID_RESPONSE, title: "nope" } },
      deps,
    );

    expect(result.code).toBe(1);
    expect(result.findings.map((f) => f.rule)).toContain("title-pattern");
    expect(result.warnings).toEqual([]);
    expect(result.committed).toBe(false);
  });

  it("returns the warnings as data when it refuses for want of --yes", async () => {
    const { deps } = makeDeps({
      readUntrackedFiles: () => [".env.local"],
    });

    const result = await runSubmit({ ...OPTIONS, acknowledge: [] }, deps);

    expect(result.code).toBe(2);
    expect(result.warnings.map((w) => w.check)).toContain("untracked-files");
    expect(result.committed).toBe(false);
  });

  // runSubmit serves both the CLI (which has --yes) and MCP (which has no such flag, only
  // acknowledge: [...]). Naming --yes here would reach the MCP caller too, so the core's
  // message stays neutral — the ids and nothing else — and each interface appends its own
  // remedy (src/cli.ts for --yes, src/mcp/result.ts's applyContent for acknowledge).
  it("names the unacknowledged ids in the refusal message, and does not mention --yes", async () => {
    const { deps } = makeDeps({
      readUntrackedFiles: () => [".env.local"],
    });

    const result = await runSubmit({ ...OPTIONS, acknowledge: [] }, deps);

    expect(result.code).toBe(2);
    expect(result.message).toContain("untracked-files");
    expect(result.message).not.toContain("--yes");
  });

  // The body is what will actually be posted. A caller that cannot see it has to trust
  // that its sections were assembled the way it imagined.
  it("returns the rendered body alongside the findings", async () => {
    const { deps } = makeDeps({});

    const result = await runSubmit(
      { ...OPTIONS, response: { ...VALID_RESPONSE, title: "nope" } },
      deps,
    );

    expect(result.body).toContain("## Summary");
  });

  it("returns the url and marks whether the pull request already existed", async () => {
    const { deps } = makeDeps({});

    const result = await runSubmit(OPTIONS, deps);

    expect(result.code).toBe(0);
    expect(result.url).toBe("https://github.com/x/y/pull/1");
    expect(result.updated).toBe(false);
  });

  it("marks an updated pull request as updated", async () => {
    const { deps } = makeDeps({
      findPullRequest: () => ({
        number: 7,
        url: "https://github.com/x/y/pull/7",
        baseRefName: "develop",
        labels: [],
        approvals: [],
      }),
    });

    const result = await runSubmit(OPTIONS, deps);

    expect(result.code).toBe(0);
    expect(result.url).toBe("https://github.com/x/y/pull/7");
    expect(result.updated).toBe(true);
  });

  // With no path there is no file to keep out of the commit, and the realpath machinery
  // must not run at all — not run and produce an empty answer, but never be reached.
  it("excludes nothing and consults no path when the response came from no file", async () => {
    const { deps, calls } = makeDeps({});

    const result = await runSubmit({ ...OPTIONS, responsePath: undefined }, deps);

    expect(result.code).toBe(0);
    expect(calls.find((c) => c.fn === "commitAll")?.args[1]).toEqual([]);
    expect(calls.some((c) => c.fn === "realpath")).toBe(false);
    expect(calls.some((c) => c.fn === "readRepoRoot")).toBe(false);
  });

  // Both `body` and `warnings` are computed well before the mutating tail that can throw —
  // a VcsError escaping pushBranch must not make the catch report either as though nothing
  // had been computed yet. The next task's `applyContent` reads exactly these two fields.
  it("returns the body and warnings already computed when a VcsError escapes after commitAll", async () => {
    const { deps } = makeDeps({
      readUntrackedFiles: () => [".env.local"],
      pushBranch: () => {
        throw new VcsError("git push --set-upstream origin failed: rejected");
      },
    });

    const result = await runSubmit({ ...OPTIONS, acknowledge: "all" }, deps);

    expect(result.code).toBe(2);
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.body).toContain("## Summary");
    expect(result.warnings.map((w) => w.check)).toContain("untracked-files");
  });

  // The mirror image of the test above: a failure before renderBody ever ran must not claim
  // a body or warnings exist, since neither was computed.
  it("returns no body and no warnings when the failure happens before rendering", async () => {
    const { deps } = makeDeps({
      loadConfig: () => {
        throw new ConfigError("Cannot read config at nope.yml");
      },
    });

    const result = await runSubmit(OPTIONS, deps);

    expect(result.code).toBe(2);
    expect(result.body).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  // Same fix, a different call site — pins that the hoist isn't accidentally scoped to only
  // the pushBranch failure above.
  it("returns the warnings too when createPullRequest throws after a successful push", async () => {
    const { deps } = makeDeps({
      readUntrackedFiles: () => [".env.local"],
      createPullRequest: () => {
        throw new VcsError("gh pr create failed: not authenticated");
      },
    });

    const result = await runSubmit({ ...OPTIONS, acknowledge: "all" }, deps);

    expect(result.code).toBe(2);
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.body).toContain("## Summary");
    expect(result.warnings.map((w) => w.check)).toContain("untracked-files");
  });
});

// `git add --all` was staging shipkit's own response file into the pull request on every
// run, alongside whatever else happened to be lying in the checkout. These pin the two
// halves of the answer: the response file is excluded outright, everything else untracked
// is reported so the author can decide.
describe("runSubmit and the working tree", () => {
  it("excludes the response file from staging, as a root-relative path", async () => {
    const { deps, calls } = makeDeps({});

    const result = await runSubmit({ ...OPTIONS, responsePath: "/repo/scratch/response.json" }, deps);

    expect(result.code).toBe(0);
    const staged = calls.find((c) => c.fn === "commitAll");
    expect(staged?.args[1]).toEqual(["scratch/response.json"]);
  });

  // An absolute or out-of-tree pathspec is rejected by git outright, so passing one would
  // turn an otherwise clean submit into a hard failure. A response file written outside the
  // repository also needs no exclusion: staging can never reach it.
  it("excludes nothing when the response file lives outside the repository", async () => {
    const { deps, calls } = makeDeps({});

    const result = await runSubmit({ ...OPTIONS, responsePath: "/tmp/elsewhere/response.json" }, deps);

    expect(result.code).toBe(0);
    expect(calls.find((c) => c.fn === "commitAll")?.args[1]).toEqual([]);
  });

  it("warns about the other untracked files staging would sweep in", async () => {
    const { deps, err } = makeDeps({
      readUntrackedFiles: () => [".env.local", "debug-notes.md"],
    });

    const result = await runSubmit({ ...OPTIONS, acknowledge: [] }, deps);

    expect(result.code).toBe(2);
    expect(err.join("\n")).toContain("untracked-files");
    expect(err.join("\n")).toContain(".env.local");
  });

  // The response file is untracked too. Reporting it would put a warning on every single
  // run, and a warning that always fires is one nobody reads.
  it("does not warn about the response file itself", async () => {
    const { deps, err } = makeDeps({
      readUntrackedFiles: () => ["scratch/response.json"],
    });

    const result = await runSubmit(
      { ...OPTIONS, responsePath: "/repo/scratch/response.json", acknowledge: [] },
      deps,
    );

    expect(result.code).toBe(0);
    expect(err.join("\n")).not.toContain("untracked-files");
  });

  it("still warns about the others when the response file sits among them", async () => {
    const { deps, err } = makeDeps({
      readUntrackedFiles: () => ["scratch/response.json", ".env.local"],
    });

    const result = await runSubmit(
      { ...OPTIONS, responsePath: "/repo/scratch/response.json", acknowledge: [] },
      deps,
    );

    expect(result.code).toBe(2);
    expect(err.join("\n")).toContain(".env.local");
    expect(err.join("\n")).not.toContain("response.json");
  });
});

// git rev-parse --show-toplevel resolves symbolic links; node's resolve() does not. On a
// checkout reached through one, the two spellings of the same directory disagree and the
// response file looks like it lives outside the repository — so the exclusion is skipped
// and the file lands in the commit, which is the bug this whole change exists to fix.
describe("runSubmit under a symlinked checkout", () => {
  it("still excludes the response file when the root is reached through a symlink", async () => {
    const { deps, calls } = makeDeps({
      readRepoRoot: () => "/private/var/repo",
      realpath: (path: string) => path.replace(/^\/var\//, "/private/var/"),
    });

    const result = await runSubmit({ ...OPTIONS, responsePath: "/var/repo/scratch/response.json" }, deps);

    expect(result.code).toBe(0);
    expect(calls.find((c) => c.fn === "commitAll")?.args[1]).toEqual(["scratch/response.json"]);
  });
});

describe("runSubmit path dialects and a vanished response file", () => {
  // `relative` answers in the platform separator; `git ls-files --full-name` always answers
  // in forward slashes. The two are compared to each other and one of them becomes a
  // pathspec, so a backslash here means the exclusion misses and the response file is
  // reported as untracked on every single run.
  it("spells the excluded path the way git spells paths", async () => {
    const { deps, calls } = makeDeps({});

    const result = await runSubmit({ ...OPTIONS, responsePath: "/repo/a/b/response.json" }, deps);

    expect(result.code).toBe(0);
    const excluded = calls.find((c) => c.fn === "commitAll")?.args[1] as string[];
    expect(excluded).toEqual(["a/b/response.json"]);
    expect(excluded[0]).not.toContain("\\");
  });

  // realpath throws on a path that no longer exists, and a raw ENOENT is none of the typed
  // errors the catch below classifies — it would escape and crash with a stack trace
  // instead of the exit 2 every other bad input gets.
  it("returns 2 instead of crashing when the response file vanishes mid-run", async () => {
    const { deps, calls, err } = makeDeps({
      realpath: () => {
        throw new Error("ENOENT: no such file or directory");
      },
    });

    const result = await runSubmit(OPTIONS, deps);

    expect(result.code).toBe(2);
    expect(err.join("\n")).toContain(OPTIONS.responsePath as string);
    expect(calls.some((c) => c.fn === "commitAll")).toBe(false);
  });
});

describe("preview mode", () => {
  it("stops after pre-flight and mutates nothing", async () => {
    const { deps, calls } = makeDeps({});

    const result = await runSubmit({ ...OPTIONS, mode: "preview" }, deps);

    expect(result.code).toBe(0);
    expect(result.body).toContain("## Summary");
    expect(calls.some((c) => ["commitAll", "pushBranch", "createPullRequest"].includes(c.fn))).toBe(false);
  });

  it("reports warnings without refusing, because it is not deciding anything", async () => {
    const { deps } = makeDeps({ readUntrackedFiles: () => [".env.local"] });

    const result = await runSubmit({ ...OPTIONS, mode: "preview", acknowledge: [] }, deps);

    expect(result.code).toBe(0);
    expect(result.warnings.map((w) => w.check)).toContain("untracked-files");
  });

  it("still returns 1 for a validation finding", async () => {
    const { deps } = makeDeps({});

    const result = await runSubmit(
      { ...OPTIONS, mode: "preview", response: { ...VALID_RESPONSE, title: "nope" } },
      deps,
    );

    expect(result.code).toBe(1);
  });

  // A preview that disagrees with what apply will do is worse than no preview.
  it("agrees with apply about findings and warnings for the same input", async () => {
    const overrides = { readUntrackedFiles: () => [".env.local"] };
    const previewed = await runSubmit(
      { ...OPTIONS, mode: "preview", acknowledge: [] },
      makeDeps(overrides).deps,
    );
    const applied = await runSubmit(
      { ...OPTIONS, mode: "apply", acknowledge: [] },
      makeDeps(overrides).deps,
    );

    expect(previewed.findings).toEqual(applied.findings);
    expect(previewed.warnings).toEqual(applied.warnings);
  });
});

describe("the acknowledgement gate", () => {
  it("refuses when a warning id was not acknowledged", async () => {
    const { deps, calls } = makeDeps({ readUntrackedFiles: () => [".env.local"] });

    const result = await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: [] }, deps);

    expect(result.code).toBe(2);
    expect(calls.some((c) => c.fn === "commitAll")).toBe(false);
  });

  it("proceeds when every warning id was acknowledged", async () => {
    const { deps, calls } = makeDeps({ readUntrackedFiles: () => [".env.local"] });

    const result = await runSubmit(
      { ...OPTIONS, mode: "apply", acknowledge: ["untracked-files"] },
      deps,
    );

    expect(result.code).toBe(0);
    expect(calls.some((c) => c.fn === "commitAll")).toBe(true);
  });

  // The gate is the whole point of the split: acknowledging one warning must not carry a
  // caller past a different one it never saw.
  it("refuses when one of two warnings was acknowledged", async () => {
    const { deps, calls } = makeDeps({
      readUntrackedFiles: () => [".env.local"],
      findPullRequest: () => ({
        number: 7,
        url: "https://github.com/x/y/pull/7",
        baseRefName: "release/3.76.0",
        labels: [],
        approvals: [],
      }),
    });

    const result = await runSubmit(
      { ...OPTIONS, mode: "apply", acknowledge: ["untracked-files"] },
      deps,
    );

    expect(result.code).toBe(2);
    expect(result.warnings.map((w) => w.check)).toContain("base-mismatch");
    expect(calls.some((c) => c.fn === "commitAll")).toBe(false);
  });

  // Acknowledging an id that is not among the current warnings must not count for anything.
  it("ignores an acknowledgement that names a warning that is not present", async () => {
    const { deps, calls } = makeDeps({ readUntrackedFiles: () => [".env.local"] });

    const result = await runSubmit(
      { ...OPTIONS, mode: "apply", acknowledge: ["approvals-dismissed"] },
      deps,
    );

    expect(result.code).toBe(2);
    expect(calls.some((c) => c.fn === "commitAll")).toBe(false);
  });

  // The property a boolean cannot have. Acknowledging what was true a moment ago must not
  // carry a caller past a situation that has changed since — a review landing or a label
  // being added between the two calls has to close the gate again.
  it("refuses when the situation changed after the ids were acknowledged", async () => {
    const first = makeDeps({ readUntrackedFiles: () => [".env.local"] });
    const previewed = await runSubmit({ ...OPTIONS, mode: "preview", acknowledge: [] }, first.deps);
    const acknowledge = previewed.warnings.map((w) => w.check);
    expect(acknowledge).toEqual(["untracked-files"]);

    // Between the two calls a blocking label appears on the open pull request.
    const second = makeDeps({
      readUntrackedFiles: () => [".env.local"],
      findPullRequest: () => ({
        number: 7,
        url: "https://github.com/x/y/pull/7",
        baseRefName: "develop",
        labels: ["in test"],
        approvals: [],
      }),
      loadConfig: () => loadConfig("tests/fixtures/blocking-labels.shipkit.yml"),
    });

    const result = await runSubmit({ ...OPTIONS, mode: "apply", acknowledge }, second.deps);

    expect(result.code).toBe(2);
    expect(result.warnings.map((w) => w.check)).toContain("blocking-label");
    expect(second.calls.some((c) => c.fn === "commitAll")).toBe(false);
  });

  it("accepts \"all\" as the command line's --yes", async () => {
    const { deps, calls } = makeDeps({ readUntrackedFiles: () => [".env.local"] });

    const result = await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: "all" }, deps);

    expect(result.code).toBe(0);
    expect(calls.some((c) => c.fn === "commitAll")).toBe(true);
  });
});

describe("the approval surface", () => {
  const warned = { readUntrackedFiles: () => [".env.local"] };

  it("does not ask when there is nothing to warn about", async () => {
    const { deps, calls } = makeDeps({});
    await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: "all" }, deps);
    expect(calls.some((c) => c.fn === "requestApproval")).toBe(false);
  });

  it("does not ask under echo when the ids cover the warnings", async () => {
    const { deps, calls } = makeDeps(warned);
    await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: "all" }, deps);
    expect(calls.some((c) => c.fn === "requestApproval")).toBe(false);
  });

  it("asks under echo when they do not, and proceeds when approved", async () => {
    const { deps, calls } = makeDeps({ ...warned, requestApproval: async () => ({ outcome: "approved" as const }) });
    const result = await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: [] }, deps);
    expect(result.code).toBe(0);
    expect(result.approval).toBe("approved");
    expect(calls.some((c) => c.fn === "commitAll")).toBe(true);
    // The fingerprint is what a repeated call would need to recognize this same
    // situation — it must survive onto a successful result, not only a refusal.
    expect(result.approvalFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses and mutates nothing when denied", async () => {
    const { deps, calls } = makeDeps({ ...warned, requestApproval: async () => ({ outcome: "denied" as const }) });
    const result = await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: [] }, deps);
    expect(result.code).toBe(2);
    expect(result.refusal).toBe("denied");
    expect(calls.some((c) => c.fn === "commitAll")).toBe(false);
  });

  // A listener answering the wrong protocol version produces a `ProtocolError` whose message
  // already names both numbers; `requestApproval` maps that to a plain "denied" outcome but
  // carries the message through as `detail`. Losing it here would tell the reader a person
  // refused their push when nobody was ever asked.
  it("names both protocol versions in the refusal when the surface disagrees on protocol", async () => {
    const { deps } = makeDeps({
      ...warned,
      requestApproval: async () => ({
        outcome: "denied" as const,
        detail: "The approval surface speaks protocol 99; this shipkit speaks 1",
      }),
    });
    const result = await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: [] }, deps);
    expect(result.code).toBe(2);
    expect(result.refusal).toBe("denied");
    expect(result.message).toContain("protocol 99");
    expect(result.message).toContain("speaks 1");
  });

  it("refuses and mutates nothing when the wait runs out, naming the fingerprint to resume", async () => {
    const { deps, calls } = makeDeps({ ...warned, requestApproval: async () => ({ outcome: "timed-out" as const }) });
    const result = await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: [] }, deps);
    expect(result.code).toBe(2);
    expect(result.refusal).toBe("timed-out");
    expect(calls.some((c) => c.fn === "commitAll")).toBe(false);
    // Naming the actual fingerprint, not a placeholder, is what makes the resumption
    // claim true — an implementation that always printed "unknown" would still pass
    // every assertion above.
    expect(result.approvalFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.message).toContain(result.approvalFingerprint as string);
  });

  // The property that keeps the application optional.
  it("falls back to today's refusal under echo with nothing listening", async () => {
    const { deps, err } = makeDeps({ ...warned, requestApproval: async () => ({ outcome: "no-surface" as const }) /* extra args ignored */ });
    const result = await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: [] }, deps);
    expect(result.code).toBe(2);
    expect(err.join("\n")).toContain("untracked-files");
  });

  it("sends the situation, not a summary of it", async () => {
    let sent: ApprovalRequest | undefined;
    const { deps } = makeDeps({
      ...warned,
      requestApproval: async (request: ApprovalRequest, timeoutMs: number) => {
        sent = request;
        expect(timeoutMs).toBe(120_000);
        return { outcome: "denied" as const };
      },
    });

    await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: [] }, deps);

    expect(sent?.head).toBe("a".repeat(40));
    expect(sent?.base).toBe(OPTIONS.base);
    expect(sent?.warnings.map((w) => w.check)).toContain("untracked-files");
    expect(sent?.commitMessage).toBe(VALID_RESPONSE.commitMessage);
    // The fingerprint must be the one the situation hashes to, not an
    // independent value the surface would have no way to check.
    expect(sent?.fingerprint).toBe(
      fingerprint({
        repo: sent!.repo,
        branch: sent!.branch,
        base: sent!.base,
        head: sent!.head,
        title: sent!.title,
        commitMessage: sent!.commitMessage,
        diffstat: sent!.diffstat,
        warnings: sent!.warnings,
      }),
    );
  });

  // The size of the change is half of what the reader is judging, and `commitAll` stages
  // the whole working tree — so the number on the panel has to be the number the push
  // delivers, measured with the same exclusion the commit is given. Asking
  // `readRepoState` instead returns `base...HEAD`, committed work only, which on a branch
  // whose work is still uncommitted is the empty string.
  it("shows the size of what will be pushed, excluding what the commit excludes", async () => {
    let sent: ApprovalRequest | undefined;
    let asked: [string, string[]] | undefined;
    const { deps, calls } = makeDeps({
      ...warned,
      readRepoState: () => ({ branch: BRANCH, changedFiles: [], diffstat: "", commits: [] }),
      readPushDiffstat: (base: string, exclude: string[]) => {
        asked = [base, exclude];
        return " a.ts | 400 ++++\n 400 files changed, 9999 insertions(+)";
      },
      requestApproval: async (request: ApprovalRequest) => {
        sent = request;
        return { outcome: "denied" as const };
      },
    });

    await runSubmit(
      { ...OPTIONS, responsePath: "/repo/scratch/response.json", mode: "apply", acknowledge: [] },
      deps,
    );

    expect(sent?.diffstat).toContain("400 files changed");
    // The same base and the same exclusion `commitAll` would have been given: a stat
    // that names the response file contradicts the exclusion the commit applies.
    expect(asked).toEqual([OPTIONS.base, ["scratch/response.json"]]);
    // And it is the value that was hashed, not a second reading of the repository.
    expect(sent?.fingerprint).toBe(
      fingerprint({
        repo: sent!.repo,
        branch: sent!.branch,
        base: sent!.base,
        head: sent!.head,
        title: sent!.title,
        commitMessage: sent!.commitMessage,
        diffstat: sent!.diffstat,
        warnings: sent!.warnings,
      }),
    );
    expect(calls.some((c) => c.fn === "commitAll")).toBe(false);
  });

  // preflight emits approvals-dismissed, then foreign-commits, then base-mismatch for this
  // situation — not alphabetical. The fingerprint hashes them sorted by check id, so the
  // wire must carry them in that same order or the displayed order and the hashed order
  // could diverge.
  it("sends warnings on the wire in canonical order, not preflight's emission order", async () => {
    let sent: ApprovalRequest | undefined;
    const { deps } = makeDeps({
      readRepoState: () => ({
        branch: BRANCH,
        changedFiles: [],
        diffstat: "",
        commits: ["ABC-2 unrelated work"],
      }),
      findPullRequest: () => ({
        number: 881,
        url: "https://github.com/x/y/pull/881",
        baseRefName: "main",
        labels: [],
        approvals: ["alice"],
      }),
      requestApproval: async (request: ApprovalRequest) => {
        sent = request;
        return { outcome: "denied" as const };
      },
    });

    await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: [] }, deps);

    expect(sent?.warnings.map((w) => w.check)).toEqual([
      "approvals-dismissed",
      "base-mismatch",
      "foreign-commits",
    ]);
  });

  // Minutes can pass while a request waits. An approval that survives a
  // situation changing underneath it is worth nothing.
  it("re-derives the facts after approval and refuses when they changed", async () => {
    let reads = 0;
    const { deps, calls } = makeDeps({
      ...warned,
      requestApproval: async () => ({ outcome: "approved" as const }),
      // The first read is the one hashed into the request; by the second, a
      // blocking label has appeared on the pull request.
      findPullRequest: () => {
        reads += 1;
        return reads === 1
          ? NO_PR
          : {
              number: 7,
              url: "https://github.com/x/y/pull/7",
              baseRefName: "develop",
              labels: ["in test"],
              approvals: [],
            };
      },
      loadConfig: () => loadConfig("tests/fixtures/blocking-labels.shipkit.yml"),
    });

    const result = await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: [] }, deps);

    expect(result.code).toBe(2);
    expect(result.warnings.map((w) => w.check)).toContain("blocking-label");
    expect(calls.some((c) => c.fn === "commitAll")).toBe(false);
  });

  it("proceeds when the facts are unchanged", async () => {
    const { deps, calls } = makeDeps({ ...warned, requestApproval: async () => ({ outcome: "approved" as const }) });
    const result = await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: [] }, deps);
    expect(result.code).toBe(0);
    expect(calls.some((c) => c.fn === "commitAll")).toBe(true);
  });

  // The re-derivation exists to refresh the facts a mutating call is about to act on — not
  // only the ones that feed the fingerprint. A pull request that opens during the wait, with
  // no warning of its own, leaves the fingerprint unchanged and the gate opens legitimately;
  // but the open-or-update decision at the end must still see it, or createPullRequest fires
  // against a branch that already has one open.
  it("updates the pull request that opened during the wait, instead of creating a second one", async () => {
    let reads = 0;
    const { deps, calls } = makeDeps({
      ...warned,
      requestApproval: async () => ({ outcome: "approved" as const }),
      findPullRequest: () => {
        reads += 1;
        return reads === 1
          ? NO_PR
          : {
              number: 9,
              url: "https://github.com/x/y/pull/9",
              baseRefName: "develop",
              labels: [],
              approvals: [],
            };
      },
    });

    const result = await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: [] }, deps);

    expect(result.code).toBe(0);
    expect(result.updated).toBe(true);
    expect(result.url).toBe("https://github.com/x/y/pull/9");
    expect(calls.some((c) => c.fn === "commitAll")).toBe(true);
    expect(calls.some((c) => c.fn === "pushBranch")).toBe(true);
    expect(calls.some((c) => c.fn === "createPullRequest")).toBe(false);
  });

  // "The situation changed" alone gives a person on a churning repository nothing to act
  // on, and the retry it invites fails the same way forever — an editor autosave or a
  // watcher's output during the 120-second wait moves the diffstat every time. Naming the
  // field points at what actually happened instead.
  it("names which field changed when the re-derived situation no longer matches", async () => {
    let reads = 0;
    const { deps, err } = makeDeps({
      ...warned,
      requestApproval: async () => ({ outcome: "approved" as const }),
      // First read is the one hashed into the request; the second stands in for a
      // watcher or autosave touching the tree while the person was deciding.
      readPushDiffstat: () => {
        reads += 1;
        return reads === 1
          ? " a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)"
          : " a.ts | 2 +-\n b.ts | 1 +\n 2 files changed, 2 insertions(+), 1 deletion(-)";
      },
    });

    const result = await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: [] }, deps);

    expect(result.code).toBe(2);
    expect(result.message).toContain("diffstat");
    expect(result.message).not.toBe(
      "The situation changed while the approval was pending; asking again from the start.",
    );
    expect(err.join("\n")).toContain("diffstat");
  });

  it("never asks in preview mode", async () => {
    const { deps, calls } = makeDeps(warned);
    await runSubmit({ ...OPTIONS, mode: "preview", acknowledge: [] }, deps);
    expect(calls.some((c) => c.fn === "requestApproval")).toBe(false);
  });
});

describe("the human policy", () => {
  const humanConfig = () => {
    const config = loadConfig("tests/fixtures/valid.shipkit.yml");
    return { ...config, pr: { ...config.pr, approval: "human" as const } };
  };
  const warned = { readUntrackedFiles: () => [".env.local"], loadConfig: humanConfig };

  it("asks even when every id was echoed", async () => {
    const { deps, calls } = makeDeps({ ...warned, requestApproval: async () => ({ outcome: "approved" as const }) });
    await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: "all" }, deps);
    expect(calls.some((c) => c.fn === "requestApproval")).toBe(true);
  });

  // Otherwise the policy is decorative: an agent, or a --yes, would walk past it.
  it("refuses an echoed acknowledgement with nothing listening", async () => {
    const { deps, calls } = makeDeps({ ...warned, requestApproval: async () => ({ outcome: "no-surface" as const }) /* extra args ignored */ });
    const result = await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: "all" }, deps);
    expect(result.code).toBe(2);
    // Under echo the same outcome maps to "unacknowledged" (see the describe above); under
    // human it must not, or the CLI's "Re-run with --yes" and MCP's "acknowledge: [...]"
    // guidance would both be offered as if they could fix what --yes/acknowledge cannot.
    expect(result.refusal).toBe("no-surface");
    expect(calls.some((c) => c.fn === "commitAll")).toBe(false);
  });

  it("says the surface is not running rather than naming ids to acknowledge", async () => {
    const { deps, err } = makeDeps({ ...warned, requestApproval: async () => ({ outcome: "no-surface" as const }) /* extra args ignored */ });
    await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: "all" }, deps);
    expect(err.join("\n")).toMatch(/approval surface/i);
  });

  // The spec asks this refusal to say "that the approval surface is not running
  // and how to start it". Saying only the first half leaves the reader stuck: a
  // menu-bar application they have never heard of is not something anyone
  // guesses their way to, and this is the reason most likely to be met first.
  it("tells the reader how to start the surface, not just that it is absent", async () => {
    const { deps, err } = makeDeps({ ...warned, requestApproval: async () => ({ outcome: "no-surface" as const }) /* extra args ignored */ });
    await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: "all" }, deps);
    expect(err.join("\n")).toContain("scripts/app.sh");
  });
});

// `detectConversion` had no caller at all until this wiring: the advice half of the feature
// was built, tested and unreachable. These drive it through `runSubmit`, and the property
// every one of them protects is the same — advice is carried, printed and returned, and it
// changes nothing else about the run.
describe("advice", () => {
  // A file that loses every UIKit marker and gains a SwiftUI one, which is what
  // detectConversion calls a conversion. Two of them, so the message has a count to name.
  const CONVERTED: ChangedFile[] = [
    {
      path: "Scenes/SummaryViewController.swift",
      status: "modified",
      before: "import UIKit\nfinal class S: UIViewController { @IBOutlet var l: UILabel! }\n",
      after: 'import SwiftUI\nstruct S: View { @State var n = 0\n  var body: some View { Text("x") } }\n',
    },
    {
      path: "Scenes/DetailViewController.swift",
      status: "modified",
      before: "import UIKit\nfinal class D: UIViewController { }\n",
      after: 'import SwiftUI\nstruct D: View { var body: some View { Text("y") } }\n',
    },
  ];

  const converting = { readPushChangedFiles: () => CONVERTED };

  it("returns the advice and prints it, naming the count of files and the command", async () => {
    const { deps, err } = makeDeps(converting);

    const result = await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: "all" }, deps);

    expect(result.advice?.map((item) => item.topic)).toEqual(["uikit-to-swiftui"]);
    const message = result.advice?.[0]?.message ?? "";
    expect(message).toContain("2 files");
    expect(message).toContain("shipkit tech-task --subject");
    // The count, not the list — a thirty-file conversion would bury the sentence that
    // matters, and the paths are in the diffstat already.
    expect(message).not.toContain("Scenes/SummaryViewController.swift");
    // Printed, not merely returned: the CLI has no other way to show it.
    expect(err.join("\n")).toContain("shipkit tech-task --subject");
  });

  it("says nothing at all when the change carries no conversion", async () => {
    const { deps, err } = makeDeps({});

    const result = await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: "all" }, deps);

    expect(result.advice).toEqual([]);
    expect(err.join("\n")).not.toContain("tech-task");
  });

  // The assertion the whole design rests on, made end to end rather than about the types:
  // two runs identical but for the conversion must agree on the exit code. `Advice` being a
  // separate type from `Warning` is what makes this true, and this is where it is checked.
  it("returns the same exit code as the identical run without it", async () => {
    const plain = await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: "all" }, makeDeps({}).deps);
    const advised = await runSubmit(
      { ...OPTIONS, mode: "apply", acknowledge: "all" },
      makeDeps(converting).deps,
    );

    expect(advised.code).toBe(plain.code);
    expect(advised.code).toBe(0);
    // And it really was the advised run — otherwise this compares two identical runs.
    expect(advised.advice).toHaveLength(1);
    expect(plain.advice).toEqual([]);
  });

  // Under `pr.approval: human` any unacknowledged warning asks a person every time. Advice
  // routed as a warning would therefore gate every push carrying a conversion, which is the
  // opposite of what this feature is for. Poisoned rather than merely unasserted: this proves
  // the surface was never reached, not that nobody looked.
  it("never reaches the approval surface, even under pr.approval: human", async () => {
    const { deps, calls } = makeDeps({
      ...converting,
      loadConfig: () => loadConfig("tests/fixtures/human-approval.shipkit.yml"),
      requestApproval: () => {
        throw new Error("advice must never ask a person");
      },
    });

    const result = await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: [] }, deps);

    expect(result.code).toBe(0);
    expect(calls.some((c) => c.fn === "requestApproval")).toBe(false);
    expect(result.advice).toHaveLength(1);
  });

  // A field on the approval panel has to be bound into the fingerprint, and advice is not a
  // decision. So it is neither: the request carries no advice, and the hash of a situation
  // with a conversion equals the hash of the same situation without one.
  //
  // Measured, so the two halves are not credited equally: the request-key assertion is the
  // discriminating one — adding `advice` to the request object fails this test. The
  // fingerprint assertion does not discriminate on its own, because `Situation` is a closed
  // record that `canonical` hashes field by field, so an extra property cannot reach the
  // hash however carelessly it is attached. It is kept as the guard for the day someone
  // widens `Situation` itself.
  it("stays off the approval request and out of the fingerprint", async () => {
    const warned = { readUntrackedFiles: () => [".env.local"] };
    const seen: ApprovalRequest[] = [];
    const capture = async (request: ApprovalRequest) => {
      seen.push(request);
      return { outcome: "denied" as const };
    };

    const plain = await runSubmit(
      { ...OPTIONS, mode: "apply", acknowledge: [] },
      makeDeps({ ...warned, requestApproval: capture }).deps,
    );
    const advised = await runSubmit(
      { ...OPTIONS, mode: "apply", acknowledge: [] },
      makeDeps({ ...warned, ...converting, requestApproval: capture }).deps,
    );

    expect(seen).toHaveLength(2);
    expect(Object.keys(seen[1] as object)).not.toContain("advice");
    expect(JSON.stringify(seen[1])).not.toContain("tech-task");
    expect(advised.approvalFingerprint).toBe(plain.approvalFingerprint);
    expect(advised.advice).toHaveLength(1);
  });

  // preview is where the agent asks what pushing would do, and it is the only chance the
  // observation has to shape the body before it is written.
  it("reaches preview, not only apply", async () => {
    const { deps } = makeDeps(converting);

    const result = await runSubmit({ ...OPTIONS, mode: "preview" }, deps);

    expect(result.code).toBe(0);
    expect(result.advice).toHaveLength(1);
  });

  // Same `exclude` as the commit and the diffstat: an observation about a file the commit
  // will leave out is an observation about a change that is not being made.
  it("asks for the same paths the commit will carry", async () => {
    const { deps, calls } = makeDeps(converting);

    await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: "all" }, deps);

    const read = calls.find((c) => c.fn === "readPushChangedFiles");
    expect(read?.args).toEqual(["develop", ["scratch/response.json"]]);
  });

  // The read the advice needs builds a scratch index and runs `git add --all` against the
  // real working tree, and it fails on repositories where nothing is wrong with the change:
  // a `.gitattributes` clean filter marked `required` whose binary is missing, or one
  // unreadable file. Both reproduced. Before this branch that read only happened inside the
  // `shouldRequestApproval` branch, so an `echo`-policy repository never reached it; the
  // advisory channel put it on every run. Unguarded it returns `code: 2` with nothing
  // committed — advice changing an exit code, the one thing it must never do.
  describe("when the advisory read itself fails", () => {
    const failing = (error: unknown) => ({
      readPushChangedFiles: () => {
        throw error;
      },
    });

    it("commits and pushes anyway, with no advice and the same exit code", async () => {
      const plain = await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: "all" }, makeDeps({}).deps);
      const { deps, calls } = makeDeps(
        failing(new VcsError("git add --all failed: fatal: asset.bin: clean filter 'lfs' failed")),
      );

      const result = await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: "all" }, deps);

      expect(result.code).toBe(plain.code);
      expect(result.code).toBe(0);
      expect(result.advice).toEqual([]);
      expect(result.committed).toBe(true);
      expect(result.pushed).toBe(true);
      // And it really was the failing run: the read was attempted, not skipped.
      expect(calls.some((c) => c.fn === "readPushChangedFiles")).toBe(true);
    });

    // `mkdtempSync` and `rmSync` throw a plain Error, so they are not one of the typed
    // errors the catch below runSubmit's body knows about — unguarded they escape it
    // entirely and reach a person as a stack trace rather than as anything shipkit said.
    it("survives a plain Error, which the typed catch would not have held", async () => {
      const { deps } = makeDeps(failing(new Error("ENOSPC: no space left on device, mkdtemp")));

      const result = await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: "all" }, deps);

      expect(result.code).toBe(0);
      expect(result.advice).toEqual([]);
      expect(result.committed).toBe(true);
    });

    it("prints nothing about it — there is nothing for a reader to do", async () => {
      const { deps, err } = makeDeps(failing(new VcsError("clean filter 'lfs' failed")));

      await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: "all" }, deps);

      expect(err.join("\n")).not.toContain("clean filter");
      expect(err.join("\n")).not.toContain("tech-task");
    });

    it("still emits a preview rather than refusing one", async () => {
      const { deps } = makeDeps(failing(new VcsError("clean filter 'lfs' failed")));

      const result = await runSubmit({ ...OPTIONS, mode: "preview" }, deps);

      expect(result.code).toBe(0);
      expect(result.advice).toEqual([]);
      expect(result.body).toContain("## Summary");
    });
  });
});
