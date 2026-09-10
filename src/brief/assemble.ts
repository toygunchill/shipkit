import type { ShipkitConfig } from "../config/schema.js";
import type { IssueFacts } from "../jira/types.js";
import type { RepoState } from "../vcs/types.js";
import type { Brief } from "./types.js";

export type { Brief };

export type AssembleInput = {
  repo: RepoState;
  target: { branch: string; reason: string };
  config: ShipkitConfig;
  issue?: IssueFacts;
};

const STORY_LEVEL = new Set(["Story", "Bug"]);

export function assembleBrief({ repo, target, config, issue }: AssembleInput): Brief {
  const brief: Brief = {
    change: {
      branch: repo.branch,
      files: repo.changedFiles,
      diffstat: repo.diffstat,
      commits: repo.commits,
    },
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
      forbidden: config.pr.forbidden,
      issuesSection: config.jira.section,
      linkPolicy: config.jira.linkPolicy,
    },
  };

  if (issue !== undefined) {
    const citeParent =
      config.jira.linkPolicy === "story" &&
      !STORY_LEVEL.has(issue.type) &&
      issue.parent !== undefined;
    brief.ticket = {
      key: issue.key,
      type: issue.type,
      summary: issue.summary,
      cite: citeParent && issue.parent !== undefined ? issue.parent.key : issue.key,
      parent: issue.parent,
    };
  }

  return brief;
}
