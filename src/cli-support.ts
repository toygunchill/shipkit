// Small, dependency-light helpers factored out of src/cli.ts so they can be unit-tested
// directly. src/cli.ts itself runs `program.parse()` at import time and must not be
// imported from tests.
import { isAbsolute, join } from "node:path";
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
export function configPath(args: { repo: string; config?: string | undefined }): string {
  // "" is absent too — `??` alone would read it as an explicit path and fail open.
  if (!args.config) return join(args.repo, ".shipkit.yml");
  return isAbsolute(args.config) ? args.config : join(args.repo, args.config);
}
