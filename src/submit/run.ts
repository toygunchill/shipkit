import { isValidBase, ticketFromBranch } from "../cli-support.js";
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
 * the sequence (`isValidBase`, `ticketFromBranch`, `validate`, `preflight`) are imported
 * directly above instead of injected — they take no dependency worth faking, and every test
 * in tests/submit/run.test.ts exercises the real ones.
 */
export type SubmitDeps = {
  loadConfig: (path: string) => ShipkitConfig;
  loadResponse: (path: string) => SubmitResponse;
  renderBody: (sections: Record<string, string>, config: ShipkitConfig) => string;
  currentBranch: () => string;
  resolveIssue: (key: string | undefined, config: ShipkitConfig) => Promise<IssueFacts | undefined>;
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

  try {
    const config = deps.loadConfig(options.config);
    const response = deps.loadResponse(options.input);
    const body = deps.renderBody(response.sections, config);
    const branch = deps.currentBranch();
    const ticketKey = ticketFromBranch(branch, config.jira.keyPattern);
    const issue = await deps.resolveIssue(ticketKey, config);

    const result = validate({
      title: response.title,
      body,
      config,
      branch,
      issues: issue === undefined ? undefined : [issue],
    });
    if (!result.ok) {
      for (const finding of result.findings) {
        deps.err(`${finding.rule}: ${finding.message}`);
      }
      return 1;
    }

    const repo = deps.readRepoState(options.base);
    const warnings = preflight({
      branch,
      base: options.base,
      commits: repo.commits,
      ticketKey,
      issueVerified: issue !== undefined,
      pullRequest: deps.findPullRequest(branch),
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
    deps.pushBranch(branch);
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
      return 2;
    }
    throw error;
  }
}
