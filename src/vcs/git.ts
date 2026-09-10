import { execFileSync } from "node:child_process";
import { VcsError, type RepoState } from "./types.js";

export { VcsError };
export type { RepoState };

function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr ?? (error as Error).message;
    throw new VcsError(`git ${args.join(" ")} failed: ${String(detail).trim()}`);
  }
}

export function readRepoState(base: string, cwd: string = process.cwd()): RepoState {
  const diffRange = `${base}...HEAD`;
  const logRange = `${base}..HEAD`;
  return {
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"], cwd).trim(),
    changedFiles: git(["diff", "--name-only", diffRange], cwd).split("\n").filter(Boolean),
    diffstat: git(["diff", "--stat", diffRange], cwd).trim(),
    commits: git(["log", "--format=%s", logRange], cwd).split("\n").filter(Boolean),
  };
}
