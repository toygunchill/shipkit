#!/usr/bin/env node
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command, CommanderError } from "commander";
import { observedChangedFiles } from "./advice/observe.js";
import { offerReview, requestApproval } from "./approval/client.js";
import { assembleBrief } from "./brief/assemble.js";
import {
  cliRemedy,
  configPath,
  extractIssueKeysFromBody,
  isValidBase,
  resolveIssue,
  selectIssueKeys,
  ticketFromBranch,
} from "./cli-support.js";
import { ConfigError, loadConfig } from "./config/load.js";
import type { ShipkitConfig } from "./config/schema.js";
import { blockingLabelsFromWorkflow } from "./infer/forge.js";
import { runInit, type InitSources, type MergedPullRequest } from "./init/run.js";
import { fetchIssue, JiraError } from "./jira/client.js";
import { issueCreator } from "./jira/create.js";
import { pickSprint } from "./jira/derive.js";
import {
  buildCreatePayload,
  fetchRecentWork,
  fieldIdsOf,
  missingFieldIds,
  portfolioChildFrom,
  teamFrom,
} from "./jira/techtask.js";
import type { IssueFacts } from "./jira/types.js";
import { applicable, observedPaths } from "./readiness/apply.js";
import { loadReadiness, loadReadinessFiles } from "./readiness/load.js";
import { propose } from "./rules/propose.js";
import { renderRules } from "./rules/render.js";
import { runRules } from "./rules/run.js";
import { askOnTerminal, offerSetup } from "./config/offer.js";
import { surveyRepository } from "./rules/survey.js";
import type { ReadinessRule } from "./readiness/types.js";
import { jiraToken } from "./secrets/keychain.js";
import {
  archiveFixRequest,
  fixRequestExclusions,
  readFixRequest,
  writeFixRequest,
  FixRequestError,
  type FixRequest,
} from "./review/fixrequest.js";
import { runReview, type ReviewDeps } from "./review/run.js";
import { listen } from "./review/server.js";
import { loadResponse, renderBody, ResponseError } from "./submit/response.js";
import { runSubmit, type SubmitDeps } from "./submit/run.js";
import { validate } from "./validate/rules.js";
import {
  currentBranch,
  readHeadSha,
  readPushChangedFiles,
  readPushChangedPaths,
  readPushAddedLines,
  readPushDiff,
  readPushDiffstat,
  readRepoRoot,
  readRepoState,
  readTrackedFiles,
  readUntrackedFiles,
  VcsError,
} from "./vcs/git.js";
import { execRunner } from "./vcs/exec.js";
import { baseCandidates, findPullRequest, type GhRunner } from "./vcs/github.js";
import { commitAll, createPullRequest, pushBranch } from "./vcs/mutate.js";

const program = new Command();
program.name("shipkit").version("0.1.0").exitOverride();

/**
 * Runs `work`, and when the repository has no conventions file, offers to write one.
 *
 * Wrapped around the commands that *read* conventions, never around `init` or `rules`,
 * which are how a repository gets set up in the first place. The offer happens only at a
 * terminal: an agent or a CI job reaching a prompt is a process that hangs — see
 * src/config/offer.ts.
 */
function needsConventions(command: Command): Command {
  return command.hook("preAction", async (_this, actionCommand) => {
    const options = actionCommand.opts<{ repo?: string; config?: string }>();
    // `--config` names a file explicitly, so there is nothing to discover and nothing to
    // offer: if it is wrong, the loader says so in words about that path.
    if (options.config) return;

    let root: string;
    try {
      root = repoOf(options);
    } catch {
      // A bad --repo is the action's to report, in its own words.
      return;
    }

    const outcome = await offerSetup(root, {
      // Both ends, because a prompt needs somewhere to read from and somewhere to show.
      // An agent pipes at least one of them, and a prompt it cannot see is a hang.
      isInteractive: () => process.stdin.isTTY === true && process.stderr.isTTY === true,
      ask: askOnTerminal,
      runInit: async () => runInitHere(root, { config: ".shipkit.yml", force: false, limit: 50 }),
      err: (line: string) => console.error(line),
    });
    if (outcome !== "ready") {
      process.exitCode = 2;
      // Commander has no "stop here" from a hook, and letting the action run would print a
      // second, worse version of what was just explained.
      throw new CommanderError(2, "shipkit.noConventions", "");
    }
  });
}

/**
 * This repository's readiness rules, or `undefined` when it configures none.
 *
 * The path is resolved against the realpath of the config that named it — see
 * src/readiness/load.ts — and every failure from here is a `ConfigError`, which each
 * command below already reports and exits 2 on. That is deliberate: a repository whose
 * rules file is missing or malformed must stop, not quietly proceed with nothing asked.
 */
/**
 * The repository this run works on.
 *
 * `--repo` rather than the process's working directory, because shipkit is installed once
 * and used against many checkouts: a person who has it on their PATH should be able to point
 * it at a repository they are not standing in. Absent, it is the working directory, so every
 * command means exactly what it meant before.
 *
 * Checked here rather than left to git, whose message for a path that is not a directory
 * names neither the option nor the value the person typed.
 */
function repoOf(options: { repo?: string }): string {
  const repo = resolve(options.repo ?? process.cwd());
  if (!existsSync(repo) || !statSync(repo).isDirectory()) {
    throw new ConfigError(`--repo ${options.repo ?? repo} is not a directory`);
  }
  return repo;
}

/**
 * Which readiness checklist this run applies.
 *
 * `--rules` replaces `readiness:` rather than adding to it. A merge would make "apply only
 * this checklist" unexpressible, which is the whole question the option answers, and would
 * read differently depending on whether the target repository happens to configure one at
 * all. Repeating `--rules` applies several, exactly as a list under `readiness:` does.
 *
 * The two resolve differently on purpose. `readiness:` resolves against the realpath of the
 * config that names it — the symlinked-conventions deployment `readinessPath` documents —
 * while `--rules` was typed at a prompt and resolves against the shell's own directory.
 */
function readinessRules(
  configPath: string,
  config: ShipkitConfig,
  rules?: string[] | undefined,
): ReadinessRule[] | undefined {
  if (rules !== undefined && rules.length > 0) {
    return loadReadinessFiles(rules.map((entry) => ({ path: resolve(entry), named: `--rules ${entry}` })));
  }
  return config.readiness === undefined ? undefined : loadReadiness(configPath, config.readiness);
}

needsConventions(program.command("check"))
  .description("Validate a pull-request title and body against .shipkit.yml")
  .requiredOption("--title <title>", "pull-request title")
  .requiredOption("--body-file <path>", "file holding the pull-request body")
  .option("--repo <path>", "the repository to work in", ".")
  .option("--config <path>", "the conventions file; found automatically when omitted")
  .option("--branch <name>", "branch name to validate (defaults to the checked-out branch)")
  .option("--issue <key>", "override which cited issue key to check against Jira")
  .action(async (options: { title: string; bodyFile: string; repo: string; config?: string; branch?: string; issue?: string }) => {
    let body: string;
    try {
      body = readFileSync(options.bodyFile, "utf8");
    } catch {
      console.error(`Cannot read body file at ${options.bodyFile}`);
      process.exitCode = 2;
      return;
    }

    try {
      const root = repoOf(options);
      const config = loadConfig(configPath({ repo: root, config: options.config }));

      let branch = options.branch;
      if (branch === undefined) {
        try {
          branch = currentBranch(root);
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

      // No readiness here, and not by omission: `check` is given a title and a body file
      // and nothing else. There is no response to read answers from, so there is nothing to
      // enforce and no honest way to ask. Readiness lives in `brief` (which carries the
      // questions) and `submit` (which requires the answers) — see src/submit/run.ts.
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

needsConventions(program.command("brief"))
  .description("Emit the JSON brief an agent fills in")
  .option("--base <branch>", "target branch for the pull request")
  .option("--repo <path>", "the repository to work in", ".")
  .option("--config <path>", "the conventions file; found automatically when omitted")
  .option("--rules <path...>", "readiness ruleset(s) to apply, replacing the config's")
  .action(async (options: { base?: string; repo: string; config?: string; rules?: string[] }) => {
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
      const root = repoOf(options);
      const configFile = configPath({ repo: root, config: options.config });
      const config = loadConfig(configFile);

      let base = options.base;
      let reason = "given with --base";
      if (base === undefined) {
        base = baseCandidates(root)[0];
        reason = "repository default branch";
      }

      const repo = readRepoState(base, root);
      const key = ticketFromBranch(repo.branch, config.jira.keyPattern);
      const issue = await resolveIssue(key, config);
      // No exclusion: `brief` runs before there is a response file to keep out of a commit.
      //
      // `observedChangedFiles` because this read can fail on a repository where nothing is
      // wrong with the change — see src/advice/observe.ts. Unguarded, a missing clean-filter
      // binary means no brief is printed at all, which is a gate in everything but name.
      const changed = observedChangedFiles(() => readPushChangedFiles(base, [], root));
      const rules = readinessRules(configFile, config, options.rules);
      // Guarded exactly like the advice observation above, and for the same reason: the
      // scratch-index read fails on repositories where nothing is wrong with the change, and
      // an unguarded call here means no brief is printed at all. The difference is what a
      // failure means. No changed files is no advice; no changed paths is *every* rule
      // carried rather than none — over-asking degrades politely, silence does not.
      const readiness =
        rules === undefined
          ? undefined
          : applicable(rules, observedPaths(() => readPushChangedPaths(base, [], root)));
      // What a person chose in `shipkit review`, if anyone has. Read here, from the
      // repository root rather than from cwd, so a brief asked for from a subdirectory
      // still finds it. A file that exists but cannot be parsed throws `FixRequestError`
      // and stops the command — see src/review/fixrequest.ts for why silence is the one
      // failure this must not have.
      const fixRequest = readFixRequest(readRepoRoot(root));
      const brief = assembleBrief({
        repo,
        target: { branch: base, reason },
        config,
        issue,
        changed,
        ...(readiness === undefined ? {} : { readiness }),
        ...(fixRequest === undefined ? {} : { fixRequest }),
      });
      console.log(JSON.stringify(brief, null, 2));
      process.exitCode = 0;
    } catch (error) {
      if (
        error instanceof ConfigError ||
        error instanceof VcsError ||
        error instanceof JiraError ||
        error instanceof FixRequestError
      ) {
        console.error(error.message);
        process.exitCode = 2;
        return;
      }
      throw error;
    }
  });

function realSubmitDeps(cwd: string): SubmitDeps {
  return {
  loadConfig,
  renderBody,
  currentBranch: () => currentBranch(cwd),
  resolveIssue,
  readRepoState: (base) => readRepoState(base, cwd),
  readPushDiffstat: (base, exclude) => readPushDiffstat(base, exclude, cwd),
  readPushAddedLines: (base, exclude) => readPushAddedLines(base, exclude, cwd),
  readPushChangedFiles: (base, exclude) => readPushChangedFiles(base, exclude, cwd),
  readPushChangedPaths: (base, exclude) => readPushChangedPaths(base, exclude, cwd),
  findPullRequest: (branch) => findPullRequest(branch, cwd),
  readUntrackedFiles: () => readUntrackedFiles(cwd),
  // Read from the repository root, not from cwd: the exclusion is a root-relative pathspec
  // and `shipkit submit` may well be run from a subdirectory.
  fixRequestExclusions: () => fixRequestExclusions(readRepoRoot(cwd)),
  archiveFixRequest: () => archiveFixRequest(readRepoRoot(cwd), new Date()),
  readRepoRoot: () => readRepoRoot(cwd),
  readHeadSha: () => readHeadSha(cwd),
  realpath: (path: string) => realpathSync(path),
  requestApproval: (request, timeoutMs) => requestApproval(request, { timeoutMs }),
  commitAll: (message, exclude) => commitAll(message, exclude, cwd),
  pushBranch: (branch) => pushBranch(branch, cwd),
  createPullRequest: (input) => createPullRequest(input, cwd),
  out: (line: string) => console.log(line),
  err: (line: string) => console.error(line),
  };
}

needsConventions(program.command("submit"))
  .description("Validate the agent's answer, warn, then commit, push and open the pull request")
  .requiredOption("--input <path>", "file holding the agent's answer")
  .requiredOption("--base <branch>", "target branch for the pull request")
  .option("--repo <path>", "the repository to work in", ".")
  .option("--config <path>", "the conventions file; found automatically when omitted")
  .option("--rules <path...>", "readiness ruleset(s) to apply, replacing the config's")
  .option("--yes", "proceed despite pre-flight warnings", false)
  .action(async (options: { input: string; base: string; repo: string; config?: string; rules?: string[]; yes: boolean }) => {
    try {
      const repo = repoOf(options);
      const config = configPath({ repo, config: options.config });
      const response = loadResponse(options.input);
      const result = await runSubmit(
        {
          base: options.base,
          config,
          response,
          responsePath: options.input,
          mode: "apply",
          acknowledge: options.yes ? "all" : [],
        },
        {
          ...realSubmitDeps(repo),
          // Built here and not inside `realSubmitDeps`, which is handed a repository and not
          // a config path. The config is read a second time to learn one optional key; that
          // is cheaper than giving the pure core a path to resolve and a file to open.
          loadReadiness: () => readinessRules(config, loadConfig(config), options.rules),
        },
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
 * The real review dependencies.
 *
 * Every read is the same one `submit` uses, through the same function, which is what makes
 * the page honest. The three that are not shared are the three `submit` has no use for: the
 * patch, the socket, and the two ways of getting a person's attention.
 */
function realReviewDeps(cwd: string, configPath: string, rules: string[] | undefined, notes: string[]): ReviewDeps {
  return {
    loadConfig,
    loadResponse,
    renderBody,
    currentBranch: () => currentBranch(cwd),
    resolveIssue,
    loadReadiness: () => {
      const applied = readinessRules(configPath, loadConfig(configPath), rules);
      if (applied === undefined) {
        // Said on the page rather than left as an absence. A review with no checklist looks
        // exactly like a review whose checklist had nothing to say, and the difference
        // decides whether a person goes looking for one.
        notes.push(
          "No readiness checklist applied to this change — this repository configures none, " +
            "and none was given with --rules. `shipkit rules` can propose one from the code.",
        );
      }
      return applied;
    },
    readRepoState: (base) => readRepoState(base, cwd),
    readPushDiffstat: (base, exclude) => readPushDiffstat(base, exclude, cwd),
    readPushAddedLines: (base, exclude) => readPushAddedLines(base, exclude, cwd),
    readPushChangedFiles: (base, exclude) => readPushChangedFiles(base, exclude, cwd),
    readPushChangedPaths: (base, exclude) => readPushChangedPaths(base, exclude, cwd),
    readPushDiff: (base, exclude) => readPushDiff(base, exclude, cwd),
    readUntrackedFiles: () => readUntrackedFiles(cwd),
    readRepoRoot: () => readRepoRoot(cwd),
    realpath: (path: string) => realpathSync(path),
    // `submit` lets a `gh` failure become exit 2, and it is right to: it is about to push,
    // and a forge it cannot reach is a forge it cannot open a pull request against. `review`
    // pushes nothing, so the same failure is only three pre-flight checks it cannot run —
    // approvals-dismissed, base-mismatch and blocking-label, all of which are about a pull
    // request that may not exist. Refusing to show a person their own diff over that would
    // make the command useless in exactly the repository it is easiest to try it in.
    // The reader is told, on the page, rather than left to wonder.
    findPullRequest: (branch) => {
      try {
        return findPullRequest(branch, cwd);
      } catch (error) {
        notes.push(
          "The forge could not be consulted, so the pre-flight checks about an existing " +
            `pull request did not run (${error instanceof Error ? error.message : String(error)}).`,
        );
        return null;
      }
    },
    fixRequestExclusions: () => fixRequestExclusions(readRepoRoot(cwd)),
    writeFixRequest: (request: FixRequest) => writeFixRequest(readRepoRoot(cwd), request),
    // The same call `submit` makes once it has pushed: a selection that is finished with is
    // kept, not deleted. Ticking nothing is a person saying the earlier list is done.
    clearFixRequest: () => archiveFixRequest(readRepoRoot(cwd), new Date()),
    notes: () => notes,
    listen,
    // The same socket `submit` already uses for approvals. When no application is listening
    // this comes straight back as `no-surface`, which is the ordinary case and changes
    // nothing: the page is a complete answer on its own.
    offerReview,
    // `open` is what macOS uses to hand a URL to the default browser. Detached and ignored:
    // the command's job is to wait for the page, not for the browser process.
    openBrowser: (url: string) => {
      execFile("open", [url], () => undefined);
    },
    // Measured before it was written, because a link the page cannot honour is worse than no
    // link: `xed` is at /usr/bin/xed and its man page documents `-l, --line <number>`; no
    // `x-source`, `vscode`, `txmt`, `mvim` or `idea` URL scheme is registered on this
    // machine (only `x-source-tag`, which is Xcode's documentation anchor scheme and does
    // not open files). So the page gets a button that comes back here, and the equivalent
    // `xed --line N path` printed beside it for anyone whose editor is not Xcode.
    //
    // `--` and a root-relative path resolved against the repository root: the path can only
    // ever be one the diff named (see src/review/server.ts), and this makes that explicit at
    // the point the process is actually started.
    //
    // Absolute path and a timeout, both for the same reason: this call is synchronous and
    // blocks the event loop, so a binary that does not return takes the review's ten-minute
    // timer down with it — the timer cannot fire while the loop is blocked. Resolving `xed`
    // through the inherited PATH would also have made "which program opens the file" depend
    // on the shell the agent happened to launch shipkit from.
    openEditor: (path: string, line: number) => {
      execFileSync(
        "/usr/bin/xed",
        ["--line", String(line), "--", join(readRepoRoot(cwd), path)],
        { stdio: "ignore", timeout: 10_000 },
      );
    },
    now: () => new Date(),
    wait: (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms).unref();
      }),
    out: (line: string) => console.log(line),
    err: (line: string) => console.error(line),
  };
}

needsConventions(program.command("review"))
  .description("Show the change and what shipkit found, and take a person's answer. Pushes nothing.")
  .option("--repo <path>", "the repository to work in", ".")
  .option("--config <path>", "the conventions file; found automatically when omitted")
  .option("--rules <path...>", "readiness ruleset(s) to apply, replacing the config's")
  .option("--base <branch>", "target branch for the pull request")
  .option("--input <path>", "the agent's answer, if one has been drafted")
  .option("--port <n>", "port to serve on; the default asks the kernel for a free one")
  .option("--no-open", "print the URL instead of opening a browser")
  .action(async (options: { repo: string; config?: string; rules?: string[]; base?: string; input?: string; port?: string; open: boolean }) => {
    let port = 0;
    if (options.port !== undefined) {
      const parsed = Number(options.port);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        console.error(`Invalid --port "${options.port}": expected a port number between 1 and 65535`);
        process.exitCode = 2;
        return;
      }
      port = parsed;
    }

    if (options.base !== undefined && !isValidBase(options.base)) {
      console.error(
        `Invalid --base "${options.base}": expected a branch or ref name, not an option`,
      );
      process.exitCode = 2;
      return;
    }

    try {
      // The same resolution `brief` does, and for the same reason: release timing decides the
      // base and the repository does not record it, so the default is the repository's own
      // default branch and anything else has to be said out loud.
      const root = repoOf(options);
      const config = configPath({ repo: root, config: options.config });
      const base = options.base ?? baseCandidates(root)[0];
      if (base === undefined) {
        console.error("Could not work out a base branch. Pass one with --base.");
        process.exitCode = 2;
        return;
      }

      const notes: string[] = [];
      const result = await runReview(
        {
          base,
          config,
          responsePath: options.input,
          port,
          open: options.open,
        },
        realReviewDeps(root, config, options.rules, notes),
      );
      process.exitCode = result.code;
    } catch (error) {
      if (error instanceof ConfigError || error instanceof VcsError || error instanceof JiraError) {
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

/**
 * Writes a starter config, and the readiness checklist beside it.
 *
 * Shared by the `init` command and by the offer a read command makes when a repository has
 * none — the same setup either way, so that accepting the offer is not a lesser version of
 * running the command.
 */
function runInitHere(root: string, options: { config: string; force: boolean; limit: number }): number {
  const result = runInit(
    { config: join(root, options.config), force: options.force, limit: options.limit },
    {
      sources: realInitSources(root),
      // The other half of being set up. `shipkit rules` alone does the same thing; this is
      // here because a person who runs one setup command expects to be set up, and a second
      // half left to be discovered later is discovered by nobody.
      proposeReadiness: () => {
        const survey = surveyRepository({
          trackedPaths: () => readTrackedFiles(root),
          read: (path: string) => {
            try {
              return readFileSync(join(root, path), "utf8");
            } catch {
              return undefined;
            }
          },
        });
        const proposals = propose(survey);
        return proposals.rules.length === 0
          ? undefined
          : renderRules(proposals, survey.files.length, survey.capped);
      },
      exists: (path: string) => existsSync(path),
      write: (path: string, text: string) => writeFileSync(path, text, "utf8"),
      out: (line: string) => console.log(line),
      err: (line: string) => console.error(line),
    },
  );
  return result.code;
}

program
  .command("init")
  .description("Write a starter .shipkit.yml, reading what the forge can prove")
  .option("--repo <path>", "the repository to work in", ".")
  .option("--config <path>", "path to write, relative to --repo", ".shipkit.yml")
  .option("--force", "overwrite an existing config", false)
  .option("--limit <n>", "how many merged pull requests to read", "50")
  .action((options: { repo: string; config: string; force: boolean; limit: string }) => {
    const limit = Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      console.error(`Invalid --limit "${options.limit}": expected a positive whole number`);
      process.exitCode = 2;
      return;
    }

    let root: string;
    try {
      root = repoOf(options);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
      return;
    }
    process.exitCode = runInitHere(root, {
      config: options.config ?? ".shipkit.yml",
      force: options.force,
      limit,
    });
  });

/**
 * The `techTask` block, ready to paste, with the values measured against the Jira this was
 * built for. Held here rather than in the schema because it is help text, not a default:
 * nothing is ever filled in from it.
 */
const TECH_TASK_BLOCK = `techTask:
  project: ABC
  issueType: Story
  summaryPattern: "iOS - {subject} conversion"
  fieldIds:
    portfolio: customfield_10101
    team: customfield_10102
    epic: customfield_10006
    sprint: customfield_10005
  fields:
    customfield_10101:
      value: "<the parent your Jira requires>"`;

/**
 * What to say when the repository has no `techTask` block.
 *
 * Most repositories will not have one — the block is opt-in per project, and an absent one
 * is the ordinary case rather than a mistake. So this says what to add concretely enough to
 * paste, and what each line is for, instead of reporting a missing key and stopping.
 */
function missingTechTaskBlock(path: string): string {
  return [
    `${path} has no techTask block, so shipkit does not know what to open. Nothing was created.`,
    "",
    "Most repositories will not have one; it is opt-in per project. Add this, changing the",
    "values for your own project:",
    "",
    TECH_TASK_BLOCK.split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
    "",
    "  project, issueType   where the item is opened. There is no special technical issue type.",
    "  epic                 optional, and worth setting. Attaching one by hand is the step",
    "                       people forget, which is most of why this command exists.",
    "  summaryPattern       must contain {subject}, which --subject fills in.",
    "  fieldIds             which custom field is which, in your Jira. The ids above are",
    "                       placeholders: a custom field id is assigned per instance, so read",
    "                       yours off an existing issue rather than trusting these. There are",
    "                       no defaults, deliberately — a wrong id writes a real value into the",
    "                       wrong field and nobody finds out.",
    "  fields               the values shipkit cannot derive, such as a cascading select's",
    "                       parent. Its child is derived per person, or given with --portfolio.",
    "",
    "The team, the portfolio child and the sprint are deliberately not in the block: they",
    "differ per person, and .shipkit.yml is committed and shared.",
  ].join("\n");
}

/**
 * Which custom field is which, when the config has not said.
 *
 * Every missing id at once, because a person filling in a config should learn all of what is
 * missing in one run rather than one id per run.
 */
function missingIds(path: string, missing: string[]): string {
  return [
    `The techTask block in ${path} does not say which Jira custom field is ` +
      `${missing.length === 1 ? "its" : "each of"} ${missing.join(", ")}. Nothing was created.`,
    "",
    "A custom field id is assigned by the Jira instance, so shipkit cannot guess one: a wrong",
    "id writes a real value into the wrong field and nobody finds out. Read yours off an",
    "existing issue — `gh api` or the Jira REST browser both show them — and add them under",
    "techTask.fieldIds:",
    "",
    "    fieldIds:",
    "      portfolio: customfield_XXXXX   # a cascading select whose child is derived",
    "      team: customfield_XXXXX        # the team field, derived per person",
    "      epic: customfield_XXXXX        # only needed when epic: is set above",
    "      sprint: customfield_XXXXX      # without it, no sprint is set",
  ].join("\n");
}

/** The one value in the block that cannot be defaulted or derived, missing on its own. */
function missingPortfolioParent(path: string, portfolioId: string): string {
  return [
    `The techTask block in ${path} has no value for ${portfolioId}, which Jira requires to`,
    "create this issue, and it has no derivable one — its parent is a fixed choice about the",
    "repository. Nothing was created.",
    "",
    "Add it under techTask.fields:",
    "",
    `    ${portfolioId}:`,
    `      value: "<the parent your Jira requires>"`,
    "",
    "The child of that cascading field is derived per person, or given with --portfolio.",
  ].join("\n");
}

needsConventions(program.command("tech-task"))
  .description("Open the technical item for work the ticket did not ask for, or say why it cannot")
  .requiredOption("--subject <text>", "what was converted, as it should read in the summary")
  .option("--repo <path>", "the repository to work in", ".")
  .option("--config <path>", "the conventions file; found automatically when omitted")
  .option("--team <name>", "Digital Team, instead of deriving it from your recent issues")
  .option("--sprint <id>", 'sprint id, instead of deriving it — or "none" to open it without a sprint')
  .option("--portfolio <child>", "portfolio child, instead of deriving it")
  .option("--dry-run", "print the payload that would be sent and create nothing", false)
  .action(
    async (options: {
      subject: string;
      repo: string;
      config?: string;
      team?: string;
      sprint?: string;
      portfolio?: string;
      dryRun: boolean;
    }) => {
      const given = (value: string | undefined): string | undefined => {
        const trimmed = value?.trim();
        return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
      };

      const subject = given(options.subject);
      if (subject === undefined) {
        console.error("--subject is empty. It becomes the summary, so it has to say what was converted.");
        process.exitCode = 2;
        return;
      }

      // "none" is how a person says the item belongs to no sprint. Six teams exist and four
      // had an active sprint, so a team with none is ordinary — and without this the sprint
      // refusal would name a flag that person has no id to pass to.
      let sprintId: number | undefined;
      let sprintDecided = false;
      const sprintFlag = given(options.sprint);
      if (sprintFlag !== undefined) {
        sprintDecided = true;
        if (sprintFlag.toLowerCase() !== "none") {
          const parsed = Number(sprintFlag);
          if (!Number.isInteger(parsed) || parsed < 1) {
            console.error(
              `Invalid --sprint "${options.sprint}": expected a sprint id, a positive whole number, or "none".`,
            );
            process.exitCode = 2;
            return;
          }
          sprintId = parsed;
        }
      }

      try {
        const configFile = configPath({ repo: repoOf(options), config: options.config });
        const config = loadConfig(configFile);

        const techTask = config.techTask;
        if (techTask === undefined) {
          console.error(missingTechTaskBlock(configFile));
          process.exitCode = 2;
          return;
        }
        // Before the parent's value, because "which field is the portfolio" has to be
        // answered before "what is in it" can be.
        const absent = missingFieldIds(techTask);
        if (absent.length > 0) {
          console.error(missingIds(configFile, absent));
          process.exitCode = 2;
          return;
        }
        const ids = fieldIdsOf(techTask);

        // `Array.isArray` because `typeof [] === "object"`: a YAML list under the portfolio
        // id is not a cascading-select parent, and without this it slips past the refusal
        // and builds a child with no parent value.
        const portfolioParent = techTask.fields?.[ids.portfolio as string];
        if (
          typeof portfolioParent !== "object" ||
          portfolioParent === null ||
          Array.isArray(portfolioParent)
        ) {
          console.error(missingPortfolioParent(configFile, ids.portfolio as string));
          process.exitCode = 2;
          return;
        }

        let team = given(options.team);
        let portfolioChild = given(options.portfolio);
        const sources = new Map<string, string>();
        if (team !== undefined) sources.set("Digital Team", "given with --team");
        if (portfolioChild !== undefined) sources.set("Portfolio child", "given with --portfolio");
        if (sprintDecided) sources.set("Sprint", "given with --sprint");

        // The derivations read Jira; the create writes to it. A --dry-run that was told all
        // three values needs neither, and must not ask for a token it has no use for.
        const needsDerivation = team === undefined || portfolioChild === undefined || !sprintDecided;
        let token: string | undefined;
        if (needsDerivation || !options.dryRun) {
          token = await jiraToken();
          if (token === undefined || token.length === 0) {
            console.error(
              "tech-task needs a Jira token (set SHIPKIT_JIRA_TOKEN, or sign in to Jira in the " +
                "menu-bar app's Settings pane)." +
                (options.dryRun
                  ? " For a --dry-run, passing --team, --sprint and --portfolio needs no token at all."
                  : ""),
            );
            process.exitCode = 2;
            return;
          }
        }

        // Every refusal is collected before any is printed, so a person who needs two flags
        // learns both at once instead of running the command again to find the second.
        const refusals: { unresolved: string; candidates: string[] }[] = [];
        if (needsDerivation && token !== undefined) {
          const work = await fetchRecentWork(config.jira.baseUrl, token, ids);
          const sampled = `derived from your ${work.sample.length} most recent issues`;

          if (team === undefined) {
            const derived = teamFrom(work.sample);
            if ("value" in derived) {
              team = derived.value;
              sources.set("Digital Team", sampled);
            } else refusals.push(derived);
          }

          if (portfolioChild === undefined) {
            const derived = portfolioChildFrom(work.sample);
            if ("value" in derived) {
              portfolioChild = derived.value;
              sources.set("Portfolio child", sampled);
            } else refusals.push(derived);
          }

          if (!sprintDecided) {
            if (team === undefined) {
              refusals.push({
                unresolved:
                  "The sprint is matched by team name, so it cannot be looked up until the team is. " +
                  "Pass --team, or --sprint with the sprint id.",
                candidates: [],
              });
            } else {
              const derived = pickSprint(work.activeSprints, team);
              if ("value" in derived) {
                sprintId = derived.value;
                sources.set("Sprint", `${sampled}, matched on ${team}`);
              } else refusals.push(derived);
            }
          }
        }

        if (refusals.length > 0) {
          for (const refusal of refusals) {
            console.error(refusal.unresolved);
            if (refusal.candidates.length > 0) {
              console.error(`  What was actually seen, commonest first: ${refusal.candidates.join(", ")}`);
            }
          }
          console.error("Nothing was created.");
          process.exitCode = 2;
          return;
        }
        if (team === undefined || portfolioChild === undefined) {
          // Unreachable: anything still missing here is a refusal, and refusals return above.
          console.error("Nothing was created.");
          process.exitCode = 2;
          return;
        }

        const payload = buildCreatePayload({
          config: techTask,
          subject,
          team,
          portfolioChild,
          ...(sprintId !== undefined ? { sprintId } : {}),
        });

        // Printed before anything is created, every time and not only under --dry-run: this
        // is the one command in shipkit whose effect leaves the repository, and a person
        // reading their scrollback afterwards should be able to see exactly what was sent.
        for (const [field, source] of sources) console.log(`${field}: ${source}`);
        console.log(`POST ${config.jira.baseUrl.replace(/\/$/, "")}/rest/api/2/issue`);
        console.log(JSON.stringify(payload, null, 2));

        if (options.dryRun) {
          console.log("Nothing was created — this was a --dry-run. Run it again without --dry-run to open the item.");
          process.exitCode = 0;
          return;
        }

        const { key } = await issueCreator(config.jira.baseUrl)(payload, token as string);
        console.log(`Created ${key} — ${config.jira.baseUrl.replace(/\/$/, "")}/browse/${key}`);
        process.exitCode = 0;
      } catch (error) {
        if (error instanceof ConfigError || error instanceof JiraError) {
          console.error(error.message);
          process.exitCode = 2;
          return;
        }
        throw error;
      }
    },
  );

program
  .command("rules")
  .description("Propose a readiness ruleset from the code, for a repository that has none")
  .option("--repo <path>", "the repository to read", ".")
  .option("--out <path>", "write here instead of printing")
  .option("--force", "overwrite an existing --out", false)
  .action((options: { repo: string; out?: string; force: boolean }) => {
    try {
      const root = repoOf(options);
      const result = runRules(
        { out: options.out, force: options.force },
        {
          // `git ls-files` decides which files are this repository's code, so a repository
          // that is not a checkout gets git's own refusal rather than a walk of whatever
          // happens to be in the directory.
          survey: () =>
            surveyRepository({
              trackedPaths: () => readTrackedFiles(root),
              read: (path: string) => {
                try {
                  return readFileSync(join(root, path), "utf8");
                } catch {
                  // A git-lfs pointer with no filter installed, a symlink into a directory
                  // that is not checked out. Skipped by the survey, never fatal.
                  return undefined;
                }
              },
            }),
          exists: (path: string) => existsSync(path),
          write: (path: string, text: string) => writeFileSync(path, text, "utf8"),
          out: (line: string) => console.log(line),
          err: (line: string) => console.error(line),
        },
      );
      process.exitCode = result.code;
    } catch (error) {
      if (error instanceof ConfigError || error instanceof VcsError) {
        console.error(error.message);
        process.exitCode = 2;
        return;
      }
      throw error;
    }
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
    // `shipkit.noConventions` is the hook above stopping the run after it has already
    // explained itself. Printing anything more here would be a second, worse telling.
    process.exitCode = isHelpOrVersion ? 0 : 2;
  } else {
    throw error;
  }
}
