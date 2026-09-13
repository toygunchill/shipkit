#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command, CommanderError } from "commander";
import { requestApproval } from "./approval/client.js";
import { assembleBrief } from "./brief/assemble.js";
import {
  cliRemedy,
  extractIssueKeysFromBody,
  isValidBase,
  resolveIssue,
  selectIssueKeys,
  ticketFromBranch,
} from "./cli-support.js";
import { ConfigError, loadConfig } from "./config/load.js";
import { blockingLabelsFromWorkflow } from "./infer/forge.js";
import { runInit, type InitSources, type MergedPullRequest } from "./init/run.js";
import { fetchIssue, JiraError } from "./jira/client.js";
import type { IssueFacts } from "./jira/types.js";
import { jiraToken } from "./secrets/keychain.js";
import { loadResponse, renderBody, ResponseError } from "./submit/response.js";
import { runSubmit, type SubmitDeps } from "./submit/run.js";
import { validate } from "./validate/rules.js";
import {
  currentBranch,
  readHeadSha,
  readPushDiffstat,
  readRepoRoot,
  readRepoState,
  readUntrackedFiles,
  VcsError,
} from "./vcs/git.js";
import { execRunner } from "./vcs/exec.js";
import { baseCandidates, findPullRequest, type GhRunner } from "./vcs/github.js";
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
        // Same source `submit` reads from: the environment variable first, the
        // approval surface's socket as the fallback for a token saved through its
        // Settings pane. A direct `process.env` read here would leave that pane
        // unable to satisfy this subcommand even though it satisfies every other.
        const token = await jiraToken();
        if (token === undefined || token.length === 0) {
          console.error(
            "issue-level validation was requested with --issue, but no Jira token is available " +
              "(set SHIPKIT_JIRA_TOKEN, or sign in to Jira in the menu-bar app's Settings pane)",
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
  readPushDiffstat: (base, exclude) => readPushDiffstat(base, exclude, cwd),
  findPullRequest: (branch) => findPullRequest(branch, cwd),
  readUntrackedFiles,
  readRepoRoot,
  readHeadSha: () => readHeadSha(cwd),
  realpath: (path: string) => realpathSync(path),
  requestApproval: (request, timeoutMs) => requestApproval(request, { timeoutMs }),
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
          mode: "apply",
          acknowledge: options.yes ? "all" : [],
        },
        realSubmitDeps,
      );
      // cliRemedy (src/cli-support.ts) is this interface's own after-the-fact remedy,
      // kept out of the core and testable without a subprocess — the core's own message
      // has no business knowing this caller has a --yes flag, and under the `human`
      // approval policy --yes cannot help at all.
      const remedy = cliRemedy(result, options.yes);
      if (remedy !== undefined) {
        console.error(remedy);
      }
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

/**
 * The workflow that gates a merge on a pull-request label, read from the checkout
 * rather than fetched from the forge: the file is already on disk beside the
 * caller, so reading it there needs no network round trip and no authentication —
 * which matters, because the repository most in need of `init` is the one whose
 * forge this machine cannot reach.
 *
 * `InitSources.mergeGateWorkflow` returns one document, so when several workflows
 * gate on labels the first that actually gates is the one read. Concatenating them
 * is not an option: two YAML documents joined are not one YAML document, and the
 * parser would reject the pair after accepting either alone.
 *
 * Mentioning `pull_request.labels` is not the same as gating on one — a nightly
 * that only runs on a schedule, or a job whose condition is `!contains(...)` and
 * so runs when the label is *absent*, both mention it. The parser decides, so that
 * picking the first such file cannot cost us a real gate in a later one.
 */
function mergeGateWorkflow(cwd: string): string | undefined {
  let root = cwd;
  try {
    root = readRepoRoot(cwd);
  } catch {
    // Not a git checkout. Look beside the caller rather than giving up: `init` is
    // for repositories that have not been set up yet.
  }
  const dir = join(root, ".github", "workflows");
  if (!existsSync(dir)) return undefined;
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    const text = readFileSync(join(dir, name), "utf8");
    if (!text.includes("pull_request.labels")) continue;
    if (blockingLabelsFromWorkflow(text) !== undefined) return text;
  }
  return undefined;
}

/**
 * The real sources, shelling out through the same `GhRunner` seam the rest of the
 * tool uses rather than a second way to call `gh`. Each one may throw — no remote,
 * no `gh` on the path, no permission on a private server — and `runInit` is built
 * to expect exactly that.
 */
function realInitSources(cwd: string): InitSources {
  const gh: GhRunner = execRunner("gh", cwd);
  return {
    rulesets: () => JSON.parse(gh(["api", "repos/{owner}/{repo}/rulesets"])) as unknown,
    mergeGateWorkflow: () => mergeGateWorkflow(cwd),
    // The author comes back with the body so that `runInit` can leave bot merges
    // out of the sample. `gh` reports `author.is_bot`, which is carried through
    // rather than re-derived here — the login is passed along too, for the
    // accounts the forge does not flag.
    mergedPullRequests: (limit: number) => {
      const raw = gh([
        "pr",
        "list",
        "--state",
        "merged",
        "--json",
        "body,author",
        "--limit",
        String(limit),
      ]);
      const list = JSON.parse(raw) as unknown;
      if (!Array.isArray(list)) {
        throw new Error("gh pr list --json body,author did not return an array");
      }
      return list.flatMap((item): MergedPullRequest[] => {
        if (typeof item !== "object" || item === null) return [];
        const { body, author } = item as { body?: unknown; author?: unknown };
        if (typeof body !== "string" || body.trim().length === 0) return [];
        const who =
          typeof author === "object" && author !== null
            ? (author as { login?: unknown; is_bot?: unknown })
            : {};
        return [
          {
            body,
            ...(typeof who.login === "string" ? { author: who.login } : {}),
            ...(typeof who.is_bot === "boolean" ? { authorIsBot: who.is_bot } : {}),
          },
        ];
      });
    },
  };
}

program
  .command("init")
  .description("Write a starter .shipkit.yml, reading what the forge can prove")
  .option("--config <path>", "path to write", ".shipkit.yml")
  .option("--force", "overwrite an existing config", false)
  .option("--limit <n>", "how many merged pull requests to read", "50")
  .action((options: { config: string; force: boolean; limit: string }) => {
    const limit = Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      console.error(`Invalid --limit "${options.limit}": expected a positive whole number`);
      process.exitCode = 2;
      return;
    }

    const result = runInit(
      { config: options.config, force: options.force, limit },
      {
        sources: realInitSources(cwd),
        exists: (path: string) => existsSync(path),
        write: (path: string, text: string) => writeFileSync(path, text, "utf8"),
        out: (line: string) => console.log(line),
        err: (line: string) => console.error(line),
      },
    );
    process.exitCode = result.code;
  });

program
  .command("mcp")
  .description("Serve the shipkit tools to an agent over stdio")
  .action(async () => {
    const { serveStdio } = await import("./mcp/server.js");
    await serveStdio();
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
