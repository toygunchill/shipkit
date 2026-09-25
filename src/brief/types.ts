import type { Advice } from "../advice/types.js";
import type { ShipkitConfig } from "../config/schema.js";
import type { ReadinessAsk } from "../readiness/types.js";
import type { FixRequestItem } from "../review/fixrequest.js";

/**
 * What a person ticked in `shipkit review`, on its way to the agent.
 *
 * `instruction` is carried as text rather than left for the agent to infer, because the
 * framing is the whole point of the feature: everything else in a brief is shipkit's
 * opinion, and this is not. An agent that reads these as one more automated suggestion will
 * weigh them like one.
 */
export type BriefFixRequest = {
  instruction: string;
  /** When the person made the selection. */
  createdAt: string;
  /**
   * The branch and base the person was looking at when they ticked these.
   *
   * Carried because the file is per-checkout, not per-branch: a person reviews one branch,
   * gets pulled onto another, and the selection is still lying there. A timestamp does not
   * show that — only these two names do, read against `change.branch` and `target.branch`.
   */
  madeOn: { branch: string; base: string };
  /**
   * Present only when `madeOn` does not describe the change this brief is about.
   *
   * The selection is carried anyway rather than dropped. Silently ignoring it would throw
   * away the one part of a brief a person actually chose, on a guess about what a branch
   * rename meant; the note hands the agent the discrepancy and lets it decide.
   */
  note?: string;
  items: FixRequestItem[];
};

export type BriefSection = {
  name: string;
  required: boolean;
  minItems?: number;
  hint?: string;
};

export type Brief = {
  /**
   * First in the type and first in the JSON, so the agent meets it before anything else.
   *
   * Absent when nobody has reviewed this change — which is most briefs. Present means a
   * person looked at the diff and the findings and chose these, and they come before the
   * change, the template and the rules because they outrank all three: the rest of the brief
   * says what a good pull request looks like here, and this says what is wrong with this one
   * according to someone who read it.
   */
  fixRequest?: BriefFixRequest;
  /**
   * The repository's own reviewer, when it defines one.
   *
   * Second, after a person's own selection and before the change: it decides how everything
   * below it is read. Absent means the repository has not written down how changes here are
   * reviewed, and the agent is left with `rules` alone.
   */
  reviewer?: {
    instruction: string;
    path: string;
    flavour: string;
    instructions: string;
  };
  change: { branch: string; files: string[]; diffstat: string; commits: string[] };
  /**
   * What shipkit noticed and will not insist on. Absent when there was nothing to say.
   *
   * It sits here, second, because the agent is the only party that can read it: judging
   * whether a UIKit-to-SwiftUI conversion was in scope needs the ticket, and the agent is
   * holding it. Placed after the sections it would be advice about a body already written.
   *
   * Deliberately `Advice[]` and not `Warning[]` — see src/advice/types.ts. Nothing here
   * reaches `shouldRequestApproval` or changes an exit code.
   */
  advice?: Advice[];
  /**
   * The team's PR-readiness rules the agent must answer, and only the ones this change is
   * about: a rule whose `appliesTo` matched nothing in the push is never carried, because
   * asking about files nobody touched is noise, and a checklist of noise is one that gets
   * skimmed rather than read.
   *
   * Absent when the repository configures no rules, and when none of them apply. Present
   * means every id here must come back in the response's `readiness`, with a status.
   *
   * Only the question and its stakes travel; `appliesTo` stays behind. The agent is being
   * asked whether the work is ready, not asked to re-derive why it was asked.
   */
  readiness?: ReadinessAsk[];
  ticket?: {
    key: string;
    type: string;
    summary: string;
    cite: string;
    parent?: { key: string; type: string; summary: string };
  };
  target: { branch: string; reason: string };
  template: { sections: BriefSection[] };
  rules: {
    titlePattern: string;
    branchPattern: string;
    keyPattern: string;
    forbidden: string[];
    issuesSection: string;
    linkPolicy: ShipkitConfig["jira"]["linkPolicy"];
  };
};
