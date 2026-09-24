import { isAnchored, type Anchors, type Side } from "./anchors.js";

/**
 * Checking what the agent wrote before a person is asked to read it.
 *
 * Two things are being defended against, and they are different failures.
 *
 * The first is mechanical: a comment anchored to a line outside the diff is refused by
 * GitHub with a 422, at the end, after the person has already decided to publish. Catching
 * it here turns a failed publish into a remark that never reached the editor.
 *
 * The second is the reason this feature is usable at all. Every remark has to cite a rule
 * the repository actually carries. An agent asked to review a diff will always find
 * something to say, and a review where four remarks in fifteen matter teaches its reader to
 * skim. Requiring a citation is a filter the agent cannot argue past — and an agent that
 * wants to say something anyway will invent a plausible id rather than stay silent, which
 * is precisely why the id is checked against the loaded set instead of its shape.
 */

/** What the agent is asked to produce, before anything has been checked. */
export type Remark = {
  ruleId: string;
  path?: string;
  line?: number;
  side?: Side;
  body: string;
};

/** A remark that survived checking, and where it will be filed. */
export type AcceptedRemark =
  | { placement: "line"; ruleId: string; path: string; line: number; side: Side; body: string }
  | { placement: "pull"; ruleId: string; body: string };

export type Rejection = { remark: Remark; reason: string };

export type Validation = { accepted: AcceptedRemark[]; rejected: Rejection[] };

function checkOne(remark: Remark, anchors: Anchors, rules: ReadonlySet<string>): AcceptedRemark | string {
  if (remark.ruleId.trim().length === 0) {
    return "cites no rule; a remark shipkit cannot attribute is one it will not carry";
  }

  if (!rules.has(remark.ruleId)) {
    return `cites ${remark.ruleId}, which this repository's ruleset does not contain`;
  }

  if (remark.body.trim().length === 0) {
    return "has an empty body";
  }

  const positioned = remark.path !== undefined || remark.line !== undefined || remark.side !== undefined;
  if (!positioned) {
    // Not every true observation belongs to a line. Dropping these would quietly lose the
    // most general remarks, so they become comments on the pull request itself.
    return { placement: "pull", ruleId: remark.ruleId, body: remark.body };
  }

  if (remark.path === undefined || remark.line === undefined || remark.side === undefined) {
    // Guessing the missing third would be a guess about which version of which file the
    // remark meant, and a comment on the wrong line is worse than no comment.
    return "gives a position that is missing its path, line or side";
  }

  if (!isAnchored(anchors, remark.path, remark.line, remark.side)) {
    return (
      `anchors to ${remark.path}:${remark.line} (${remark.side}), which is not a line this ` +
      "diff touches — GitHub would refuse it"
    );
  }

  return {
    placement: "line",
    ruleId: remark.ruleId,
    path: remark.path,
    line: remark.line,
    side: remark.side,
    body: remark.body,
  };
}

/**
 * Sorts the agent's remarks into the ones that will be shown and the ones that will not.
 *
 * Per remark, not all-or-nothing: one bad anchor is no reason to discard four good
 * observations. Refusals are returned rather than swallowed, because an agent that keeps
 * inventing rule ids is something the person should get to see.
 */
export function validateRemarks(
  remarks: readonly Remark[],
  anchors: Anchors,
  rules: ReadonlySet<string>,
): Validation {
  const accepted: AcceptedRemark[] = [];
  const rejected: Rejection[] = [];

  for (const remark of remarks) {
    const outcome = checkOne(remark, anchors, rules);
    if (typeof outcome === "string") {
      rejected.push({ remark, reason: outcome });
    } else {
      accepted.push(outcome);
    }
  }

  return { accepted, rejected };
}
