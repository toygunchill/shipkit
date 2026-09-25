import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Picking up a review the person asked for from the menu bar.
 *
 * The menu bar writes the request and cannot deliver it: MCP is
 * request/response, so a server hands nothing to an agent that did not ask.
 * This is the other half — the asking. Both the agent, through a tool, and a
 * terminal, through `pr-review brief` with no arguments, read the same file, so
 * the two routes cannot answer differently.
 */

export type Requested = {
  version: number;
  repository: string;
  number: number;
  title: string;
  url: string;
  requestedAt: string;
};

export function requestedReviewPath(home: string = homedir()): string {
  return join(home, "Library", "Application Support", "shipkit", "requested-review.json");
}

/** The request waiting, or `undefined` when there is none. */
export function readRequested(path: string = requestedReviewPath()): Requested | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A half-written or hand-edited file is not a request. Reporting nothing
    // waiting is better than acting on a repository name that parsed by luck.
    return undefined;
  }

  const { version, repository, number, title, url, requestedAt } = (parsed ?? {}) as Record<string, unknown>;
  if (version !== 1) return undefined;
  if (typeof repository !== "string" || repository.length === 0) return undefined;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) return undefined;
  if (typeof url !== "string") return undefined;

  return {
    version,
    repository,
    number,
    title: typeof title === "string" ? title : "",
    url,
    requestedAt: typeof requestedAt === "string" ? requestedAt : "",
  };
}

/**
 * Forgets the request.
 *
 * Called once it has been picked up, so the same press is not answered twice —
 * and, more to the point, so a request from yesterday is not acted on today by
 * an agent that happened to ask. What is being asked for ends in comments
 * published under a person's name; a stale one is not worth the convenience.
 */
export function clearRequested(path: string = requestedReviewPath()): void {
  rmSync(path, { force: true });
}
