import type { Advice } from "../advice/types.js";
import type { ShipkitConfig } from "../config/schema.js";
import type { ReadinessAsk } from "../readiness/types.js";

export type BriefSection = {
  name: string;
  required: boolean;
  minItems?: number;
  hint?: string;
};

export type Brief = {
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
