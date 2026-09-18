import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
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
 * `comment` is the one kind shipkit did not say. It is a person writing on a line of the
 * diff, so its `id` is `path:line` and its `message` is the line they wrote it on — which is
 * what lets an agent find the place without the diff in front of it.
 *
 * `readiness` is not a fifth channel — a readiness failure arrives as a finding, a warning
 * or a piece of advice depending on the rule's severity. It is called out separately here
 * because a person ticking a box is choosing between kinds of *thing*, not between shipkit's
 * internal routing: "the team's checklist says no" is a different sort of remark from "the
 * title does not match the pattern", even when both are findings.
 */
export type FixRequestKind = "warning" | "finding" | "readiness" | "advice" | "comment";

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
  kind: z.enum(["warning", "finding", "readiness", "advice", "comment"]),
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
  } catch (error) {
    // Only "there is no file" means there is no selection. A bare `catch` here said the
    // opposite of the paragraph above it: an unreadable file, a `.shipkit/fix-request.json`
    // that is a directory, a permission this user does not have, all came back as `undefined`
    // and the brief went out as though nobody had reviewed anything. Worse, `submit` uses
    // `existsSync` for its exclusion and its archive, so the selection was moved aside having
    // never reached the agent — the person's ten minutes vanished with no trace anywhere.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    const detail = error instanceof Error ? error.message : String(error);
    throw new FixRequestError(`Cannot read the review selection at ${path}: ${detail}`);
  }
  return parseFixRequest(raw, path);
}

/**
 * Writes the selection, creating `.shipkit/` if this is the first review. Returns the path.
 *
 * Failures are wrapped, because the raw `fs` error is not one any caller catches: it passed
 * through `runReview`'s typed catch and through the CLI's, and surfaced as an uncaught stack
 * trace *after* the page had already told the person their selection was sent.
 */
export function writeFixRequest(root: string, request: FixRequest): string {
  const path = join(root, FIX_REQUEST_PATH);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new FixRequestError(`Cannot write the review selection to ${path}: ${detail}`);
  }
  return path;
}

/** `2026-09-17T16:32:11.123Z` spelled so it can be a filename on every filesystem. */
function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * The review-selection file to keep out of the commit: exactly one, always.
 *
 * It was once a list, because consumed selections were archived beside the live file and
 * each archive then needed its own exclusion — measured, with only the live file excluded:
 *
 *   $ git add --all -- :/ ':(exclude,literal,top).shipkit/fix-request.json'
 *   $ git diff --cached --name-only
 *   .shipkit/fix-request-2026-...json      <- the archive, staged
 *
 * The exclusion is passed to `git add --all` and to four scratch-index reads, so a branch
 * reviewed a hundred times carried a hundred extra pathspec arguments toward `ARG_MAX`. The
 * archives moved out of the repository instead (see `archiveDirectory`), which bounds this
 * at one entry forever and costs nothing: nothing inside the repository needs excluding that
 * was never written there.
 *
 * Excluding the whole `.shipkit` directory would also have worked — measured — but would
 * silently stop staging edits to any *tracked* file a repository chooses to keep there, and
 * a commit that quietly omits a file is worse than the leak it prevents.
 */
export function fixRequestExclusions(root: string): string[] {
  return existsSync(join(root, FIX_REQUEST_PATH)) ? [FIX_REQUEST_PATH] : [];
}

/**
 * Where consumed selections are kept: outside the repository, under Application Support.
 *
 * Outside because anything left inside has to be excluded from staging for the rest of the
 * branch's life, and that list is passed on every read — see `fixRequestExclusions`.
 *
 * Application Support rather than Caches because the archive answers "did the agent actually
 * do what was ticked?" after the push, when the brief that carried the notes is gone with the
 * agent's context. The system may purge a cache at any time; that is the wrong contract for
 * evidence.
 *
 * One directory per repository, named for readability and hashed for identity, so two
 * checkouts of the same project — a worktree, a second clone — keep their own history.
 */
export function archiveDirectory(root: string): string {
  const digest = createHash("sha256").update(root).digest("hex").slice(0, 12);
  return join(homedir(), "Library", "Application Support", "shipkit", "fix-requests", `${basename(root)}-${digest}`);
}

/**
 * What became of a selection that was moved aside.
 *
 * Three outcomes rather than `string | undefined`, because two of them were indistinguishable
 * and one of them is permanent: a repository on a volume other than the home volume can never
 * be archived by `rename` at all (`EXDEV`), and the old signature reported that identically to
 * "there was nothing to archive". Every submit failed, silently, forever, and every following
 * brief re-issued instructions the agent had already carried out.
 */
export type ArchiveOutcome =
  | { kind: "none" }
  | { kind: "moved"; path: string }
  | { kind: "failed"; detail: string };

/**
 * Moves a consumed selection aside, timestamped.
 *
 * Moved rather than deleted. The notes are a person's own words about this change, and the
 * archive is the only place left to answer "did the agent actually do what was ticked?"
 * after the push — the brief that carried them is gone with the agent's context. It lands
 * outside the repository (see `archiveDirectory`), so keeping it costs the commit nothing.
 *
 * `rename` first and a copy as the fallback: rename is atomic and cannot half-move a file,
 * but it cannot cross a filesystem, and a checkout on an external disk or a mounted image is
 * exactly that case. Measured on an HFS+ RAM disk: `rename` gave `EXDEV`, the copy succeeded.
 */
export function archiveFixRequest(
  root: string,
  now: Date,
  /** Injected by tests, which must not write into the real Application Support. */
  directory: string = archiveDirectory(root),
  /**
   * Injected by tests too, for the one failure this fallback exists for: `EXDEV` needs two
   * filesystems, and a test suite cannot mount one. Everything else about the fallback —
   * that the copy lands, that the source goes, that the outcome says `moved` — is real.
   */
  rename: (from: string, to: string) => void = renameSync,
): ArchiveOutcome {
  const from = join(root, FIX_REQUEST_PATH);
  // Checked before anything is created: the ordinary case is that there is nothing to
  // archive, and creating a directory to hold a file that will never arrive litters every
  // repository that has never been reviewed.
  if (!existsSync(from)) return { kind: "none" };

  const to = join(directory, `fix-request-${stamp(now)}.json`);
  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    return { kind: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
  try {
    rename(from, to);
    return { kind: "moved", path: to };
  } catch {
    // Fall through to the copy. The rename's own error is not reported: on the one failure
    // that matters it says `EXDEV`, which describes a limit of the call rather than anything
    // a person can act on, and the copy below either succeeds or produces the real reason.
  }
  try {
    copyFileSync(from, to);
    unlinkSync(from);
    return { kind: "moved", path: to };
  } catch (error) {
    // The copy may have landed before the unlink failed. Remove it, so a half-archived
    // selection is not left looking like a completed one beside the live file.
    try {
      if (existsSync(to) && existsSync(from)) unlinkSync(to);
    } catch {
      // Nothing left to try, and the outcome below already says the archive failed.
    }
    // `rmdir` only succeeds on an empty directory, so this removes the directory this call
    // just created and never one holding earlier archives.
    try {
      rmdirSync(directory);
    } catch {
      // It holds earlier archives, or it was never created. Either way, leave it.
    }
    return { kind: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
}
