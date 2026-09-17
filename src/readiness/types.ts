/**
 * The team's PR-readiness rules, as data.
 *
 * The rules are not shipkit's: they live in a file the team owns (see
 * docs/examples/example-app.readiness.yml), and adding or relaxing one is a pull request
 * against that file rather than a shipkit release. What shipkit owns is the carrying and
 * the enforcing — the question reaches the agent in the brief, the answer is required back
 * in the response, and the answer is routed by severity. The judgement in between stays
 * with the agent, which is the only party holding the diff and the ticket at once.
 */

/**
 * What a `fail` answer costs.
 *
 *   block   the submit refuses, like any validation finding.
 *   warn    an ordinary pre-flight warning — so under `pr.approval: human` it lands on the
 *           approval panel and binds into the fingerprint with no new canonical-form work.
 *           "Uphold it, but let a person overrule it."
 *   advise  informs and never gates. See src/advice/types.ts for why that is a separate
 *           channel and not a quiet warning.
 */
export type ReadinessSeverity = "block" | "warn" | "advise";

export type ReadinessRule = {
  /** Stable, unique within the file. It is what an answer names and what a warning id is built from. */
  id: string;
  /** The question put to the agent, in the team's own words. */
  ask: string;
  /** The evidence the rule was measured from. Carried to the agent; never enforced. */
  why?: string;
  /**
   * Glob patterns, matched against the paths this push will deliver. Absent means the rule
   * always applies. A rule that matches nothing in the change is never asked, because an
   * irrelevant question is noise and a noisy checklist is one nobody reads.
   */
  appliesTo?: string[];
  severity: ReadinessSeverity;
};

/** One rule's answer, as the agent gives it back in the response. */
export type ReadinessAnswer = {
  id: string;
  status: "pass" | "fail" | "n/a";
  /** Required for `n/a`, and what makes a `fail` mean anything. */
  note?: string;
};

/** A rule as the brief carries it: the question and its stakes, never the path patterns. */
export type ReadinessAsk = {
  id: string;
  ask: string;
  why?: string;
  severity: ReadinessSeverity;
};
