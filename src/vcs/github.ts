import { asVcsError, execRunner } from "./exec.js";
import { VcsError, type PullRequestState } from "./types.js";

export type GhRunner = (args: string[]) => string;

function call<T>(run: GhRunner, args: string[]): T {
  // The runner is wrapped too, not just the parse. An injected runner is free to throw a
  // plain Error, and every caller above expects VcsError — it is what runSubmit's catch
  // turns into exit 2. Letting a raw Error through here would crash instead.
  const raw = asVcsError("gh", args, () => run(args));
  return asVcsError("gh", args, () => JSON.parse(raw) as T);
}

export function defaultBranch(
  cwd: string = process.cwd(),
  run: GhRunner = execRunner("gh", cwd),
): string {
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

export function baseCandidates(
  cwd: string = process.cwd(),
  run: GhRunner = execRunner("gh", cwd),
): string[] {
  const fallback = defaultBranch(cwd, run);
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

export function findPullRequest(
  branch: string,
  cwd: string = process.cwd(),
  run: GhRunner = execRunner("gh", cwd),
): PullRequestState | null {
  const list = call<unknown>(run, [
    "pr", "list", "--head", branch, "--state", "open", "--json", "number,url,baseRefName",
  ]);
  if (!Array.isArray(list)) {
    throw new VcsError("gh pr list did not return an array");
  }
  if (list.length === 0) return null;

  const head = list[0];
  if (
    typeof head !== "object" ||
    head === null ||
    typeof (head as Record<string, unknown>).number !== "number" ||
    typeof (head as Record<string, unknown>).url !== "string" ||
    typeof (head as Record<string, unknown>).baseRefName !== "string"
  ) {
    throw new VcsError("gh pr list returned an entry without number, url or baseRefName");
  }

  const detail = call<unknown>(run, [
    "pr", "view", String((head as Record<string, unknown>).number), "--json", "labels,latestReviews",
  ]);
  if (typeof detail !== "object" || detail === null) {
    throw new VcsError("gh pr view did not return an object");
  }
  const record = detail as { labels?: unknown; latestReviews?: unknown };
  const labels = Array.isArray(record.labels) ? record.labels : [];
  const reviews = Array.isArray(record.latestReviews) ? record.latestReviews : [];

  // Validate labels array entries
  const labelNames: string[] = [];
  for (const label of labels) {
    if (typeof label !== "object" || label === null) {
      throw new VcsError("gh pr view returned a label entry that is not an object");
    }
    const name = (label as Record<string, unknown>).name;
    if (typeof name === "string") {
      labelNames.push(name);
    }
  }

  // Validate reviews array entries
  const approvalLogins: string[] = [];
  for (const review of reviews) {
    if (typeof review !== "object" || review === null) {
      throw new VcsError("gh pr view returned a review entry that is not an object");
    }
    if ((review as Record<string, unknown>).state === "APPROVED") {
      const login = ((review as Record<string, unknown>).author as Record<string, unknown> | undefined)?.login;
      if (typeof login === "string") {
        approvalLogins.push(login);
      }
    }
  }

  return {
    number: (head as Record<string, unknown>).number as number,
    url: (head as Record<string, unknown>).url as string,
    baseRefName: (head as Record<string, unknown>).baseRefName as string,
    labels: labelNames,
    approvals: approvalLogins,
  };
}
