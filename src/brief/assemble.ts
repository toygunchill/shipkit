import type { Advice } from "../advice/types.js";
import { conversionAdvice, detectConversion, type ChangedFile } from "../advice/uikit.js";
import type { ShipkitConfig } from "../config/schema.js";
import { citeTarget } from "../jira/level.js";
import { asks } from "../readiness/apply.js";
import type { ReadinessRule } from "../readiness/types.js";
import type { IssueFacts } from "../jira/types.js";
import type { FixRequest } from "../review/fixrequest.js";
import type { RepoState } from "../vcs/types.js";
import type { Brief } from "./types.js";

export type { Brief };

/**
 * Said in shipkit's own words, because an agent that cannot tell this list apart from the
 * rest of the brief will treat it like the rest of the brief.
 */
const FIX_REQUEST_INSTRUCTION =
  "A person read this change in shipkit review and chose these. They are not shipkit's " +
  "opinion and not a heuristic — someone looked at the diff and ticked them. Address every " +
  "one, and read each note as the instruction it is, before you draft anything below.";

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
  /**
   * The readiness rules that apply to this change — already filtered by the caller, which
   * is the only party that can read the changed paths. Omitted when the repository
   * configures none, or when none apply.
   *
   * Filtering happens outside because it needs the filesystem and this function has no
   * business touching one. What the caller must not do is pass an unfiltered list silently:
   * `applicable` (src/readiness/apply.ts) holds the one exception, where the paths could
   * not be read at all and every rule is carried on purpose.
   */
  readiness?: ReadinessRule[];
  /**
   * The selection `shipkit review` left at `.shipkit/fix-request.json`, when there is one.
   * Read by the caller, like everything else that needs a filesystem.
   */
  fixRequest?: FixRequest;
};

export function assembleBrief({
  repo,
  target,
  config,
  issue,
  changed,
  readiness,
  fixRequest,
}: AssembleInput): Brief {
  const conversion = changed === undefined ? undefined : detectConversion(changed);
  const advice: Advice[] =
    conversion === undefined
      ? []
      : [conversionAdvice(conversion, { ticketKey: issue?.key, epic: config.techTask?.epic })];

  const brief: Brief = {
    // First key in the object literal, because `JSON.stringify` writes string keys in
    // insertion order and this is the one thing in the brief that a person chose. An empty
    // selection is treated as none at all: `shipkit review` does not write one, and a
    // `fixRequest` key with no items would be an instruction to do nothing.
    ...(fixRequest !== undefined && fixRequest.items.length > 0
      ? {
          fixRequest: {
            instruction: FIX_REQUEST_INSTRUCTION,
            createdAt: fixRequest.createdAt,
            items: fixRequest.items,
          },
        }
      : {}),
    change: {
      branch: repo.branch,
      files: repo.changedFiles,
      diffstat: repo.diffstat,
      commits: repo.commits,
    },
    // Conditional rather than an always-present empty array: a brief with nothing to advise
    // should not carry a key inviting the agent to look for one.
    ...(advice.length > 0 ? { advice } : {}),
    // Conditional for the same reason as `advice`: a brief with nothing to ask should not
    // carry an empty key inviting the agent to answer something.
    ...(readiness !== undefined && readiness.length > 0 ? { readiness: asks(readiness) } : {}),
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
