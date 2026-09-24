import type { ReadinessRule } from "../readiness/types.js";
import type { Anchors } from "./anchors.js";
import type { Gathered } from "./gather.js";

/**
 * What the agent is given, and what it is allowed to answer with.
 *
 * shipkit does not write the review; the agent does, because it is the thing that reads
 * code. What shipkit supplies is everything the agent cannot know on its own — the diff,
 * the rules this repository actually wrote down, and the exact positions a comment is
 * permitted to land on — plus the contract its answer is checked against.
 *
 * The contract is the design. An agent asked to review a diff will always find something
 * to say, and a review of fifteen remarks where four matter teaches its reader to skim.
 * Requiring every remark to cite a rule from the supplied list is a filter it cannot talk
 * its way past, and it moves the claim from "a model finds this unclear" to "this
 * repository decided otherwise, in writing, and here is the line".
 */

export type BriefRule = {
  id: string;
  ask: string;
  why?: string;
};

export type BriefAnchor = {
  path: string;
  /** Lines commentable on the new file. */
  right: number[];
  /** Lines commentable on the old file. */
  left: number[];
};

export type ReviewBrief = {
  version: 1;
  pull: {
    repository: string;
    number: number;
    title: string;
    body: string;
    author: string;
    baseRef: string;
    mine: boolean;
  };
  rules: BriefRule[];
  diff: string;
  anchors: BriefAnchor[];
  contract: string[];
};

function anchorList(anchors: Anchors): BriefAnchor[] {
  const out: BriefAnchor[] = [];
  for (const [path, keys] of anchors) {
    const right: number[] = [];
    const left: number[] = [];
    for (const key of keys) {
      const [line, side] = key.split(":");
      (side === "LEFT" ? left : right).push(Number(line));
    }
    right.sort((a, b) => a - b);
    left.sort((a, b) => a - b);
    out.push({ path, right, left });
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/**
 * The rules the agent may cite, said plainly enough to be checkable.
 *
 * Severity is deliberately absent. A readiness rule's severity decides what happens on a
 * *submit* — whether it blocks, warns or advises the person pushing. It says nothing about
 * whether a reviewer should mention it, and carrying it here would invite the agent to
 * treat `advise` rules as not worth raising when they are often the ones a human reviewer
 * would actually write a comment about.
 */
function briefRules(rules: readonly ReadinessRule[]): BriefRule[] {
  return rules.map((rule) => ({ id: rule.id, ask: rule.ask, ...(rule.why !== undefined ? { why: rule.why } : {}) }));
}

const CONTRACT = [
  "Write one remark per thing worth saying, as JSON matching the shape below. Write nothing else.",
  "Every remark must cite `ruleId`, and it must be an id from `rules`. If no rule covers what you noticed, do not write the remark — a review that ranges beyond the written rules is an opinion, and this one is not asked for opinions.",
  "Do not invent an id that looks plausible. An id not in `rules` is refused and reported.",
  "To comment on a line, give `path`, `line` and `side` taken from `anchors`. Any other position is refused: GitHub will not accept a comment on a line outside the diff.",
  "For something true of the change as a whole, give `ruleId` and `body` and omit the position entirely. Do not attach a general observation to an arbitrary line.",
  "`body` is what a reviewer would write: what is wrong and what to do instead. Do not restate the rule — it is shown alongside your remark already.",
  "Say nothing about formatting, naming taste, or anything else no rule mentions.",
  "Finding nothing is a valid review. Return an empty list rather than filling it.",
];

export function reviewBrief(gathered: Gathered, rules: readonly ReadinessRule[]): ReviewBrief {
  return {
    version: 1,
    pull: {
      repository: `${gathered.pull.owner}/${gathered.pull.repo}`,
      number: gathered.pull.number,
      title: gathered.pull.title,
      body: gathered.pull.body,
      author: gathered.pull.author,
      baseRef: gathered.pull.baseRef,
      mine: gathered.pull.mine,
    },
    rules: briefRules(rules),
    diff: gathered.diff,
    anchors: anchorList(gathered.anchors),
    contract: CONTRACT,
  };
}
