#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command, CommanderError } from "commander";
import { observedChangedFiles } from "./advice/observe.js";
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
import { issueCreator } from "./jira/create.js";
import { pickSprint } from "./jira/derive.js";
import {
  buildCreatePayload,
  fetchRecentWork,
  PORTFOLIO_FIELD,
  portfolioChildFrom,
  teamFrom,
} from "./jira/techtask.js";
import type { IssueFacts } from "./jira/types.js";
import { jiraToken } from "./secrets/keychain.js";
import { loadResponse, renderBody, ResponseError } from "./submit/response.js";
import { runSubmit, type SubmitDeps } from "./submit/run.js";
import { validate } from "./validate/rules.js";
import {
  currentBranch,
  readHeadSha,
  readPushChangedFiles,
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
      // No exclusion: `brief` runs before there is a response file to keep out of a commit.
      //
      // `observedChangedFiles` because this read can fail on a repository where nothing is
      // wrong with the change — see src/advice/observe.ts. Unguarded, a missing clean-filter
      // binary means no brief is printed at all, which is a gate in everything but name.
      const changed = observedChangedFiles(() => readPushChangedFiles(base));
      const brief = assembleBrief({ repo, target: { branch: base, reason }, config, issue, changed });
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
  readPushChangedFiles: (base, exclude) => readPushChangedFiles(base, exclude, cwd),
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

/**
 * The `techTask` block, ready to paste, with the values measured against the Jira this was
 * built for. Held here rather than in the schema because it is help text, not a default:
 * nothing is ever filled in from it.
 */
const TECH_TASK_BLOCK = `techTask:
  project: DCP
  issueType: Story
  epic: ABC-12154
  summaryPattern: "iOS - {subject} swift ui dönüşümü"
  fields:
    ${PORTFOLIO_FIELD}:
      value: "Commercial"`;

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
    `values if this repository's work does not go to DCP:`,
    "",
    TECH_TASK_BLOCK.split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
    "",
    "  project, issueType   where the item is opened. There is no special technical issue type.",
    "  epic                 optional, and worth setting: half the existing conversion tickets",
    "                       were never attached to theirs.",
    "  summaryPattern       must contain {subject}, which --subject fills in.",
    `  ${PORTFOLIO_FIELD}    Portfolio / Servis Bilgisi, a cascading select. This is its parent,`,
    `                       whose only allowed value is "Commercial".`,
    "",
    "Digital Team, the portfolio child and the sprint are deliberately not in the block: they",
    "differ per person, and .shipkit.yml is committed and shared.",
  ].join("\n");
}

/** The one field in the block that cannot be defaulted or derived, missing on its own. */
function missingPortfolioParent(path: string): string {
  return [
    `The techTask block in ${path} has no ${PORTFOLIO_FIELD}, which Jira requires to create this`,
    "issue, and it has no derivable value — its parent is a fixed choice about the repository.",
    "Nothing was created.",
    "",
    "Add it under techTask.fields:",
    "",
    `    ${PORTFOLIO_FIELD}:`,
    `      value: "Commercial"`,
    "",
    "The child of that cascading field is derived per person, or given with --portfolio.",
  ].join("\n");
}

program
  .command("tech-task")
  .description("Open the technical item for work the ticket did not ask for, or say why it cannot")
  .requiredOption("--subject <text>", "what was converted, as it should read in the summary")
  .option("--config <path>", "path to .shipkit.yml", ".shipkit.yml")
  .option("--team <name>", "Digital Team, instead of deriving it from your recent issues")
  .option("--sprint <id>", 'sprint id, instead of deriving it — or "none" to open it without a sprint')
  .option("--portfolio <child>", "portfolio child, instead of deriving it")
  .option("--dry-run", "print the payload that would be sent and create nothing", false)
  .action(
    async (options: {
      subject: string;
      config: string;
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
        const config = loadConfig(options.config);

        const techTask = config.techTask;
        if (techTask === undefined) {
          console.error(missingTechTaskBlock(options.config));
          process.exitCode = 2;
          return;
        }
        // `Array.isArray` because `typeof [] === "object"`: a YAML list under
        // `customfield_10101:` is not a cascading-select parent, and without this it slips
        // past the refusal and builds a child with no parent value.
        const portfolioParent = techTask.fields?.[PORTFOLIO_FIELD];
        if (
          typeof portfolioParent !== "object" ||
          portfolioParent === null ||
          Array.isArray(portfolioParent)
        ) {
          console.error(missingPortfolioParent(options.config));
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
          const work = await fetchRecentWork(config.jira.baseUrl, token);
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
