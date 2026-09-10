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

export function commitAll(message: string, run: GitRunner = defaultGit): void {
  guard(run, ["add", "--all"], "git");
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
