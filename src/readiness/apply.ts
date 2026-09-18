import type { Advice } from "../advice/types.js";
import type { Warning } from "../preflight/types.js";
import type { Finding } from "../validate/types.js";
import { anyMatch } from "./glob.js";
import type { ReadinessAnswer, ReadinessAsk, ReadinessRule } from "./types.js";

/**
 * The pure half of the readiness mechanism: which rules the change is about, and what the
 * answers cost. It reads no file, runs no git, and decides nothing about severity that the
 * team's own file did not already decide. Every caller — the CLI, the MCP server, and
 * `runSubmit` between them — reaches the filesystem on its own and hands the result here.
 */

/** Folded YAML scalars carry their line breaks. A warning printed as `check: message` wants one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** `readiness-design-tokens` — the same spelling for a warning's check, an advice's topic
 *  and a blocking finding's rule, so one id is searchable across all three channels. */
function channelId(rule: ReadinessRule): string {
  return `readiness-${rule.id}`;
}

/** The question, then what the agent said about it. The note is the whole value of a `fail`. */
function failureMessage(rule: ReadinessRule, answer: ReadinessAnswer): string {
  const note = answer.note === undefined ? undefined : oneLine(answer.note);
  return note === undefined || note.length === 0
    ? `${oneLine(rule.ask)} — reported as failing, with no note`
    : `${oneLine(rule.ask)} — ${note}`;
}

/**
 * The rules this change is actually about.
 *
 * A rule with no `appliesTo` always applies. One with `appliesTo` applies when any of its
 * globs matches any path the push will deliver.
 *
 * `changedPaths` is `undefined` when the paths could not be read at all — a repository
 * where the scratch index fails (a missing git-lfs clean filter, an unreadable file: both
 * reproduced, see src/advice/observe.ts). Then **every** rule applies. The choice is
 * between asking about files that were not touched and enforcing nothing, and only one of
 * those two degrades politely: an over-asked question is answered `n/a` with a note, while
 * silent unenforcement looks exactly like compliance.
 */
export function applicable(
  rules: readonly ReadinessRule[],
  changedPaths: readonly string[] | undefined,
): ReadinessRule[] {
  if (changedPaths === undefined) return [...rules];
  return rules.filter(
    (rule) => rule.appliesTo === undefined || anyMatch(rule.appliesTo, changedPaths),
  );
}

/**
 * The guard the changed-paths read is made through, everywhere it is made.
 *
 * Deliberately `undefined` and not `[]`: an empty array is a real answer ("the push
 * carries nothing"), under which every `appliesTo` rule correctly falls away. A failed
 * read is not that answer, and conflating the two is how enforcement disappears on the
 * repositories least able to notice.
 */
/**
 * Which changed paths each rule's `appliesTo` actually matched.
 *
 * `applicable` answers whether a rule applies and throws the reason away. The review page
 * needs the reason: a checklist question shown beside the file it is about is one a person
 * can answer, and the same question in a list above the diff is one they scroll past.
 *
 * A rule with no `appliesTo` matches the whole change, so it gets no paths — it belongs to
 * the change, not to any file in it. Same for a rule reached when the paths could not be
 * read at all, which `applicable` deliberately carries anyway.
 */
export function matchedPaths(
  rules: readonly ReadinessRule[],
  changedPaths: readonly string[] | undefined,
): Map<string, string[]> {
  const matched = new Map<string, string[]>();
  if (changedPaths === undefined) return matched;
  for (const rule of rules) {
    if (rule.appliesTo === undefined) continue;
    const hits = changedPaths.filter((path) => anyMatch(rule.appliesTo as string[], [path]));
    if (hits.length > 0) matched.set(rule.id, hits);
  }
  return matched;
}

export function observedPaths(read: () => string[]): string[] | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** The applicable rules as the brief carries them — the question and its stakes, never the globs. */
export function asks(rules: readonly ReadinessRule[]): ReadinessAsk[] {
  return rules.map((rule) => ({
    id: rule.id,
    ask: rule.ask.trim(),
    ...(rule.why === undefined ? {} : { why: rule.why.trim() }),
    severity: rule.severity,
  }));
}

export type Evaluation = {
  /** Refusals. Merged into the validation findings by `runSubmit`; they refuse alike. */
  findings: Finding[];
  /** Ordinary pre-flight warnings, which is the entire severity design — see below. */
  warnings: Warning[];
  advice: Advice[];
};

/**
 * What the answers cost.
 *
 * `rules` is the applicable subset — the same subset the brief asked about, so an answer is
 * required for exactly what was asked and nothing more. `configured` is the whole file,
 * used only to tell a misspelled id from a conscientious answer to a rule that did not
 * apply: the first is a typo that would otherwise satisfy nothing at all while looking like
 * diligence, the second is simply extra information and costs nothing.
 *
 * The severity mapping is the point of the whole feature. A `warn` failure becomes a plain
 * `Warning`, indistinguishable from `foreign-commits` or `untracked-files` from there on —
 * so it reaches `shouldRequestApproval`, lands on the approval panel under
 * `pr.approval: human`, and binds into the fingerprint, all without one line of new
 * canonical-form code in src/approval/fingerprint.ts.
 */
export function evaluate(
  rules: readonly ReadinessRule[],
  answers: readonly ReadinessAnswer[] | undefined,
  configured: readonly ReadinessRule[] = rules,
): Evaluation {
  const findings: Finding[] = [];
  const warnings: Warning[] = [];
  const advice: Advice[] = [];

  const given = answers ?? [];
  const byId = new Map<string, ReadinessAnswer>();
  const duplicated = new Set<string>();
  for (const answer of given) {
    if (byId.has(answer.id)) duplicated.add(answer.id);
    else byId.set(answer.id, answer);
  }

  const configuredIds = new Set(configured.map((rule) => rule.id));

  const unanswered = rules.filter((rule) => !byId.has(rule.id)).map((rule) => rule.id);
  if (unanswered.length > 0) {
    // The same philosophy as a template section left unfilled: what was not said was not
    // done. An unanswered rule that merely warned would be the cheapest thing in the run to
    // ignore, and the checklist would be back to being a document nobody reads.
    findings.push({
      rule: "readiness-unanswered",
      message:
        `No readiness answer for: ${unanswered.join(", ")}. ` +
        "Answer every rule the brief lists — pass, fail, or n/a with a note saying why. " +
        "Silence is not compliance.",
    });
  }

  const missingNote = given
    .filter((answer) => answer.status === "n/a" && oneLine(answer.note ?? "").length === 0)
    .map((answer) => answer.id);
  if (missingNote.length > 0) {
    // An escape hatch that costs nothing is not a rule. The note is the whole price of
    // n/a, and it is what a reviewer reads when they want to know why the question was
    // declined rather than answered.
    findings.push({
      rule: "readiness-note-required",
      message:
        `n/a needs a note saying why the rule does not apply: ${[...new Set(missingNote)].join(", ")}.`,
    });
  }

  if (duplicated.size > 0) {
    // Two answers for one id means one of them was not read. Which one is not shipkit's
    // guess to make, and a "pass" quietly overriding a "fail" is the worst possible way to
    // resolve it.
    findings.push({
      rule: "readiness-duplicate-answer",
      message: `Answered more than once: ${[...duplicated].join(", ")}. Give exactly one answer per rule.`,
    });
  }

  const unknown = given
    .filter((answer) => !configuredIds.has(answer.id))
    .map((answer) => answer.id);
  if (unknown.length > 0) {
    // Without this a misspelled id is the perfect crime: the answer looks given, the rule
    // it was meant for is still unanswered, and the two mistakes cancel into silence.
    findings.push({
      rule: "readiness-unknown-rule",
      message:
        `No readiness rule has the id: ${[...new Set(unknown)].join(", ")}. ` +
        `Use the ids exactly as the brief spells them.`,
    });
  }

  for (const rule of rules) {
    const answer = byId.get(rule.id);
    if (answer === undefined || answer.status !== "fail") continue;
    const message = failureMessage(rule, answer);
    switch (rule.severity) {
      case "block":
        findings.push({ rule: channelId(rule), message });
        break;
      case "warn":
        warnings.push({ check: channelId(rule), message });
        break;
      case "advise":
        advice.push({ topic: channelId(rule), message });
        break;
    }
  }

  return { findings, warnings, advice };
}
