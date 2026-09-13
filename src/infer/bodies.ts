import type { Inferred, SectionSkeleton } from "./types.js";

// A line made of nothing but a bullet marker or stray punctuation (e.g. "-", "---", "* ")
// recurs in every template for structural reasons, not because anyone typed it.
const PUNCTUATION_ONLY = /^[-*+>~`_.,;:!?|=]+$/;

// A line that is nothing but one bold or italic span, optionally with a trailing
// colon: "**Summary**", "__What to Test__", "*Issues Addressed*:". This is a
// heading written by a team whose house style has no "#", and it is structure
// for exactly the reason a "#" heading is.
const EMPHASIS_ONLY = /^(?:\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)\s*:?$/;

// How long a line must be, and how many words it must hold, before a recurrence
// counts as template text. Both floors are deliberately generous: see below.
const MIN_LENGTH = 24;
const MIN_WORDS = 4;

/** Tokens holding at least one letter — "N/A — backend only" is three, not four. */
function words(line: string): string[] {
  return line.split(/\s+/).filter((token) => /\p{L}/u.test(token));
}

/**
 * The lines of one body that may be banned as template text.
 *
 * What goes in `forbidden` is matched with `body.includes(term)` (see
 * src/validate/rules.ts): a term rejects a pull request wherever those
 * characters appear, not only on a line of its own. So a wrong entry is not a
 * weak guess a human corrects later — it is every later pull request containing
 * that string being rejected as unfilled boilerplate, by a file claiming the
 * rule was observed. Recurrence alone cannot carry that; three bodies answering
 * "N/A" are three honest answers, not a template.
 *
 * A line is a candidate only when it is all three of:
 *
 *   1. not structure. A heading recurs because the template has that section,
 *      not because nobody filled it in — and banning it contradicts
 *      `pr.sections`, which proposes the same words as a section to write
 *      under. That covers "#" headings, bold-only or italic-only pseudo
 *      headings, and lines with no words in them at all.
 *   2. long enough to be an instruction. Template prose asks for something
 *      ("Briefly describe what this PR does."); the answers that recur verbatim
 *      are short ("N/A", "TBD", "None", "same as above").
 *   3. shaped like a sentence rather than a token: several real words, so a
 *      bare URL or a lone identifier is not banned for the whole repository.
 *
 * Each of these can be fooled, and each errs the same way on purpose: a short
 * or structural template line is left un-banned rather than a real answer
 * banned. A missing `forbidden` entry is one a human adds after reading the
 * file; a wrong one silently rejects the team's work and says it was observed.
 */
function candidateLines(body: string): Set<string> {
  const lines = new Set<string>();
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) continue; // a heading recurring is structure, not boilerplate
    if (EMPHASIS_ONLY.test(line)) continue; // ...and so is a heading in bold
    if (PUNCTUATION_ONLY.test(line)) continue;
    if (line.length < MIN_LENGTH) continue;
    if (words(line).length < MIN_WORDS) continue;
    lines.add(line);
  }
  return lines;
}

export function boilerplateLines(bodies: string[], atLeast: number): Inferred<string[]> {
  const counts = new Map<string, number>();
  for (const body of bodies) {
    // A Set per body so a line repeated within one body still counts once — ten
    // repeats in a single PR is not ten pieces of evidence that it's a template.
    for (const line of candidateLines(body)) {
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
  }

  const value = [...counts.entries()]
    .filter(([, count]) => count >= atLeast)
    .sort((a, b) => b[0].length - a[0].length)
    .map(([line]) => line);

  // Nothing recurring is now the ordinary outcome on a small sample, so say so
  // rather than reporting "appears verbatim in 0 of 3 bodies", which describes
  // a line that does not exist.
  const why =
    value.length > 0
      ? `appears verbatim in ${counts.get(value[0])!} of ${bodies.length} bodies`
      : "no line recurred often enough, or looked enough like instruction text, to ban";

  return { value, provenance: "observed", why };
}

function headingsOf(body: string): string[] {
  const headings: string[] = [];
  for (const raw of body.split("\n")) {
    const match = /^##\s+(.+)$/.exec(raw.trim());
    if (match) headings.push(match[1].trim());
  }
  return headings;
}

/**
 * What it takes to call a heading required.
 *
 * `required` is the setting that rejects a later pull request for not carrying
 * a section, so it is a claim about the team's convention, not about the sample.
 * A share on its own cannot make that claim: one merged pull request carrying
 * somebody's "## Note to self: revisit later" is 100% of a sample of one, and a
 * brand-new repository with one or two merged pull requests is precisely what
 * `init` is for. Below the floor every heading is still reported — the names are
 * real — but none is marked required, and `why` says that is why.
 */
const REQUIRED_SHARE = 0.8;
const REQUIRED_MIN_BODIES = 3;

function median(numbers: number[]): number {
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function sectionSkeleton(bodies: string[]): Inferred<SectionSkeleton[]> {
  if (bodies.length === 0) {
    return { value: [], provenance: "observed", why: "no bodies to infer a skeleton from" };
  }

  const counts = new Map<string, number>();
  const firstAppearances = new Map<string, number[]>();

  for (const body of bodies) {
    const headings = headingsOf(body);
    const seen = new Set<string>();
    headings.forEach((name, index) => {
      if (seen.has(name)) return;
      seen.add(name);
      counts.set(name, (counts.get(name) ?? 0) + 1);
      const positions = firstAppearances.get(name) ?? [];
      positions.push(index);
      firstAppearances.set(name, positions);
    });
  }

  const names = [...counts.keys()].sort(
    (a, b) => median(firstAppearances.get(a)!) - median(firstAppearances.get(b)!),
  );

  const enoughToGeneralise = bodies.length >= REQUIRED_MIN_BODIES;

  const value: SectionSkeleton[] = names.map((name) => ({
    name,
    required: enoughToGeneralise && counts.get(name)! / bodies.length >= REQUIRED_SHARE,
  }));

  const seen = `${value.length} heading(s) observed across ${bodies.length} bodies`;
  const why = enoughToGeneralise
    ? `${seen}; required where at least ${REQUIRED_SHARE * 100}% of them carry it`
    : `${seen}; none marked required — it takes ${REQUIRED_MIN_BODIES} bodies ` +
      `before a share of them is evidence of a convention`;

  return { value, provenance: "observed", why };
}
