import { asVcsError, execRunner } from "./exec.js";
import type { GhRunner } from "./github.js";

// The runner seam allows argv assertions without executing anything — tests pass in a mock
// that records calls rather than executing git or gh, so the exact command line can be verified.
export type GitRunner = (args: string[]) => string;

const defaultGit: GitRunner = execRunner("git");
const defaultGh: GhRunner = execRunner("gh");

function guard(run: (args: string[]) => string, args: string[], binary: string): string {
  return asVcsError(binary, args, () => run(args));
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
  run: GitRunner = defaultGit,
): void {
  const stage =
    exclude.length === 0
      ? ["add", "--all"]
      : ["add", "--all", "--", ":/", ...exclude.map((path) => `:(exclude,literal,top)${path}`)];
  guard(run, stage, "git");
  guard(run, ["commit", "-m", message], "git");
}

export function pushBranch(branch: string, run: GitRunner = defaultGit): void {
  guard(run, ["push", "--set-upstream", "origin", "--end-of-options", branch], "git");
}

export function createPullRequest(
  input: { title: string; body: string; base: string; head: string },
  run: GhRunner = defaultGh,
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
