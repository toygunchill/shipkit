import { execFileSync } from "node:child_process";
import { VcsError } from "./types.js";

export type GhRunner = (args: string[]) => string;

const defaultRunner: GhRunner = (args) => {
  try {
    return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr ?? (error as Error).message;
    throw new VcsError(`gh ${args.join(" ")} failed: ${String(detail).trim()}`);
  }
};

function call<T>(run: GhRunner, args: string[]): T {
  let raw: string;
  try {
    raw = run(args);
  } catch (error) {
    if (error instanceof VcsError) throw error;
    throw new VcsError(`gh ${args.join(" ")} failed: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new VcsError(`gh ${args.join(" ")} returned unparseable JSON`);
  }
}

export function defaultBranch(run: GhRunner = defaultRunner): string {
  const data = call<{ defaultBranchRef: { name: string } }>(
    run,
    ["repo", "view", "--json", "defaultBranchRef"],
  );
  return data.defaultBranchRef.name;
}

export function baseCandidates(run: GhRunner = defaultRunner): string[] {
  const fallback = defaultBranch(run);
  const branches = call<{ name: string }[]>(
    run,
    ["api", "repos/{owner}/{repo}/branches", "--paginate", "--jq", "[.[] | {name}]"],
  );
  const releases = branches
    .map((b) => b.name)
    .filter((name) => name.startsWith("release/"))
    .sort();
  return [fallback, ...releases.filter((name) => name !== fallback)];
}
