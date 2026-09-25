import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GhRunner } from "../vcs/github.js";
import type { AcceptedRemark } from "./validate.js";

/**
 * Publishing the remarks a person kept.
 *
 * This is the first thing shipkit does that other people see the moment it happens. A
 * review comment sends a notification, and a notification cannot be taken back — deleting
 * the comment afterwards does not unsend it.
 *
 * Two choices follow from that. Everything goes out as **one review**, because N separate
 * comments would be N separate notifications to someone whose afternoon this is
 * interrupting. And nothing is posted at all unless there is something to post.
 */

export type PostTarget = {
  owner: string;
  repo: string;
  number: number;
  /** The commit the anchors were computed against. */
  headSha: string;
  /** The forge this pull request lives on, when it is not gh's default. */
  host: string | undefined;
};

export type ReviewComment = {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
};

export type ReviewPayload = {
  commit_id: string;
  event: "COMMENT";
  body: string;
  comments: ReviewComment[];
};

/**
 * Every comment names the rule it came from.
 *
 * Not decoration: it is the difference between "a tool thinks this is wrong" and "the
 * repository decided this, in writing, and here is the line". The second is checkable by
 * the person reading it, which is the only reason an automated remark deserves their time.
 */
function withCitation(ruleId: string, body: string): string {
  return `**${ruleId}** — ${body}`;
}

export function reviewPayload(remarks: readonly AcceptedRemark[], target: PostTarget): ReviewPayload {
  const comments: ReviewComment[] = [];
  const general: string[] = [];

  for (const remark of remarks) {
    if (remark.placement === "line") {
      comments.push({
        path: remark.path,
        line: remark.line,
        side: remark.side,
        body: withCitation(remark.ruleId, remark.body),
      });
    } else {
      general.push(withCitation(remark.ruleId, remark.body));
    }
  }

  return {
    commit_id: target.headSha,
    event: "COMMENT",
    body: general.join("\n\n"),
    comments,
  };
}

/**
 * Posts the review, or explains why it did not.
 *
 * `dryRun` returns the payload having run nothing. It exists so a person can see exactly
 * what would be published before it is; a dry run that still called `gh` would be worse
 * than not offering one.
 */
export function postReview(
  remarks: readonly AcceptedRemark[],
  target: PostTarget,
  gh: GhRunner,
  options: { dryRun?: boolean } = {},
): ReviewPayload {
  if (remarks.length === 0) {
    throw new Error("There is nothing to publish: no remark was kept.");
  }

  const payload = reviewPayload(remarks, target);
  if (options.dryRun === true) return payload;

  const args = ["api", "--method", "POST"];
  // The pull request's own host, explicitly. `gh` follows whichever host was authenticated
  // to most recently, and a review posted to the wrong forge is not a recoverable mistake.
  if (target.host !== undefined && target.host.length > 0) {
    args.push("--hostname", target.host);
  }
  args.push(`repos/${target.owner}/${target.repo}/pulls/${target.number}/reviews`);

  // The payload is nested — `comments` is an array of objects — so `gh api -f` cannot
  // express it, and the runner seam passes arguments only, with no stdin to pipe into
  // `--input -`. A file is what is left, and it is removed whether or not `gh` succeeds.
  const file = join(mkdtempSync(join(tmpdir(), "shipkit-review-")), "review.json");
  writeFileSync(file, JSON.stringify(payload), "utf8");
  try {
    gh(args.concat(["--input", file]));
  } finally {
    rmSync(dirname(file), { recursive: true, force: true });
  }
  return payload;
}
