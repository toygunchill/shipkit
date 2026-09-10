import { extractIssueKeysFromBody, firstIssueKey, isValidBase } from "../cli-support.js";
import { ConfigError } from "../config/load.js";
import type { ShipkitConfig } from "../config/schema.js";
import { JiraError } from "../jira/client.js";
import type { IssueFacts } from "../jira/types.js";
import { preflight } from "../preflight/checks.js";
import { validate } from "../validate/rules.js";
import { VcsError, type RepoState } from "../vcs/git.js";
import type { PullRequestState } from "../vcs/types.js";
import { ResponseError, type SubmitResponse } from "./response.js";

export type SubmitOptions = {
  input: string;
  base: string;
  config: string;
  yes: boolean;
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
  loadResponse: (path: string) => SubmitResponse;
  renderBody: (sections: Record<string, string>, config: ShipkitConfig) => string;
  currentBranch: () => string;
  resolveIssue: (key: string, config: ShipkitConfig) => Promise<IssueFacts | undefined>;
  readRepoState: (base: string) => RepoState;
  findPullRequest: (branch: string) => PullRequestState | null;
  commitAll: (message: string) => void;
  pushBranch: (branch: string) => void;
  createPullRequest: (input: { title: string; body: string; base: string; head: string }) => string;
  out: (line: string) => void;
  err: (line: string) => void;
};

/**
 * Validate the agent's answer, warn about what pushing will disturb, then commit, push and
 * open the pull request — in that order. Returns the process exit code rather than setting
 * `process.exitCode` and writes through `deps.out`/`deps.err` rather than `console` so the
 * whole sequence, including the parts that mutate the repository, can be driven by fakes in
 * tests instead of a real git checkout.
 */
export async function runSubmit(options: SubmitOptions, deps: SubmitDeps): Promise<number> {
  if (!isValidBase(options.base)) {
    deps.err(`Refusing to use ${JSON.stringify(options.base)} as a base branch`);
    return 2;
  }

  // Tracks how far the mutating tail got before a VcsError escaped, so the error report can
  // say what state the repository was actually left in — a local commit is cheap to keep,
  // amend, or drop, but only telling the reader it exists lets them make that call instead of
  // discovering it themselves the next time `commitAll` fails on "nothing to commit".
  let committed = false;
  let pushed = false;

  try {
    const config = deps.loadConfig(options.config);
    const response = deps.loadResponse(options.input);
    const body = deps.renderBody(response.sections, config);
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
      return 1;
    }

    // The response title's key, not the branch's — titlePattern guarantees the title carries
    // one, which is what foreign-commits needs as this change's identity to compare commits
    // against.
    const ticketKey = firstIssueKey(response.title, config.jira.keyPattern);

    const repo = deps.readRepoState(options.base);
    const existingPr = deps.findPullRequest(branch);
    const warnings = preflight({
      branch,
      base: options.base,
      commits: repo.commits,
      ticketKey,
      issueVerified,
      pullRequest: existingPr,
      config,
    }).warnings;

    if (warnings.length > 0) {
      for (const warning of warnings) {
        deps.err(`${warning.check}: ${warning.message}`);
      }
      if (!options.yes) {
        deps.err("Refusing to proceed. Re-run with --yes to accept these.");
        return 2;
      }
    }

    deps.commitAll(response.commitMessage);
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
      return 0;
    }

    const url = deps.createPullRequest({
      title: response.title,
      body,
      base: options.base,
      head: branch,
    });
    deps.out(url);
    return 0;
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
      return 2;
    }
    throw error;
  }
}
