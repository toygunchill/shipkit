import { execFileSync } from "node:child_process";
import { VcsError } from "./types.js";

export type GhRunner = (args: string[]) => string;

const defaultRunner: GhRunner = (args) => {
  try {
    return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const detail =
      (error as { stderr?: string }).stderr ?? (error instanceof Error ? error.message : String(error));
    throw new VcsError(`gh ${args.join(" ")} failed: ${String(detail).trim()}`);
  }
};

function call<T>(run: GhRunner, args: string[]): T {
  let raw: string;
  try {
    raw = run(args);
  } catch (error) {
    if (error instanceof VcsError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new VcsError(`gh ${args.join(" ")} failed: ${detail}`);
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
  
  // Validate the shape: defaultBranchRef.name must be a string
  if (
    typeof data !== "object" ||
    data === null ||
    typeof (data as Record<string, unknown>).defaultBranchRef !== "object" ||
    (data as Record<string, unknown>).defaultBranchRef === null ||
    typeof ((data as Record<string, unknown>).defaultBranchRef as Record<string, unknown>).name !== "string"
  ) {
    throw new VcsError(`gh ${["repo", "view", "--json", "defaultBranchRef"].join(" ")} returned unexpected shape`);
  }
  
  return data.defaultBranchRef.name;
}

export function baseCandidates(run: GhRunner = defaultRunner): string[] {
  const fallback = defaultBranch(run);
  const branches = call<{ name: string }[]>(
    run,
    ["api", "repos/{owner}/{repo}/branches", "--paginate", "--jq", "[.[] | {name}]"],
  );
  
  // Validate the shape: must be an array of objects with a string name property
  if (!Array.isArray(branches)) {
    throw new VcsError(`gh ${["api", "repos/{owner}/{repo}/branches", "--paginate", "--jq", "[.[] | {name}]"].join(" ")} returned unexpected shape`);
  }
  
  for (const branch of branches) {
    if (
      typeof branch !== "object" ||
      branch === null ||
      typeof (branch as Record<string, unknown>).name !== "string"
    ) {
      throw new VcsError(`gh ${["api", "repos/{owner}/{repo}/branches", "--paginate", "--jq", "[.[] | {name}]"].join(" ")} returned unexpected shape`);
    }
  }
  
  const releases = branches
    .map((b) => b.name)
    .filter((name) => name.startsWith("release/"))
    .sort(compareReleaseBranches);
  return [fallback, ...releases.filter((name) => name !== fallback)];
}

// Lexicographic sort orders "release/3.10.0" before "release/3.9.0" — the wrong-base
// failure this tool exists to prevent. Compare each dot-separated component numerically.
function compareReleaseBranches(a: string, b: string): number {
  const versionOf = (name: string): number[] =>
    name.slice("release/".length).split(".").map((part) => Number(part) || 0);
  const va = versionOf(a);
  const vb = versionOf(b);
  const length = Math.max(va.length, vb.length);
  for (let i = 0; i < length; i++) {
    const diff = (va[i] ?? 0) - (vb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
