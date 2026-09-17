import { CATALOGUE, type Candidate } from "./catalogue.js";
import type { Survey } from "./survey.js";

/** A rule this repository will be asked, with the evidence that put it there. */
export type Proposal = {
  id: string;
  ask: string;
  why: string;
  appliesTo?: string[];
  /** What the detector saw, written above the rule in the file. */
  evidence: string;
};

/** A rule whose subject is here but which something else already enforces. */
export type Covered = {
  id: string;
  /** Which tool covers it, named so a person can disagree. */
  by: string;
};

export type Proposals = {
  rules: Proposal[];
  covered: Covered[];
  /** Ids whose subject this repository does not have at all. */
  absent: string[];
};

/**
 * Which of the catalogue's rules this repository should be asked.
 *
 * Pure, over a survey — so the whole selection is testable without a filesystem, and so a
 * proposal can never depend on anything but what the survey says it saw.
 */
export function propose(survey: Survey, catalogue: readonly Candidate[] = CATALOGUE): Proposals {
  const rules: Proposal[] = [];
  const covered: Covered[] = [];
  const absent: string[] = [];

  for (const candidate of catalogue) {
    const finding = candidate.detect(survey);
    if (finding === undefined) {
      absent.push(candidate.id);
      continue;
    }
    const by = candidate.coveredBy?.(survey);
    if (by !== undefined) {
      covered.push({ id: candidate.id, by });
      continue;
    }
    // The evidence's own scope wins over the candidate's: a detector that found this
    // repository's shared layer knows what it is called, and the catalogue cannot.
    const appliesTo = finding.scope ?? candidate.appliesTo?.(survey);
    rules.push({
      id: candidate.id,
      ask: candidate.ask,
      why: candidate.why,
      ...(appliesTo === undefined || appliesTo.length === 0 ? {} : { appliesTo }),
      evidence: finding.why,
    });
  }
  return { rules, covered, absent };
}
