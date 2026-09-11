import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      ["diff", "--cached", "--stat", "--end-of-options", mergeBase, ...pathspec],
      cwd,
      index,
    ).trim();
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
