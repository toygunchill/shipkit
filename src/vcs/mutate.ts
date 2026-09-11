import { asVcsError, execRunner } from "./exec.js";
import type { GhRunner } from "./github.js";

// The runner seam allows argv assertions without executing anything — tests pass in a mock
// that records calls rather than executing git or gh, so the exact command line can be verified.
export type GitRunner = (args: string[]) => string;

function guard(run: (args: string[]) => string, args: string[], binary: string): string {
  return asVcsError(binary, args, () => run(args));
}

/**
 * The pathspec `commitAll` stages with, and nothing else. Exported because the diffstat
 * a person is shown before approving a push has to describe the same set of paths this
 * commit will carry: one that names the excluded response file contradicts the exclusion,
 * and one that misses a file the commit sweeps in understates what is being approved.
 * `readPushDiffstat` builds its scratch index with this, so the two cannot drift.
 *
 * Empty for an empty exclusion, because `git add --all` with no pathspec at all already
 * means the whole tree — and `git diff` with no pathspec already means the whole
 * repository.
 */
export function stagingPathspec(exclude: string[]): string[] {
  return exclude.length === 0
    ? []
    : ["--", ":/", ...exclude.map((path) => `:(exclude,literal,top)${path}`)];
}

/**
 * Stages the whole tree and commits it. `exclude` takes repository-root-relative paths that
 * are never part of the change — shipkit's own response file above all, which sits in the
 * repository and would otherwise be committed into the pull request on every run.
 *
 * Three pieces of pathspec magic, each load-bearing. `:/` anchors staging at the repository
 * root: a bare `.` means "below the current directory", so invoking shipkit from a
 * subdirectory would quietly stage only part of the work. `literal` turns off globbing —
 * without it, excluding a file named `weird[1].txt` also silently drops an unrelated
 * `weird1.txt` from the commit. `top` reads the path from the root, so it matches wherever
 * shipkit was invoked from. An absolute path here is a bug: git rejects it outright.
 */
export function commitAll(
  message: string,
  exclude: string[],
  cwd: string = process.cwd(),
  run: GitRunner = execRunner("git", cwd),
): void {
  guard(run, ["add", "--all", ...stagingPathspec(exclude)], "git");
  guard(run, ["commit", "-m", message], "git");
}

export function pushBranch(
  branch: string,
  cwd: string = process.cwd(),
  run: GitRunner = execRunner("git", cwd),
): void {
  guard(run, ["push", "--set-upstream", "origin", "--end-of-options", branch], "git");
}

export function createPullRequest(
  input: { title: string; body: string; base: string; head: string },
  cwd: string = process.cwd(),
  run: GhRunner = execRunner("gh", cwd),
): string {
  const out = guard(
    run,
    [
      "pr", "create",
      "--title", input.title,
      "--body", input.body,
      "--base", input.base,
      "--head", input.head,
    ],
    "gh",
  );
  return out.trim();
}
