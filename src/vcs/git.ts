import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangedFile } from "../advice/uikit.js";
import { asVcsError, execRunner } from "./exec.js";
import { stagingPathspec } from "./mutate.js";
import { VcsError, type RepoState } from "./types.js";

export { VcsError };
export type { RepoState };

function git(args: string[], cwd: string): string {
  return execRunner("git", cwd)(args);
}

/**
 * The same call with `GIT_INDEX_FILE` pointed at a scratch index, so a staging
 * question can be asked without disturbing the index the person is working in.
 * `execRunner` has no seam for the environment, and giving it one would put an
 * environment parameter on every read in this module for the sake of one.
 */
function gitWithIndex(args: string[], cwd: string, indexFile: string): string {
  return asVcsError("git", args, () =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_INDEX_FILE: indexFile },
    }),
  );
}

export function currentBranch(cwd: string = process.cwd()): string {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], cwd).trim();
}

export function readRepoState(base: string, cwd: string = process.cwd()): RepoState {
  const diffRange = `${base}...HEAD`;
  const logRange = `${base}..HEAD`;
  // `--end-of-options` forces git to treat everything after it as a revision/pathspec, never
  // an option — without it, a `base` starting with `-` (e.g. `--output=/tmp/x`) is parsed as a
  // git flag instead of a ref, letting a caller-controlled string make git write files.
  return {
    branch: currentBranch(cwd),
    changedFiles: git(["diff", "--name-only", "--end-of-options", diffRange], cwd)
      .split("\n")
      .filter(Boolean),
    diffstat: git(["diff", "--stat", "--end-of-options", diffRange], cwd).trim(),
    commits: git(["log", "--format=%s", "--end-of-options", logRange], cwd)
      .split("\n")
      .filter(Boolean),
  };
}

/**
 * The diffstat of what pushing this branch will actually deliver, measured against the
 * merge base with `base` — the committed work *plus* everything `commitAll` is about to
 * sweep in, untracked files included, minus the paths `exclude` keeps out.
 *
 * `readRepoState`'s diffstat answers a different question: `git diff --stat base...HEAD`
 * is committed work only. On the branch this exists for — an agent making four hundred
 * files of uncommitted changes on a fresh branch off `develop` — that range is empty, the
 * panel renders a blank line where the size of the change belongs, and a person approves
 * a push whose size was never shown to them.
 *
 * `git diff --stat` cannot see untracked files at all, so the tree that `git add --all`
 * would produce is built for real, in a scratch index:
 *
 *   - `read-tree <merge-base>` seeds it with what the base already has;
 *   - `add --all` with `commitAll`'s own pathspec applies exactly the staging rules the
 *     commit will apply — `.gitignore`, `core.excludesFile`, the exclusions, all of it,
 *     by construction rather than by a second implementation that can drift;
 *   - `diff --cached <merge-base>` states the difference between the two.
 *
 * `git add --intent-to-add` was tried first and is wrong: measured, `add --all -N` removes
 * the index entry for a file deleted in the working tree, so the deletion vanishes from
 * the stat entirely — an under-report, in the one direction that matters.
 *
 * The scratch index lives outside the repository. Also measured: written beside `.git` it
 * is itself an untracked file, so `add --all` swept the index and its lock into the very
 * stat being computed.
 *
 * The real index and working tree are untouched. `add` does write blobs into the object
 * database, which is the price of asking git what a commit would contain; they are
 * unreferenced and collected like any other.
 */
export function readPushDiffstat(
  base: string,
  exclude: string[] = [],
  cwd: string = process.cwd(),
): string {
  // Only `base` is caller-controlled, and `--end-of-options` is what stops a `--output=`
  // spelling of it from turning a read into a write. Everything downstream is the resolved
  // object id this returns.
  const mergeBase = git(["merge-base", "--end-of-options", base, "HEAD"], cwd).trim();
  const pathspec = stagingPathspec(exclude);
  const scratch = mkdtempSync(join(tmpdir(), "shipkit-index-"));
  const index = join(scratch, "index");
  try {
    gitWithIndex(["read-tree", "--end-of-options", mergeBase], cwd, index);
    gitWithIndex(["add", "--all", ...pathspec], cwd, index);
    return gitWithIndex(
      // `--no-relative` overrides `diff.relative`. That config makes git print paths (and
      // count "N files changed") relative to `cwd` even with an explicit `:/` pathspec —
      // measured, not assumed: from a subdirectory, with `diff.relative` set, a file outside
      // cwd drops out of the stat entirely rather than just displaying oddly. `readUntrackedFiles`
      // above fends off the same axis with `:/` and `--full-name`; `:/` alone doesn't reach here.
      ["diff", "--cached", "--stat", "--no-relative", "--end-of-options", mergeBase, ...pathspec],
      cwd,
      index,
    ).trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The only paths that can carry the UIKit-to-SwiftUI signal. `detectConversion` reads
 * whole file contents, so the restriction is not cosmetic: without it a four-hundred-file
 * push would have every blob on both sides read out of the object database to prove that
 * a `.json` is still not a view controller.
 *
 * `glob` makes `**` mean "any number of directories" rather than falling back to git's
 * default matching, and `top` anchors it at the repository root so the answer does not
 * depend on which directory shipkit was invoked from. Measured against real git: the
 * `.swift` entry matches a root-level `Top.swift` as well as `Sub/Deep/Nested.swift`, and
 * gives the same two answers run from the root and run from `Sub/`.
 */
const CONVERTIBLE_PATHSPEC = [".swift", ".xib", ".storyboard"].map(
  (extension_) => `:(glob,top)**/*${extension_}`,
);

/** git's one-letter `--name-status` codes, narrowed to what `ChangedFile` models. A
 *  type-change (`T`) or anything else unexpected reads as a modification, which is the
 *  answer that makes `detectConversion` look at both sides rather than assume one. */
function changeStatus(code: string): ChangedFile["status"] {
  if (code.startsWith("A")) return "added";
  if (code.startsWith("D")) return "deleted";
  return "modified";
}

/**
 * Reads a blob, or the empty string when there isn't one.
 *
 * Never throwing is the contract, not a convenience: an added file has no `before` and a
 * deleted one has no `after`, and both are the ordinary case rather than an error. This is
 * the *only* rule that produces an empty side — the caller does not also branch on the
 * status letter, which would leave this catch unreachable and untested while the code read
 * as though it were what guaranteed the behaviour.
 *
 * The catch is deliberately total. A blob too large for `execFileSync`'s buffer lands here
 * too, and an empty side makes `detectConversion` say nothing — the direction this whole
 * feature errs in, by design.
 */
function readBlob(spec: string, cwd: string, indexFile: string): string {
  try {
    return execFileSync("git", ["cat-file", "blob", spec], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_INDEX_FILE: indexFile },
    });
  } catch {
    return "";
  }
}

/**
 * The `.swift`, `.xib` and `.storyboard` files this push will deliver, with the text on
 * both sides, for `detectConversion` to read.
 *
 * Measured against the merge base and through the same scratch index `readPushDiffstat`
 * builds, for the same reason: `commitAll` runs `git add --all` *after* the gate, so the
 * conversion an agent has just written and not committed is the common case, and a reader
 * asking `base...HEAD` would see nothing exactly when there is something to see. That is
 * the diffstat bug — a blank panel while four hundred files were about to be pushed — and
 * repeating it here would make the advice silent on the run it exists for.
 *
 * `--no-renames` is load-bearing rather than tidy. Rename detection is on by default, and
 * a deleted `Screen.xib` paired with an added `Screen.swift` is precisely the corroborating
 * evidence `detectConversion` looks for — reported as one `R` entry it is neither a
 * deletion nor an addition, and the signal disappears.
 *
 * `-z` for the same class of reason: `core.quotePath` mangles a non-ASCII path into a
 * C-quoted string, and this repository's own Jira speaks Turkish.
 */
export function readPushChangedFiles(
  base: string,
  exclude: string[] = [],
  cwd: string = process.cwd(),
): ChangedFile[] {
  // Only `base` is caller-controlled; `--end-of-options` is what stops a `--output=`
  // spelling of it from turning this read into a write, as in `readPushDiffstat`.
  const mergeBase = git(["merge-base", "--end-of-options", base, "HEAD"], cwd).trim();
  const scratch = mkdtempSync(join(tmpdir(), "shipkit-index-"));
  const index = join(scratch, "index");
  try {
    gitWithIndex(["read-tree", "--end-of-options", mergeBase], cwd, index);
    // `commitAll`'s own pathspec, so the index holds exactly what the commit would —
    // .gitignore and core.excludesFile applied by git rather than re-implemented. For the
    // exclusions specifically this doubles up with the diff pathspec below: measured, either
    // layer alone keeps an excluded path out of the answer. It is kept because
    // `readPushDiffstat` stages identically and the two must not drift.
    gitWithIndex(["add", "--all", ...stagingPathspec(exclude)], cwd, index);

    const pathspec = [
      "--",
      ...CONVERTIBLE_PATHSPEC,
      ...exclude.map((path) => `:(exclude,literal,top)${path}`),
    ];
    // `--no-relative` for the reason `readPushDiffstat` records: `diff.relative` makes git
    // print paths relative to cwd, and a path spelled relative to a subdirectory is not one
    // `cat-file` can resolve against the repository root.
    const raw = gitWithIndex(
      [
        "diff", "--cached", "--name-status", "-z", "--no-relative", "--no-renames",
        "--end-of-options", mergeBase, ...pathspec,
      ],
      cwd,
      index,
    );

    const fields = raw.split("\0").filter((field) => field.length > 0);
    const files: ChangedFile[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const status = changeStatus(fields[i] as string);
      const path = fields[i + 1] as string;
      files.push({
        path,
        status,
        // `<sha>:<path>` reads the merge base's blob; a bare `:<path>` reads stage 0 of the
        // scratch index, which is what the commit would carry. Both are root-relative,
        // which is what `--no-relative` above guarantees the paths are. Asked
        // unconditionally: an added file simply has no blob at the merge base, and a
        // deleted one none in the index, and `readBlob` answers "" for exactly that.
        before: readBlob(`${mergeBase}:${path}`, cwd, index),
        after: readBlob(`:${path}`, cwd, index),
      });
    }
    return files;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The files `git add --all` would bring into the commit that are not tracked yet —
 * scratch notes, local env files, and the agent's own response file. `--exclude-standard`
 * keeps ignored paths out, so what comes back is only what would really be committed.
 */
export function readUntrackedFiles(cwd: string = process.cwd()): string[] {
  // `:/` and `--full-name` together make this a question about the repository rather than
  // about the current directory. Without them `ls-files` reports only what sits below cwd,
  // so running shipkit from a subdirectory would hide the root-level files that staging
  // sweeps in anyway — the warning would go quiet exactly where it is most needed.
  return git(["ls-files", "--others", "--exclude-standard", "--full-name", "--", ":/"], cwd)
    .split("\n")
    .filter(Boolean);
}

/** Absolute path of the repository root, for turning caller paths into root-relative ones. */
export function readRepoRoot(cwd: string = process.cwd()): string {
  return git(["rev-parse", "--show-toplevel"], cwd).trim();
}

/** The full commit id of `HEAD`, unabbreviated because it goes into a fingerprint. */
export function readHeadSha(cwd: string = process.cwd()): string {
  return git(["rev-parse", "HEAD"], cwd).trim();
}
