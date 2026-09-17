import type { Advice } from "../advice/types.js";
import type { Warning } from "../preflight/types.js";
import type { Finding } from "../validate/types.js";
import type { FixRequestKind } from "./fixrequest.js";

/**
 * Everything shipkit has to say about this change, in one list a page can render and a
 * person can tick.
 *
 * The three channels are deliberately separate types everywhere else — see
 * src/advice/types.ts for why advice must never be mistaken for a warning — and they stay
 * separate right up to here. This is the one place they are flattened, and the `kind` field
 * is what carries the distinction the types were keeping.
 */
export type ReviewItem = {
  kind: FixRequestKind;
  id: string;
  message: string;
  /**
   * How hard shipkit is pushing. `refuses` stops a submit outright, `warns` needs an
   * acknowledgement or a person, `informs` does neither. The page shows these differently
   * because they are different, and a page that rendered a refusal and a suggestion
   * identically would be lying about what happens next.
   */
  severity: "refuses" | "warns" | "informs";
};

/**
 * `readiness-design-tokens` is a readiness failure whether it arrived as a finding, a
 * warning or advice — the rule's `severity` decides the channel, not what kind of thing it
 * is. src/readiness/apply.ts builds all three spellings from one `channelId`, so the prefix
 * is the same in every channel and this test is exact rather than a guess.
 */
function isReadiness(id: string): boolean {
  return id.startsWith("readiness-");
}

/**
 * Findings first, then warnings, then advice — hardest to ignore at the top, because that is
 * the order a person should read them in and the order the submit will enforce them in.
 */
export function reviewItems(input: {
  findings: readonly Finding[];
  warnings: readonly Warning[];
  advice: readonly Advice[];
}): ReviewItem[] {
  return [
    ...input.findings.map((finding) => ({
      kind: (isReadiness(finding.rule) ? "readiness" : "finding") as FixRequestKind,
      id: finding.rule,
      message: finding.message,
      severity: "refuses" as const,
    })),
    ...input.warnings.map((warning) => ({
      kind: (isReadiness(warning.check) ? "readiness" : "warning") as FixRequestKind,
      id: warning.check,
      message: warning.message,
      severity: "warns" as const,
    })),
    ...input.advice.map((item) => ({
      kind: (isReadiness(item.topic) ? "readiness" : "advice") as FixRequestKind,
      id: item.topic,
      message: item.message,
      severity: "informs" as const,
    })),
  ];
}
