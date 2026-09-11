#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { Command, CommanderError } from "commander";
import { assembleBrief } from "./brief/assemble.js";
import {
  extractIssueKeysFromBody,
  isValidBase,
  resolveIssue,
  selectIssueKeys,
  ticketFromBranch,
} from "./cli-support.js";
import { ConfigError, loadConfig } from "./config/load.js";
import { fetchIssue, JiraError } from "./jira/client.js";
import type { IssueFacts } from "./jira/types.js";
import { loadResponse, renderBody, ResponseError } from "./submit/response.js";
import { runSubmit, type SubmitDeps } from "./submit/run.js";
import { validate } from "./validate/rules.js";
import { currentBranch, readRepoRoot, readRepoState, readUntrackedFiles, VcsError } from "./vcs/git.js";
import { baseCandidates, findPullRequest } from "./vcs/github.js";
import { commitAll, createPullRequest, pushBranch } from "./vcs/mutate.js";

const program = new Command();
program.name("shipkit").version("0.1.0").exitOverride();

program
  .command("check")
  .description("Validate a pull-request title and body against .shipkit.yml")
  .requiredOption("--title <title>", "pull-request title")
  .requiredOption("--body-file <path>", "file holding the pull-request body")
  .option("--config <path>", "path to .shipkit.yml", ".shipkit.yml")
  .option("--branch <name>", "branch name to validate (defaults to the checked-out branch)")
  .option("--issue <key>", "override which cited issue key to check against Jira")
  .action(async (options: { title: string; bodyFile: string; config: string; branch?: string; issue?: string }) => {
    let body: string;
    try {
      body = readFileSync(options.bodyFile, "utf8");
    } catch {
      console.error(`Cannot read body file at ${options.bodyFile}`);
      process.exitCode = 2;
      return;
    }

    try {
      const config = loadConfig(options.config);

      let branch = options.branch;
      if (branch === undefined) {
        try {
          branch = currentBranch();
        } catch {
          // Not a git repository, or git is unavailable — branch-pattern silently
          // does not run rather than failing the whole command.
          branch = undefined;
        }
      }

      let issues: IssueFacts[] | undefined;
      if (options.issue !== undefined) {
        const token = process.env.SHIPKIT_JIRA_TOKEN;
        if (token === undefined || token.length === 0) {
          console.error(
            "issue-level validation was requested with --issue, but SHIPKIT_JIRA_TOKEN is unset",
          );
          process.exitCode = 2;
          return;
        }
        const bodyKeys = extractIssueKeysFromBody(body, config);
        const keys = selectIssueKeys(bodyKeys, options.issue);
        issues = await Promise.all(keys.map((key) => fetchIssue(config.jira.baseUrl, key, token)));
      }

      const result = validate({ title: options.title, body, config, branch, issues });
      if (result.ok) {
        console.log("ok");
        process.exitCode = 0;
        return;
      }
      for (const finding of result.findings) {
        console.error(`${finding.rule}: ${finding.message}`);
      }
      process.exitCode = 1;
    } catch (error) {
      if (error instanceof ConfigError || error instanceof JiraError) {
        console.error(error.message);
        process.exitCode = 2;
        return;
      }
      throw error;
    }
  });

program
  .command("brief")
  .description("Emit the JSON brief an agent fills in")
  .option("--base <branch>", "target branch for the pull request")
  .option("--config <path>", "path to .shipkit.yml", ".shipkit.yml")
  .action(async (options: { base?: string; config: string }) => {
    if (options.base === undefined && !process.stdin.isTTY) {
      console.error(
        "--base is required when stdin is not a terminal. Valid targets are the repository's " +
          "default branch or an active release/* branch — pass one explicitly with --base.",
      );
      process.exitCode = 2;
      return;
    }

    if (options.base !== undefined && !isValidBase(options.base)) {
      console.error(
        `Invalid --base "${options.base}": expected a branch or ref name, not an option`,
      );
      process.exitCode = 2;
      return;
    }

    try {
      const config = loadConfig(options.config);

      let base = options.base;
      let reason = "given with --base";
      if (base === undefined) {
        const cwd = process.cwd();
        base = baseCandidates(cwd)[0];
        reason = "repository default branch";
      }

      const repo = readRepoState(base);
      const key = ticketFromBranch(repo.branch, config.jira.keyPattern);
      const issue = await resolveIssue(key, config);
      const brief = assembleBrief({ repo, target: { branch: base, reason }, config, issue });
      console.log(JSON.stringify(brief, null, 2));
      process.exitCode = 0;
    } catch (error) {
      if (error instanceof ConfigError || error instanceof VcsError || error instanceof JiraError) {
        console.error(error.message);
        process.exitCode = 2;
        return;
      }
      throw error;
    }
  });

const cwd = process.cwd();

const realSubmitDeps: SubmitDeps = {
  loadConfig,
  renderBody,
  currentBranch,
  resolveIssue,
  readRepoState,
  findPullRequest: (branch) => findPullRequest(branch, cwd),
  readUntrackedFiles,
  readRepoRoot,
  realpath: (path: string) => realpathSync(path),
  commitAll: (message, exclude) => commitAll(message, exclude, cwd),
  pushBranch: (branch) => pushBranch(branch, cwd),
  createPullRequest: (input) => createPullRequest(input, cwd),
  out: (line: string) => console.log(line),
  err: (line: string) => console.error(line),
};

program
  .command("submit")
  .description("Validate the agent's answer, warn, then commit, push and open the pull request")
  .requiredOption("--input <path>", "file holding the agent's answer")
  .requiredOption("--base <branch>", "target branch for the pull request")
  .option("--config <path>", "path to .shipkit.yml", ".shipkit.yml")
  .option("--yes", "proceed despite pre-flight warnings", false)
  .action(async (options: { input: string; base: string; config: string; yes: boolean }) => {
    try {
      const response = loadResponse(options.input);
      const result = await runSubmit(
        {
          base: options.base,
          config: options.config,
          response,
          responsePath: options.input,
          yes: options.yes,
        },
        realSubmitDeps,
      );
      process.exitCode = result.code;
    } catch (error) {
      if (error instanceof ResponseError) {
        console.error(error.message);
        process.exitCode = 2;
        return;
      }
      throw error;
    }
  });

try {
  // parseAsync (not parse) so that a rejection from an async action's `throw error` — an
  // internal bug, not a validation finding — surfaces here instead of becoming an unhandled
  // promise rejection that bypasses this try/catch entirely.
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError) {
    const isHelpOrVersion =
      error.code === "commander.helpDisplayed" || error.code === "commander.version";
    process.exitCode = isHelpOrVersion ? 0 : 2;
  } else {
    throw error;
  }
}
