import type { Advice } from "../advice/types.js";
import { conversionAdvice, detectConversion, type ChangedFile } from "../advice/uikit.js";
import type { ShipkitConfig } from "../config/schema.js";
import { citeTarget } from "../jira/level.js";
import type { IssueFacts } from "../jira/types.js";
import type { RepoState } from "../vcs/types.js";
import type { Brief } from "./types.js";

export type { Brief };

export type AssembleInput = {
  repo: RepoState;
  target: { branch: string; reason: string };
  config: ShipkitConfig;
  issue?: IssueFacts;
  /**
   * The change's `.swift`/`.xib`/`.storyboard` files with the text on both sides, from
   * `readPushChangedFiles`. Omitted by callers that cannot read them, in which case the
   * brief simply carries no advice — never a wrong observation in place of a missing one.
   *
   * `repo.changedFiles` cannot stand in: it is names only, and detection needs both sides
   * of the text.
   */
  changed?: ChangedFile[];
};

export function assembleBrief({ repo, target, config, issue, changed }: AssembleInput): Brief {
  const conversion = changed === undefined ? undefined : detectConversion(changed);
  const advice: Advice[] =
    conversion === undefined
      ? []
      : [conversionAdvice(conversion, { ticketKey: issue?.key, epic: config.techTask?.epic })];

  const brief: Brief = {
    change: {
      branch: repo.branch,
      files: repo.changedFiles,
      diffstat: repo.diffstat,
      commits: repo.commits,
    },
    // Conditional rather than an always-present empty array: a brief with nothing to advise
    // should not carry a key inviting the agent to look for one.
    ...(advice.length > 0 ? { advice } : {}),
    target,
    template: {
      sections: config.pr.sections.map((section) => ({
        name: section.name,
        required: section.required,
        minItems: section.minItems,
        hint: section.hint,
      })),
    },
    rules: {
      titlePattern: config.pr.titlePattern,
      branchPattern: config.branch.pattern,
      keyPattern: config.jira.keyPattern,
      forbidden: config.pr.forbidden,
      issuesSection: config.jira.section,
      linkPolicy: config.jira.linkPolicy,
    },
  };

  if (issue !== undefined) {
    brief.ticket = {
      key: issue.key,
      type: issue.type,
      summary: issue.summary,
      cite: citeTarget(issue, config.jira.linkPolicy),
      parent: issue.parent,
    };
  }

  return brief;
}
