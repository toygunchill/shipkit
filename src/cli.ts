#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command, CommanderError } from "commander";
import { assembleBrief } from "./brief/assemble.js";
import { ConfigError, loadConfig } from "./config/load.js";
import { fetchIssue, JiraError } from "./jira/client.js";
import type { IssueFacts } from "./jira/types.js";
import { validate } from "./validate/rules.js";
import { readRepoState } from "./vcs/git.js";
import { baseCandidates } from "./vcs/github.js";
import { VcsError } from "./vcs/types.js";

const program = new Command();
program.name("shipkit").version("0.1.0").exitOverride();

function ticketFromBranch(branch: string, keyPattern: string): string | undefined {
  const match = new RegExp(keyPattern).exec(branch);
  return match?.[0];
}

async function resolveIssue(
  key: string | undefined,
  config: { jira: { baseUrl: string } },
): Promise<IssueFacts | undefined> {
  if (key === undefined) return undefined;
  const token = process.env.SHIPKIT_JIRA_TOKEN;
  if (token === undefined || token.length === 0) return undefined;
  return fetchIssue(config.jira.baseUrl, key, token);
}

program
  .command("check")
  .description("Validate a pull-request title and body against .shipkit.yml")
  .requiredOption("--title <title>", "pull-request title")
  .requiredOption("--body-file <path>", "file holding the pull-request body")
  .option("--config <path>", "path to .shipkit.yml", ".shipkit.yml")
  .option("--branch <name>", "branch name to validate")
  .option("--issue <key>", "issue key cited by this change")
  .action(async (options: { title: string; bodyFile: string; config: string; branch?: string; issue?: string }) => {
    let body: string;
    try {
      body = readFileSync(options.bodyFile, "utf8");
    } catch {
      console.error(`Cannot read body file at ${options.bodyFile}`);
      process.exit(2);
    }

    try {
      const config = loadConfig(options.config);
      const issue = await resolveIssue(options.issue, config);
      const result = validate({
        title: options.title,
        body,
        config,
        branch: options.branch,
        issues: issue === undefined ? undefined : [issue],
      });
      if (result.ok) {
        console.log("ok");
        process.exit(0);
      }
      for (const finding of result.findings) {
        console.error(`${finding.rule}: ${finding.message}`);
      }
      process.exit(1);
    } catch (error) {
      if (error instanceof ConfigError || error instanceof JiraError) {
        console.error(error.message);
        process.exit(2);
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
      process.exit(2);
    }

    try {
      const config = loadConfig(options.config);

      let base = options.base;
      let reason = "given with --base";
      if (base === undefined) {
        base = baseCandidates()[0];
        reason = "repository default branch";
      }

      const repo = readRepoState(base);
      const key = ticketFromBranch(repo.branch, config.jira.keyPattern);
      const issue = await resolveIssue(key, config);
      const brief = assembleBrief({ repo, target: { branch: base, reason }, config, issue });
      console.log(JSON.stringify(brief, null, 2));
      process.exit(0);
    } catch (error) {
      if (error instanceof ConfigError || error instanceof VcsError || error instanceof JiraError) {
        console.error(error.message);
        process.exit(2);
      }
      throw error;
    }
  });

try {
  program.parse();
} catch (error) {
  if (error instanceof CommanderError) {
    const isHelpOrVersion =
      error.code === "commander.helpDisplayed" || error.code === "commander.version";
    process.exit(isHelpOrVersion ? 0 : 2);
  }
  throw error;
}
