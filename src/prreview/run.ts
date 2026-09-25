import { readFileSync } from "node:fs";
import type { ReadinessRule } from "../readiness/types.js";
import type { GhRunner } from "../vcs/github.js";
import { reviewBrief, type BriefReviewer, type ReviewBrief } from "./brief.js";
import { currentLogin, gather } from "./gather.js";
import { postReview, type PostTarget, type ReviewPayload } from "./post.js";
import { validateRemarks, type Remark, type Validation } from "./validate.js";

/**
 * Wiring the pieces into the two halves a person actually runs.
 *
 * The shape mirrors `brief` and `submit`, which is not an accident: it is the same
 * conversation. shipkit states what it knows and what it will accept, the agent answers,
 * and shipkit either takes the answer or says why it will not.
 */

/** `owner/name`, with an optional host in front, as a person would type it. */
export function parseSlug(slug: string): { owner: string; repo: string; host?: string } {
  const parts = slug.split("/").filter((part) => part.length > 0);
  if (parts.length === 2) {
    return { owner: parts[0] as string, repo: parts[1] as string };
  }
  if (parts.length === 3) {
    return { host: parts[0] as string, owner: parts[1] as string, repo: parts[2] as string };
  }
  throw new Error(`Could not read "${slug}" as a repository: expected owner/name, or host/owner/name.`);
}

export function briefFor(
  slug: string,
  number: number,
  rules: readonly ReadinessRule[],
  gh: GhRunner,
  reviewer?: BriefReviewer,
): ReviewBrief {
  const { owner, repo, host } = parseSlug(slug);
  return reviewBrief(gather(owner, repo, number, gh, host, currentLogin(gh, host)), rules, reviewer);
}

/** The pull request's target branch, which is where its rules are read from. */
export function baseOf(slug: string, number: number, gh: GhRunner): string {
  const { owner, repo, host } = parseSlug(slug);
  return gather(owner, repo, number, gh, host).pull.baseRef;
}

export function readRemarks(path: string): Remark[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`Could not read the agent's remarks at ${path}.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${path} is not JSON.`);
  }

  // Both shapes are accepted because both are what an agent actually writes: a bare array,
  // or an object with the array under `remarks`. Refusing one of them would be a rule about
  // formatting rather than about the review.
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { remarks?: unknown }).remarks;

  if (!Array.isArray(list)) {
    throw new Error(`${path} holds no list of remarks: expected an array, or { "remarks": [...] }.`);
  }

  return list as Remark[];
}

export type Prepared = {
  target: PostTarget;
  author: string;
  mine: boolean;
  validation: Validation;
};

/** Everything up to, but not including, the publish. */
export function prepare(
  slug: string,
  number: number,
  remarks: readonly Remark[],
  rules: readonly ReadinessRule[],
  gh: GhRunner,
): Prepared {
  const { owner, repo, host } = parseSlug(slug);
  const gathered = gather(owner, repo, number, gh, host, currentLogin(gh, host));
  const ids = new Set(rules.map((rule) => rule.id));

  return {
    target: {
      owner,
      repo,
      number: gathered.pull.number,
      headSha: gathered.pull.headSha,
      host,
    },
    author: gathered.pull.author,
    mine: gathered.pull.mine,
    validation: validateRemarks(remarks, gathered.anchors, ids),
  };
}

/**
 * What the person is told immediately before anything becomes visible to anyone else.
 *
 * Deliberately not a yes/no prompt's worth of words. A review comment sends a notification
 * and a notification cannot be withdrawn, so the sentence names the pull request, whose it
 * is, how many comments, and that they will be public — everything a person would need to
 * notice that this is the wrong pull request.
 */
export function publishNotice(prepared: Prepared): string {
  const count = prepared.validation.accepted.length;
  const whose = prepared.mine ? "your own" : `${prepared.author}'s`;
  const plural = count === 1 ? "comment" : "comments";
  return (
    `Publishing ${count} ${plural} on ${whose} pull request ` +
    `${prepared.target.owner}/${prepared.target.repo}#${prepared.target.number}. ` +
    "They become visible to everyone immediately and a notification cannot be withdrawn."
  );
}

export function publish(prepared: Prepared, gh: GhRunner, dryRun: boolean): ReviewPayload {
  return postReview(prepared.validation.accepted, prepared.target, gh, { dryRun });
}
