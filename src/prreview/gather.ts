import type { GhRunner } from "../vcs/github.js";
import { commentableAnchors, type Anchors } from "./anchors.js";

/**
 * Everything that has to be true before an agent is asked to review anything.
 *
 * Three reads, all of them from the forge rather than from a checkout. Reviewing somebody
 * else's pull request should not require having their branch fetched, and requiring it
 * would make the feature useless for the case it exists for.
 */

export type PullRequestFacts = {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  baseRef: string;
  headSha: string;
  host: string | undefined;
  /** True when the pull request is the caller's own, which changes nothing but is worth saying. */
  mine: boolean;
};

export type Gathered = {
  pull: PullRequestFacts;
  diff: string;
  anchors: Anchors;
};

type ViewJson = {
  number: number;
  title: string;
  body: string | null;
  author: { login: string } | null;
  baseRefName: string;
  headRefOid: string;
};

function hostArgs(host: string | undefined): string[] {
  // `gh` follows whichever host was authenticated to most recently. Naming the host is what
  // keeps a review from being posted to a different forge than the one being read.
  return host !== undefined && host.length > 0 ? ["--hostname", host] : [];
}

function repoArgs(owner: string, repo: string, host: string | undefined): string[] {
  const prefix = host !== undefined && host.length > 0 ? `${host}/` : "";
  return ["--repo", `${prefix}${owner}/${repo}`];
}

/**
 * Reads the pull request and its diff.
 *
 * The head sha is read here and carried all the way to the payload, because it is what the
 * anchors were computed against. If the author pushes while the review is open, GitHub
 * outdates the comments — which is correct — rather than shipkit re-anchoring them against
 * lines it never read.
 */
export function gather(
  owner: string,
  repo: string,
  number: number,
  gh: GhRunner,
  host?: string,
  viewer?: string,
): Gathered {
  // `gh pr view --json` has no "is this mine" field — only `author`. Whose it is therefore
  // takes a second read, and it is worth the call: the publish notice says whose pull
  // request is about to be commented on, and getting that wrong is exactly the mistake the
  // notice exists to catch.
  const fields = "number,title,body,author,baseRefName,headRefOid";
  const raw = gh([
    "pr",
    "view",
    String(number),
    ...repoArgs(owner, repo, host),
    "--json",
    fields,
  ]);

  let view: ViewJson;
  try {
    view = JSON.parse(raw) as ViewJson;
  } catch {
    throw new Error(`Could not read pull request ${owner}/${repo}#${number}: gh returned no JSON.`);
  }

  const diff = gh(["pr", "diff", String(number), ...repoArgs(owner, repo, host)]);

  return {
    pull: {
      owner,
      repo,
      number: view.number,
      title: view.title,
      body: view.body ?? "",
      author: view.author?.login ?? "unknown",
      baseRef: view.baseRefName,
      headSha: view.headRefOid,
      host,
      mine: viewer !== undefined && view.author?.login === viewer,
    },
    diff,
    anchors: commentableAnchors(diff),
  };
}

/**
 * The repository's rules as they stand on the pull request's base.
 *
 * Read from the base rather than from whatever is checked out locally: the review has to
 * judge the change against the rules it will be merged into, and a reviewer whose own
 * working copy is three weeks stale should not thereby review against three-week-old rules.
 */
export function readRuleFile(
  owner: string,
  repo: string,
  ref: string,
  path: string,
  gh: GhRunner,
  host?: string,
): string | undefined {
  try {
    return gh([
      "api",
      ...hostArgs(host),
      `repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
      "--jq",
      ".content",
      "--cache",
      "0",
    ]);
  } catch {
    // Not every repository has every file, and a missing ruleset is a reported condition
    // rather than a crash — the caller decides whether it can proceed without one.
    return undefined;
  }
}

/**
 * Who `gh` is authenticated as on this host, or undefined if it cannot say.
 *
 * Only used to decide whether a pull request is the caller's own, which changes what the
 * publish notice says and nothing else. A failure here must therefore not stop a review:
 * not knowing produces the more cautious wording, which is the right way to be wrong.
 */
export function currentLogin(gh: GhRunner, host?: string): string | undefined {
  try {
    const login = gh(["api", ...hostArgs(host), "user", "--jq", ".login"]).trim();
    return login.length > 0 ? login : undefined;
  } catch {
    return undefined;
  }
}
