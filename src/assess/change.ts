import { observedAddedLines, observedChangedFiles } from "../advice/observe.js";
import type { Advice } from "../advice/types.js";
import { conversionAdvice, detectConversion, type ChangedFile } from "../advice/uikit.js";
import type { ShipkitConfig } from "../config/schema.js";
import { preflight } from "../preflight/checks.js";
import type { Warning } from "../preflight/types.js";
import { applicable, evaluate, matchedPaths, observedPaths } from "../readiness/apply.js";
import type { ReadinessAnswer, ReadinessRule } from "../readiness/types.js";
import type { Finding } from "../validate/types.js";
import type { AddedLine, PullRequestState, RepoState } from "../vcs/types.js";

/**
 * "What is wrong with this change" — asked once, answered once.
 *
 * `runSubmit` asks it to decide whether to push; `runReview` asks it to render a page a
 * person ticks boxes on. Two implementations would drift, and this project has paid for
 * drift twice: the diffstat that showed committed work while an uncommitted push was about
 * to land, and the `appliesTo` filter that excused every readiness rule for the same reason.
 * So the sequence lives here, and both callers get the same answer by construction.
 *
 * Nothing in this file touches the filesystem, spawns git, or reaches a forge. Every read is
 * a dependency the caller supplies, which is what lets `runSubmit`'s existing fakes keep
 * working unchanged and lets review's tests run without a repository.
 */

export type ReadinessAssessment = {
  /** Refusals. `runSubmit` merges these with validation's; they refuse alike. */
  findings: Finding[];
  /** Ordinary pre-flight warnings — see src/readiness/apply.ts for why that is the design. */
  warnings: Warning[];
  advice: Advice[];
  /**
   * Which changed paths each applying rule's `appliesTo` matched, by rule id.
   *
   * Computed here because this is where the paths are read; recomputing it in the caller
   * would mean a second scratch-index read for an answer this function already had. Empty
   * when the paths could not be read — `applicable` carries every rule in that case, and a
   * rule carried for that reason is not a rule about any particular file.
   */
  matched: Map<string, string[]>;
};

/**
 * The three-step readiness read: which paths the push delivers, which rules that makes
 * applicable, and what the answers cost.
 *
 * `answers` is `undefined` when nobody has answered yet — which `evaluate` reports as
 * `readiness-unanswered` rather than as silence. That is exactly what `shipkit review`
 * without `--input` should show a person: the questions are open, and nobody has said
 * anything about them.
 *
 * `readPushChangedPaths` is optional for the reason `SubmitDeps` records: a caller that
 * supplies none is not excused, it simply carries every rule (see `applicable`).
 */
export function assessReadiness(input: {
  rules: readonly ReadinessRule[];
  base: string;
  exclude: string[];
  answers: readonly ReadinessAnswer[] | undefined;
  readPushChangedPaths?: ((base: string, exclude: string[]) => string[]) | undefined;
}): ReadinessAssessment {
  const read = input.readPushChangedPaths;
  // `undefined` means "could not be read", which `applicable` answers by carrying every
  // rule. Distinct from `[]`, which means the push delivers nothing and legitimately
  // excuses every `appliesTo` rule — see src/readiness/apply.ts.
  const changedPaths =
    read === undefined ? undefined : observedPaths(() => read(input.base, input.exclude));
  const applying = applicable(input.rules, changedPaths);
  // The whole rule set as the third argument, so an answer to a rule that exists but did
  // not apply here costs nothing, while a misspelled id is still caught.
  return { ...evaluate(applying, input.answers, input.rules), matched: matchedPaths(applying, changedPaths) };
}

export type ChangeAssessment = {
  repo: RepoState;
  /** The open pull request for this branch, or null when there is none. */
  pullRequest: PullRequestState | null;
  /** Untracked paths staging would sweep in, minus everything `exclude` keeps out. */
  untrackedFiles: string[];
  /** Pre-flight's warnings only. Readiness warnings are the caller's to append. */
  warnings: Warning[];
  /** The conversion observation only. Readiness advice is the caller's to append. */
  advice: Advice[];
  /**
   * The files the conversion was seen in, when one was. Carried so the review page can show
   * the observation *on* those files rather than in a list beside the diff — a remark whose
   * subject a reader has to go and find is one they read as boilerplate.
   */
  conversionFiles: string[];
};

export type ChangeAssessmentDeps = {
  readRepoState: (base: string) => RepoState;
  readPushAddedLines: (base: string, exclude: string[]) => AddedLine[];
  readPushChangedFiles: (base: string, exclude: string[]) => ChangedFile[];
  readUntrackedFiles: () => string[];
  findPullRequest: (branch: string) => PullRequestState | null;
};

/**
 * The repository facts, the pre-flight warnings they produce, and the one observation
 * shipkit will not insist on.
 *
 * The order is load-bearing and is the order `runSubmit` has always used: repository state,
 * then the forge, then the working tree, then pre-flight over all three, then the advisory
 * read last. Both advisory reads go through the `observed*` guards for the reason
 * src/advice/observe.ts records — a scratch index that fails on a repository where nothing
 * is wrong with the change must not turn an observation into a refusal.
 *
 * `untrackedFiles` is filtered by `exclude` rather than by a separate "is this the response
 * file" test. The two were the same set before this function existed, and keeping one source
 * means a path the commit will not carry can never be warned about as though it would be —
 * which now covers the review selection file as well as the response.
 */
export function assessChange(
  input: {
    base: string;
    branch: string;
    exclude: string[];
    ticketKey?: string | undefined;
    /** False when a key was derived but Jira could not be consulted — see `issue-unverified`. */
    issueVerified: boolean;
    config: ShipkitConfig;
  },
  deps: ChangeAssessmentDeps,
): ChangeAssessment {
  const repo = deps.readRepoState(input.base);
  const pullRequest = deps.findPullRequest(input.branch);
  const untrackedFiles = deps
    .readUntrackedFiles()
    .filter((file) => !input.exclude.includes(file));

  const warnings = preflight({
    branch: input.branch,
    base: input.base,
    commits: repo.commits,
    ticketKey: input.ticketKey,
    issueVerified: input.issueVerified,
    pullRequest,
    untrackedFiles,
    // Read through the advisory guard: a repository where the scratch-index read fails
    // is one where shipkit still has to run, and no observation is the honest answer.
    addedLines: observedAddedLines(() => deps.readPushAddedLines(input.base, input.exclude)),
    config: input.config,
  }).warnings;

  // The same `exclude` the commit gets, and the same uncommitted-work reading — see
  // `readPushChangedFiles`. Nothing downstream consults this: it is not in `gate`, not in
  // `shouldRequestApproval`, not in the `Situation`, and not on the wire to the approval
  // surface.
  const conversion = detectConversion(
    observedChangedFiles(() => deps.readPushChangedFiles(input.base, input.exclude)),
  );
  const advice =
    conversion === undefined
      ? []
      : [conversionAdvice(conversion, { ticketKey: input.ticketKey, epic: input.config.techTask?.epic })];
  const conversionFiles = conversion === undefined ? [] : [...conversion.files];

  return { repo, pullRequest, untrackedFiles, warnings, advice, conversionFiles };
}
