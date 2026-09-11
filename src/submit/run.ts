import { isAbsolute, relative, resolve, sep } from "node:path";
import { extractIssueKeysFromBody, firstIssueKey, isValidBase } from "../cli-support.js";
import { ConfigError } from "../config/load.js";
import type { ShipkitConfig } from "../config/schema.js";
import { JiraError } from "../jira/client.js";
import type { IssueFacts } from "../jira/types.js";
import { preflight } from "../preflight/checks.js";
import type { Warning } from "../preflight/types.js";
import { validate } from "../validate/rules.js";
import type { Finding } from "../validate/types.js";
import { VcsError, type RepoState } from "../vcs/git.js";
import type { PullRequestState } from "../vcs/types.js";
import { ResponseError, type SubmitResponse } from "./response.js";

export type Acknowledgement = "all" | string[];

export type SubmitOptions = {
  base: string;
  config: string;
  response: SubmitResponse;
  /** Where the response was read from. Omitted when it never came from a file. */
  responsePath?: string;
  mode: "preview" | "apply";
  /** "all" is the CLI's --yes. An array names the check ids the caller has seen. */
  acknowledge: Acknowledgement;
};

export type SubmitResult = {
  code: 0 | 1 | 2;
  findings: Finding[];
  warnings: Warning[];
  /** The rendered body, once there is one. Absent when the run failed before rendering. */
  body?: string;
  /** Set when a pull request was opened or updated. */
  url?: string;
  /** True when `url` names a pull request that already existed. */
  updated?: boolean;
  /** A refusal or failure explained in one line. Absent on success. */
  message?: string;
  committed: boolean;
  pushed: boolean;
};

/**
 * One member per adapter the sequence calls, plus two output sinks. Pure functions used by
 * the sequence (`isValidBase`, `firstIssueKey`, `extractIssueKeysFromBody`, `validate`,
 * `preflight`) are imported directly above instead of injected — they take no dependency
 * worth faking, and every test in tests/submit/run.test.ts exercises the real ones.
 *
 * `resolveIssue` is called once per key the response body cites (via
 * `extractIssueKeysFromBody`), never with an undefined key — so its "no key" short-circuit
 * (see cli-support.ts) never triggers here; only its "no token" short-circuit can produce an
 * `undefined` for a call made from this module.
 */
export type SubmitDeps = {
  loadConfig: (path: string) => ShipkitConfig;
  renderBody: (sections: Record<string, string>, config: ShipkitConfig) => string;
  currentBranch: () => string;
  resolveIssue: (key: string, config: ShipkitConfig) => Promise<IssueFacts | undefined>;
  readRepoState: (base: string) => RepoState;
  findPullRequest: (branch: string) => PullRequestState | null;
  readUntrackedFiles: () => string[];
  readRepoRoot: () => string;
  realpath: (path: string) => string;
  commitAll: (message: string, exclude: string[]) => void;
  pushBranch: (branch: string) => void;
  createPullRequest: (input: { title: string; body: string; base: string; head: string }) => string;
  out: (line: string) => void;
  err: (line: string) => void;
};

/**
 * Validate the agent's answer, warn about what pushing will disturb, then commit, push and
 * open the pull request — in that order. Returns a structured result — including the exit
 * code the CLI sets `process.exitCode` to — rather than setting `process.exitCode` itself,
 * and writes through `deps.out`/`deps.err` rather than `console` so the whole sequence,
 * including the parts that mutate the repository, can be driven by fakes in tests instead of
 * a real git checkout.
 */
export async function runSubmit(options: SubmitOptions, deps: SubmitDeps): Promise<SubmitResult> {
  if (!isValidBase(options.base)) {
    const message = `Refusing to use ${JSON.stringify(options.base)} as a base branch`;
    deps.err(message);
    return { code: 2, findings: [], warnings: [], message, committed: false, pushed: false };
  }

  // Tracks how far the mutating tail got before a VcsError escaped, so the error report can
  // say what state the repository was actually left in — a local commit is cheap to keep,
  // amend, or drop, but only telling the reader it exists lets them make that call instead of
  // discovering it themselves the next time `commitAll` fails on "nothing to commit".
  let committed = false;
  let pushed = false;
  // Hoisted for the same reason as `committed`/`pushed`: a typed error thrown by the mutating
  // tail (after both have been computed) must still be able to report the body that was
  // rendered and the warnings that were accepted, rather than the catch claiming neither ever
  // existed.
  let body: string | undefined;
  let warnings: Warning[] = [];

  try {
    const config = deps.loadConfig(options.config);
    const response = options.response;
    body = deps.renderBody(response.sections, config);
    const branch = deps.currentBranch();

    // `issue-level` checks the keys the body *cites* (the same source of truth `check`
    // uses), not the branch's key — see the report for why the branch cannot be trusted
    // to carry one at all under configs like docs/examples/example-app.shipkit.yml.
    const citedKeys = extractIssueKeysFromBody(body, config);
    const resolvedIssues = await Promise.all(
      citedKeys.map((key) => deps.resolveIssue(key, config)),
    );
    const issues = resolvedIssues.filter((issue): issue is IssueFacts => issue !== undefined);
    // "Every cited key was resolved." Vacuously true when nothing was cited — there is then
    // nothing for issue-level to have skipped, so issue-unverified (below) has nothing to warn
    // about either, regardless of what ticketKey (the title's key) turns out to be.
    const issueVerified = resolvedIssues.every((issue) => issue !== undefined);

    const result = validate({
      title: response.title,
      body,
      config,
      branch,
      issues,
    });
    if (!result.ok) {
      for (const finding of result.findings) {
        deps.err(`${finding.rule}: ${finding.message}`);
      }
      return {
        code: 1,
        findings: result.findings,
        warnings: [],
        body,
        committed: false,
        pushed: false,
      };
    }

    // The response title's key, not the branch's — titlePattern guarantees the title carries
    // one, which is what foreign-commits needs as this change's identity to compare commits
    // against.
    const ticketKey = firstIssueKey(response.title, config.jira.keyPattern);

    const repo = deps.readRepoState(options.base);
    const existingPr = deps.findPullRequest(branch);
    // The response file is shipkit's own input, never part of the change, so it is excluded
    // from staging rather than merely reported — and dropped from the warning too, since a
    // warning that fires on every single run is one nobody reads. Everything else untracked
    // is the author's to judge, which is what the warning is for.
    //
    // Paths here are repository-root-relative, which is what the pathspec needs and what
    // `readUntrackedFiles` returns. A response file written outside the repository is not
    // excluded at all: git rejects an out-of-tree pathspec outright, and there is nothing
    // to exclude anyway, since staging can never reach it.
    // Both sides go through realpath first. `git rev-parse --show-toplevel` resolves
    // symbolic links and `resolve` does not, so on a checkout reached through one (macOS
    // puts every temporary directory behind /var -> /private/var) the two spellings of the
    // same directory would not match. The mismatch fails quietly in the worst direction:
    // the response file is judged to be outside the repository, the exclusion is skipped,
    // and it lands in the commit again.
    //
    // The result is spelled the way git spells paths. `relative` uses the platform
    // separator, `git ls-files --full-name` always answers with forward slashes, and the
    // two are compared to each other and handed to a pathspec — so on Windows the
    // exclusion would miss and the file would be reported as untracked on every run.
    let relativeToRoot: string | undefined;
    if (options.responsePath !== undefined) {
      try {
        const repoRoot = deps.realpath(deps.readRepoRoot());
        relativeToRoot = relative(repoRoot, deps.realpath(resolve(options.responsePath)))
          .split(sep)
          .join("/");
      } catch {
        // The file was readable a moment ago (whoever built `options.response` read it), so
        // failing here means it vanished underneath us. Report it the way every other bad
        // input is reported rather than letting an ENOENT escape the typed-error catch below
        // and crash with a stack trace.
        throw new ResponseError(
          `Cannot locate the response file at ${options.responsePath} — it was readable a moment ago`,
        );
      }
    }
    const responseInRepo =
      relativeToRoot !== undefined &&
      relativeToRoot.length > 0 &&
      !relativeToRoot.startsWith("..") &&
      !isAbsolute(relativeToRoot);
    const exclude = responseInRepo ? [relativeToRoot as string] : [];
    const untrackedFiles = deps
      .readUntrackedFiles()
      .filter((file) => !responseInRepo || file !== relativeToRoot);
    warnings = preflight({
      branch,
      base: options.base,
      commits: repo.commits,
      ticketKey,
      issueVerified,
      pullRequest: existingPr,
      untrackedFiles,
      config,
    }).warnings;

    if (warnings.length > 0) {
      for (const warning of warnings) {
        deps.err(`${warning.check}: ${warning.message}`);
      }
    }

    if (options.mode === "preview") {
      return { code: 0, findings: [], warnings, body, committed: false, pushed: false };
    }

    // Echoing the ids, rather than setting a flag, is what makes this a gate. A caller must
    // have received the warnings to name them, and the set is checked against what pre-flight
    // produces now — so if a review landed or a label was added between the two calls, the
    // ids no longer cover the situation and it closes again.
    const unacknowledged =
      options.acknowledge === "all"
        ? []
        : warnings.filter((warning) => !options.acknowledge.includes(warning.check));

    if (unacknowledged.length > 0) {
      // Neutral on purpose: this message reaches every caller, and the remedy for getting
      // past the gate differs per interface — the CLI has --yes, MCP has acknowledge: [...].
      // Naming a flag that does not exist in the reader's interface is worse than naming
      // none, so each caller supplies its own remedy after the fact instead of this function
      // deciding it: src/cli.ts appends "Re-run with --yes" on a warnings refusal, and
      // src/mcp/result.ts's applyContent already appends its own acknowledge guidance.
      const message =
        `Refusing to proceed. Unacknowledged: ${unacknowledged.map((w) => w.check).join(", ")}`;
      deps.err(message);
      return { code: 2, findings: [], warnings, body, message, committed: false, pushed: false };
    }

    deps.commitAll(response.commitMessage, exclude);
    committed = true;
    deps.pushBranch(branch);
    pushed = true;

    // `gh pr create` refuses outright when an open pull request already exists for this head
    // branch — exactly the state approvals-dismissed/base-mismatch/blocking-label exist to
    // warn about. The push above is the job in that case; stop here instead of letting the
    // create call throw and report a false failure.
    if (existingPr !== null) {
      deps.out(existingPr.url);
      deps.err("Pushed to the existing pull request; it was updated, not opened.");
      return {
        code: 0,
        findings: [],
        warnings,
        body,
        url: existingPr.url,
        updated: true,
        committed: true,
        pushed: true,
      };
    }

    const url = deps.createPullRequest({
      title: response.title,
      body,
      base: options.base,
      head: branch,
    });
    deps.out(url);
    return {
      code: 0,
      findings: [],
      warnings,
      body,
      url,
      updated: false,
      committed: true,
      pushed: true,
    };
  } catch (error) {
    if (
      error instanceof ConfigError ||
      error instanceof ResponseError ||
      error instanceof VcsError ||
      error instanceof JiraError
    ) {
      deps.err(error.message);
      // Only a VcsError thrown by pushBranch or createPullRequest can land here with
      // `committed` true — readRepoState/findPullRequest failures happen before commitAll,
      // and the other error classes can't occur this late in the sequence at all. Guarding on
      // `error instanceof VcsError` anyway keeps the claim tied to the failure it actually
      // describes, not merely to which local ran last.
      if (error instanceof VcsError && committed) {
        deps.err(
          pushed
            ? "A commit was created and already pushed to the remote branch; no pull request was opened. It is yours to keep, amend, or drop."
            : "A commit was created locally and has not been pushed. It is yours to keep, amend, or drop.",
        );
      }
      return { code: 2, findings: [], warnings, body, message: error.message, committed, pushed };
    }
    throw error;
  }
}
