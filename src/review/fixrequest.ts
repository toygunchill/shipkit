import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * The selection a person made in `shipkit review`, on its way to the next `brief`.
 *
 * This file is shipkit's own hand-off, never part of the change — the same status the
 * response file has, and it gets the same protection: every read the push is measured from,
 * and the commit itself, are told to exclude it. See `fixRequestExclusions` below for the
 * measurement behind the exact shape of that exclusion.
 */

export class FixRequestError extends Error {}

/** The directory shipkit keeps its own working files in, relative to the repository root. */
export const SHIPKIT_DIR = ".shipkit";

/** Where `shipkit review` writes, and where `shipkit brief` looks. Root-relative, git-spelled. */
export const FIX_REQUEST_PATH = `${SHIPKIT_DIR}/fix-request.json`;

/**
 * Which channel an item came out of.
 *
 * `readiness` is not a fifth channel — a readiness failure arrives as a finding, a warning
 * or a piece of advice depending on the rule's severity. It is called out separately here
 * because a person ticking a box is choosing between kinds of *thing*, not between shipkit's
 * internal routing: "the team's checklist says no" is a different sort of remark from "the
 * title does not match the pattern", even when both are findings.
 */
export type FixRequestKind = "warning" | "finding" | "readiness" | "advice";

export type FixRequestItem = {
  kind: FixRequestKind;
  /** The check id, rule id or topic — whatever the channel spells it as. */
  id: string;
  message: string;
  /** What the person wants done about it. Empty when they ticked the box and said nothing. */
  note: string;
};

export type FixRequest = {
  version: 1;
  createdAt: string;
  base: string;
  branch: string;
  items: FixRequestItem[];
};

const itemSchema = z.object({
  kind: z.enum(["warning", "finding", "readiness", "advice"]),
  id: z.string().min(1),
  message: z.string(),
  note: z.string(),
});

const schema = z.object({
  // Pinned rather than defaulted, for the reason src/readiness/load.ts pins its own: a
  // `version: 2` written by a later shipkit must not be half-read by this one.
  version: z.literal(1),
  createdAt: z.string().min(1),
  base: z.string(),
  branch: z.string(),
  items: z.array(itemSchema),
});

export function parseFixRequest(raw: string, where: string): FixRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new FixRequestError(`Cannot parse the review selection at ${where}: ${detail}`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new FixRequestError(`Invalid review selection at ${where}: ${detail}`);
  }
  return result.data;
}

/**
 * The selection waiting at `root`, or `undefined` when there is none.
 *
 * A file that exists but cannot be read throws, and every caller reports that and stops.
 * Degrading to `undefined` was rejected: the whole point of the file is that a person chose
 * what is in it, and quietly proceeding as though they had chosen nothing is the one
 * failure mode this feature cannot have.
 */
export function readFixRequest(root: string): FixRequest | undefined {
  const path = join(root, FIX_REQUEST_PATH);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  return parseFixRequest(raw, path);
}

/** Writes the selection, creating `.shipkit/` if this is the first review. Returns the path. */
export function writeFixRequest(root: string, request: FixRequest): string {
  const path = join(root, FIX_REQUEST_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  return path;
}

/** `2026-09-17T16:32:11.123Z` spelled so it can be a filename on every filesystem. */
function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * Every review-selection file under `root`, root-relative and git-spelled, for the staging
 * exclusion.
 *
 * The archives are here as well as the live file, and that is not belt-and-braces. Measured,
 * in a scratch repository, with only the live file excluded:
 *
 *   $ git add --all -- :/ ':(exclude,literal,top).shipkit/fix-request.json'
 *   $ git diff --cached --name-only
 *   .shipkit.yml
 *   .shipkit/fix-request.2026.json      <- the archive, staged
 *   a.txt
 *
 * So archiving a consumed selection inside the repository re-creates, one run later,
 * exactly the leak the exclusion exists to close.
 *
 * Excluding the whole directory (`:(exclude,literal,top).shipkit`) also works — measured, it
 * keeps both files out and leaves `.shipkit.yml` staged, because a literal pathspec matches
 * at path boundaries and `.shipkit.yml` is not inside `.shipkit/`. It is not used because it
 * would also stop staging edits to any *tracked* file a repository chooses to keep there,
 * silently, and a commit that quietly omits a file is worse than the leak it prevents.
 *
 * Nothing is returned when the directory does not exist, which is every repository that has
 * never been reviewed — so an ordinary `submit` passes exactly the exclusions it always did.
 */
export function fixRequestExclusions(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(root, SHIPKIT_DIR));
  } catch {
    return [];
  }
  return entries
    .filter((name) => name === "fix-request.json" || /^fix-request-.+\.json$/.test(name))
    .sort()
    .map((name) => `${SHIPKIT_DIR}/${name}`);
}

/**
 * Moves a consumed selection aside, timestamped. Returns where it went, or `undefined` when
 * there was nothing to move.
 *
 * Moved rather than deleted. The notes are a person's own words about this change, and the
 * archive is the only place left to answer "did the agent actually do what was ticked?"
 * after the push — the brief that carried them is gone with the agent's context. The cost of
 * keeping it is the staging leak measured in `fixRequestExclusions` above, and that is a
 * cost this file already pays for the live selection.
 */
export function archiveFixRequest(root: string, now: Date): string | undefined {
  const from = join(root, FIX_REQUEST_PATH);
  const to = join(root, SHIPKIT_DIR, `fix-request-${stamp(now)}.json`);
  try {
    renameSync(from, to);
  } catch {
    // No selection to archive is the ordinary case — every submit that was never reviewed.
    // A rename that fails for any other reason is not worth failing a completed push over:
    // the push has already landed, and the worst outcome is a stale selection the next
    // `brief` carries again, which a person can see and delete.
    return undefined;
  }
  return to;
}
