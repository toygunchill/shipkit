import { resolve } from "node:path";
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
        readUntrackedFiles: poisoned("readUntrackedFiles"),
        readRepoRoot: poisoned("readRepoRoot"),
        realpath: poisoned("realpath"),
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
        // VALID_RESPONSE's title and Issues Addressed section both cite ABC-1 — resolving it
        // as Story-level keeps issue-level and issue-unverified silent by default, the same
        // way a real run with a working SHIPKIT_JIRA_TOKEN would. Tests that care about the
        // unresolved/non-story cases override this explicitly.
        resolveIssue: (key: string) => Promise.resolve({ key, type: "Story", summary: "" } as IssueFacts),
        readRepoState: () => ({ branch: BRANCH, changedFiles: [], diffstat: "", commits: [] }),
        findPullRequest: () => NO_PR,
        readUntrackedFiles: () => [],
        readRepoRoot: () => "/repo",
        realpath: (path: string) => path,
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
    readUntrackedFiles: record("readUntrackedFiles", merged.readUntrackedFiles),
    readRepoRoot: record("readRepoRoot", merged.readRepoRoot),
    realpath: record("realpath", merged.realpath),
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
  "readUntrackedFiles",
  "readRepoRoot",
  "realpath",
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
    const pr: PullRequestState = {
      number: 1,
      url: "https://github.com/x/y/pull/1",
      baseRefName: "develop",
      labels: [],
      approvals: ["alice", "bob"],
    };
    const { deps, calls, err } = makeDeps({ findPullRequest: () => pr });

    const code = await runSubmit({ ...OPTIONS, yes: false }, deps);

    expect(code).toBe(2);
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

    const code = await runSubmit({ ...OPTIONS, yes: true }, deps);

    expect(code).toBe(0);
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

    const code = await runSubmit({ ...OPTIONS, yes: false }, deps);

    expect(code).toBe(0);
    expect(calls.some((c) => c.fn === "commitAll")).toBe(true);
    expect(calls.some((c) => c.fn === "pushBranch")).toBe(true);
    expect(calls.some((c) => c.fn === "createPullRequest")).toBe(false);
    expect(out).toEqual([pr.url]);
    expect(err.join("\n")).toContain("updated, not opened");
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
    const { deps, calls, err } = makeDeps({
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

    const code = await runSubmit(OPTIONS, deps);

    expect(code).toBe(2);
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

    const code = await runSubmit(OPTIONS, deps);

    expect(code).toBe(2);
    expect(calls.some((c) => c.fn === "commitAll")).toBe(false);
    expect(err.join("\n")).toContain("git log --end-of-options develop..HEAD failed: unknown revision");
    expect(err.join("\n")).not.toContain("commit was created");
  });

  describe("Finding 1: the Jira gate must not depend on the branch carrying a key", () => {
    // The exact reproduction from the review: under the reference config, branch.pattern
    // admits only lowercase branches and jira.keyPattern is `DCP-\d+` — the two are mutually
    // exclusive, so a branch that satisfies branch.pattern never carries a key. Deriving the
    // ticket identity from the branch therefore always produced `undefined` on every run that
    // survived validation, silently switching off issue-level, foreign-commits and
    // issue-unverified together. This is not a synthetic fixture — it is the real reference
    // config the review used, loaded exactly as the CLI would.
    const REFERENCE_CONFIG = loadConfig("docs/examples/example-app.shipkit.yml");
    const REPRO_BRANCH = "bugfix/squadb/31087-invoice"; // passes branch.pattern; carries no DCP-key at all
    const REPRO_RESPONSE: SubmitResponse = {
      title: "[ABC-1] fix(x): y",
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
        loadResponse: () => REPRO_RESPONSE,
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

      const code = await runSubmit(OPTIONS, deps);

      // issue-level actually ran: resolveIssue was called with the body's cited key, ABC-1 —
      // before the fix, ticketFromBranch(REPRO_BRANCH, ...) is undefined, so this call would
      // never happen with that key.
      expect(calls.some((c) => c.fn === "resolveIssue" && c.args[0] === "ABC-1")).toBe(true);

      // foreign-commits actually ran and caught the stray commit — before the fix, ticketKey
      // is undefined so the whole check is skipped and the run exits 0 with empty stderr.
      expect(code).toBe(2);
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

// `git add --all` was staging shipkit's own response file into the pull request on every
// run, alongside whatever else happened to be lying in the checkout. These pin the two
// halves of the answer: the response file is excluded outright, everything else untracked
// is reported so the author can decide.
describe("runSubmit and the working tree", () => {
  it("excludes the response file from staging, as a root-relative path", async () => {
    const { deps, calls } = makeDeps({});

    const code = await runSubmit({ ...OPTIONS, input: "/repo/scratch/response.json" }, deps);

    expect(code).toBe(0);
    const staged = calls.find((c) => c.fn === "commitAll");
    expect(staged?.args[1]).toEqual(["scratch/response.json"]);
  });

  // An absolute or out-of-tree pathspec is rejected by git outright, so passing one would
  // turn an otherwise clean submit into a hard failure. A response file written outside the
  // repository also needs no exclusion: staging can never reach it.
  it("excludes nothing when the response file lives outside the repository", async () => {
    const { deps, calls } = makeDeps({});

    const code = await runSubmit({ ...OPTIONS, input: "/tmp/elsewhere/response.json" }, deps);

    expect(code).toBe(0);
    expect(calls.find((c) => c.fn === "commitAll")?.args[1]).toEqual([]);
  });

  it("warns about the other untracked files staging would sweep in", async () => {
    const { deps, err } = makeDeps({
      readUntrackedFiles: () => [".env.local", "debug-notes.md"],
    });

    const code = await runSubmit({ ...OPTIONS, yes: false }, deps);

    expect(code).toBe(2);
    expect(err.join("\n")).toContain("untracked-files");
    expect(err.join("\n")).toContain(".env.local");
  });

  // The response file is untracked too. Reporting it would put a warning on every single
  // run, and a warning that always fires is one nobody reads.
  it("does not warn about the response file itself", async () => {
    const { deps, err } = makeDeps({
      readUntrackedFiles: () => ["scratch/response.json"],
    });

    const code = await runSubmit(
      { ...OPTIONS, input: "/repo/scratch/response.json", yes: false },
      deps,
    );

    expect(code).toBe(0);
    expect(err.join("\n")).not.toContain("untracked-files");
  });

  it("still warns about the others when the response file sits among them", async () => {
    const { deps, err } = makeDeps({
      readUntrackedFiles: () => ["scratch/response.json", ".env.local"],
    });

    const code = await runSubmit(
      { ...OPTIONS, input: "/repo/scratch/response.json", yes: false },
      deps,
    );

    expect(code).toBe(2);
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

    const code = await runSubmit({ ...OPTIONS, input: "/var/repo/scratch/response.json" }, deps);

    expect(code).toBe(0);
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

    const code = await runSubmit({ ...OPTIONS, input: "/repo/a/b/response.json" }, deps);

    expect(code).toBe(0);
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

    const code = await runSubmit(OPTIONS, deps);

    expect(code).toBe(2);
    expect(err.join("\n")).toContain(OPTIONS.input);
    expect(calls.some((c) => c.fn === "commitAll")).toBe(false);
  });
});
