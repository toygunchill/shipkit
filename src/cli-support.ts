// Small, dependency-light helpers factored out of src/cli.ts so they can be unit-tested
// directly. src/cli.ts itself runs `program.parse()` at import time and must not be
// imported from tests.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { ConfigError } from "./config/load.js";
import { discoverConfig, explainDiscovery } from "./config/discover.js";
import { ruleFilesAtBase } from "./prreview/baserules.js";
import { execRunner } from "./vcs/exec.js";
import { fetchIssue, type Fetcher } from "./jira/client.js";
import type { IssueFacts } from "./jira/types.js";
import type { SubmitResult } from "./submit/run.js";
import { parseBody } from "./validate/body.js";
import { jiraToken } from "./secrets/keychain.js";

/** The first key matching `keyPattern` anywhere in `text`, or undefined when there is none. */
export function firstIssueKey(text: string, keyPattern: string): string | undefined {
  const match = new RegExp(keyPattern).exec(text);
  return match?.[0];
}

/** Extracts the issue key embedded in a branch name, e.g. `feature/x/ABC-123-thing`. */
export function ticketFromBranch(branch: string, keyPattern: string): string | undefined {
  return firstIssueKey(branch, keyPattern);
}

/**
 * Fetches Jira facts for `key`, or returns `undefined` without making a network call when
 * there is no key to look up or no token to authenticate with. This is a silent, genuine
 * opt-out for callers that never asked for Jira-backed validation (see `resolveIssue`'s
 * callers in cli.ts for the cases where the caller's *intent* is instead checked explicitly
 * and an unset token is treated as an error).
 */
export async function resolveIssue(
  key: string | undefined,
  config: { jira: { baseUrl: string } },
  fetcher: Fetcher = (url, token) =>
    fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    }).then((response) => {
      if (!response.ok) {
        throw new Error(`Jira responded ${response.status} for ${url}`);
      }
      return response.json();
    }),
  readToken: () => string | undefined | Promise<string | undefined> = jiraToken,
): Promise<IssueFacts | undefined> {
  if (key === undefined) return undefined;
  const token = await readToken();
  if (token === undefined || token.length === 0) return undefined;
  return fetchIssue(config.jira.baseUrl, key, token, fetcher);
}

/**
 * All issue keys cited in the body's issues section, in the order they first appear, with
 * duplicates removed. Returns an empty array when the section is absent or has no matches —
 * the `issue-key-missing` rule in validate/rules.ts is what reports that as a finding; this
 * function just extracts.
 *
 * De-duplication matters because the ordinary citation shape is a markdown link whose text
 * and URL both carry the key — e.g. "- [ABC-1](https://…/browse/ABC-1)" — so a plain regex
 * match on the section would count that one citation twice.
 */
export function extractIssueKeysFromBody(
  body: string,
  config: { jira: { section: string; keyPattern: string } },
): string[] {
  const parsed = parseBody(body);
  const section = parsed.sections[config.jira.section];
  if (section === undefined) return [];
  const matches = section.match(new RegExp(config.jira.keyPattern, "g"));
  return [...new Set(matches ?? [])];
}

/**
 * Chooses which key(s) `check --issue` should actually resolve against Jira for the
 * `issue-level` rule. The body is the source of truth (a caller cannot make an unrelated
 * ticket "cover" a citation it doesn't match); `--issue` narrows the choice only when it
 * names one of the keys the body already cites — e.g. to pick among several.
 */
export function selectIssueKeys(bodyKeys: string[], issueOption: string | undefined): string[] {
  if (issueOption !== undefined && bodyKeys.includes(issueOption)) {
    return [issueOption];
  }
  return bodyKeys;
}

const BASE_PATTERN = /^[A-Za-z0-9._/-]+$/;

/** True when `base` is a plausible ref/branch name — never something git could parse as an option. */
export function isValidBase(base: string): boolean {
  return base.length > 0 && !base.startsWith("-") && BASE_PATTERN.test(base);
}

/**
 * The line the command line adds after a refusal, or nothing when it has no useful remedy.
 *
 * `runSubmit`'s own message is deliberately neutral about which interface is asking — it
 * has no business knowing this caller has a --yes flag, and under the `human` policy --yes
 * cannot help at all (an echoed id is not a person's decision). This is the CLI's own
 * after-the-fact remedy, kept out of the core and driven by `result.refusal` — the exact
 * gate reason — rather than guessed from `code`/`warnings.length`, which also matches
 * "denied", "timed-out", "no-surface" and "human-required" and would send the reader into a
 * --yes retry that reproduces the identical refusal.
 */
export function cliRemedy(result: SubmitResult, yesGiven: boolean): string | undefined {
  if (yesGiven) return undefined;
  if (result.refusal !== "unacknowledged") return undefined;
  return "Re-run with --yes to accept these.";
}

/**
 * Where this run's `.shipkit.yml` is, given the repository it is working on.
 *
 * A relative `--config` is relative to *that repository*, not to the directory the command
 * was typed in: `shipkit brief --repo ../other` has to read the other repository's config,
 * and one long-lived MCP server serves several repositories from one process. An absolute
 * path is left exactly as given.
 *
 * Shared by the CLI and the MCP tools so the two cannot drift: they are two spellings of
 * one product, and a config resolved differently by each is a difference nobody would
 * think to test for.
 */
export function configPath(args: {
  repo: string;
  config?: string | undefined;
  /** The branch this change targets, used only if the working tree carries no config. */
  base?: string | undefined;
  /** Told which branch the rules were borrowed from, so the caller can say so. */
  onBorrow?: ((from: string) => void) | undefined;
}): string {
  // "" is absent too — `??` alone would read it as an explicit path and fail open.
  if (args.config) return isAbsolute(args.config) ? args.config : join(args.repo, args.config);

  // No `--config`: find the file by what it is rather than by what it is called. shipkit
  // used to demand `.shipkit.yml`, which asked every repository to name a file after the
  // tool reading it — see src/config/discover.ts.
  const found = discoverConfig(args.repo);
  if (found.found === "one") return found.path;

  // Two files that both read as a config is the one case with no path to return: picking
  // between them by filename order is exactly the dependency this removes.
  if (found.found === "several") throw new ConfigError(explainDiscovery(found, args.repo));

  // Nothing in the working tree. Before giving up, the branch this change targets: a
  // developer whose branch was cut before the rules landed has a checkout without them,
  // which says nothing about whether the repository has any. The working tree is tried
  // first and deliberately — a branch that is *changing* the rules must be judged by its
  // own version, not by the one it is replacing.
  if (args.base !== undefined && args.base.length > 0) {
    const borrowed = borrowRulesFromBase(args.repo, args.base, args.onBorrow);
    if (borrowed !== undefined) return borrowed;
  }

  // Still nothing. The conventional name is returned rather than a refusal, so the failure
  // comes from `loadConfig` — which reports the path it could not read and names
  // `shipkit init`. A repository that has no config gets one message about it, not two.
  return join(args.repo, ".shipkit.yml");
}

/**
 * Writes the target branch's rule files somewhere they can be loaded as if they were here.
 *
 * A directory rather than text, because `readiness:` resolves against the directory of the
 * config that names it, and every consumer downstream takes a path. Materialising costs one
 * temporary write and leaves the rest of the product untouched.
 *
 * Silent on failure: this is a fallback, and a repository that genuinely has no conventions
 * must hear that from `loadConfig`, once.
 */
function borrowRulesFromBase(
  repo: string,
  base: string,
  onBorrow?: ((from: string) => void) | undefined,
): string | undefined {
  try {
    const git = execRunner("git", repo);
    const run = (args: string[]): string | undefined => {
      try {
        return git(args);
      } catch {
        return undefined;
      }
    };

    const borrowed = ruleFilesAtBase(base, run);
    if (borrowed === undefined) return undefined;

    const directory = mkdtempSync(join(tmpdir(), "shipkit-base-rules-"));
    for (const file of borrowed.files) {
      const at = join(directory, file.name);
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, file.contents, "utf8");
    }
    onBorrow?.(base);
    return join(directory, borrowed.configName);
  } catch {
    return undefined;
  }
}
