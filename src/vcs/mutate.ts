import { execFileSync } from "node:child_process";
import { VcsError } from "./types.js";
import type { GhRunner } from "./github.js";

// The runner seam allows argv assertions without executing anything — tests pass in a mock
// that records calls rather than executing git or gh, so the exact command line can be verified.
export type GitRunner = (args: string[]) => string;

function runner(binary: string): (args: string[]) => string {
  return (args) => {
    try {
      return execFileSync(binary, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const detail =
        (error as { stderr?: string }).stderr ??
        (error instanceof Error ? error.message : String(error));
      throw new VcsError(`${binary} ${args.join(" ")} failed: ${String(detail).trim()}`);
    }
  };
}

const defaultGit: GitRunner = runner("git");
const defaultGh: GhRunner = runner("gh");

function guard(run: (args: string[]) => string, args: string[], binary: string): string {
  try {
    return run(args);
  } catch (error) {
    if (error instanceof VcsError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new VcsError(`${binary} ${args.join(" ")} failed: ${detail}`);
  }
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
