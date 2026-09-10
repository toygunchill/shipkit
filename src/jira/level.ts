import type { IssueFacts } from "./types.js";

export type LinkPolicy = "story" | "any";

/** Issue types that satisfy a `story` link policy on their own. */
export const STORY_LEVEL = new Set(["Story", "Bug"]);

/**
 * The key an agent should cite for `issue`, given `linkPolicy`.
 *
 * `IssueFacts` only carries one hop of parent data (the issue and its immediate parent —
 * see `fetchIssue`), so this can only ever recommend `issue.key` itself or that immediate
 * parent's key. It recommends the parent only when the parent is verifiably story-level;
 * otherwise it falls back to `issue.key` rather than pointing at a parent that is itself
 * non-compliant. This keeps `assembleBrief` (which advertises the result as `ticket.cite`)
 * and `validate`'s `issue-level` rule (which flags any citation this function would not
 * have recommended) in agreement — neither can tell a caller "cite X" and then reject X.
 */
export function citeTarget(issue: IssueFacts, linkPolicy: LinkPolicy): string {
  if (linkPolicy !== "story") return issue.key;
  if (STORY_LEVEL.has(issue.type)) return issue.key;
  if (issue.parent !== undefined && STORY_LEVEL.has(issue.parent.type)) return issue.parent.key;
  return issue.key;
}
