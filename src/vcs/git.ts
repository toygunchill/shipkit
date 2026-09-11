import { execRunner } from "./exec.js";
import { VcsError, type RepoState } from "./types.js";

export { VcsError };
export type { RepoState };

function git(args: string[], cwd: string): string {
  return execRunner("git", cwd)(args);
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
 * The files `git add --all` would bring into the commit that are not tracked yet —
 * scratch notes, local env files, and the agent's own response file. `--exclude-standard`
 * keeps ignored paths out, so what comes back is only what would really be committed.
 */
export function readUntrackedFiles(cwd: string = process.cwd()): string[] {
  return git(["ls-files", "--others", "--exclude-standard"], cwd)
    .split("\n")
    .filter(Boolean);
}
