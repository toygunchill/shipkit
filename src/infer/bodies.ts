import type { Inferred, SectionSkeleton } from "./types.js";

// A line made of nothing but a bullet marker or stray punctuation (e.g. "-", "---", "* ")
// recurs in every template for structural reasons, not because anyone typed it.
const PUNCTUATION_ONLY = /^[-*+>~`_.,;:!?|=]+$/;

// A line that is nothing but one bold or italic span, optionally with a trailing
// colon: "**Summary**", "__What to Test__", "*Issues Addressed*:". This is a
// heading written by a team whose house style has no "#", and it is structure
// for exactly the reason a "#" heading is — but only while it reads as a name.
// The capture groups hold the text inside the markers, which is what gets judged.
const EMPHASIS_ONLY = /^(?:\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_)\s*:?$/;

/**
 * The most words a pseudo-heading may hold before it stops being a name.
 *
 * A heading is a noun phrase — "Summary", "Screenshots / Screen Recordings",
 * "Notes for the reviewer". An instruction is a clause. Nothing available here
 * tells a noun phrase from a clause outright, and brevity is the honest proxy:
 * six words covers every section name in the templates on hand and excludes the
 * ninety-three-character italic sentence that motivated this floor. Note the
 * direction — this *narrows* an exemption, so a line just past it is not banned
 * on that account, only made to face the ordinary floors and the recurrence test.
 */
const HEADING_WORDS = 6;

// How long a line must be, and how many words it must hold, before a recurrence
// counts as template text on length alone. These are the backstop for lines no
// shape speaks to, not the argument — see candidateLines for why, and for the
// two shapes that are banned without reference to them.
const MIN_LENGTH = 24;
const MIN_WORDS = 4;

/**
 * The opener of an HTML comment. A comment is scaffolding whatever it says, and
 * the closing "-->" deliberately does not count: as a forbidden term those three
 * characters would reject every body carrying "step 1 --> step 2" in a diagram,
 * whereas "<!--" cannot be anything else.
 */
const HTML_COMMENT = "<!--";

/** A task-list box at the head of a line: "- [x] ...", "* [ ] ...", "1. [] ...". */
const CHECKBOX = /^(?:[-*+]|\d+[.)])\s*\[([^\]]?)\]/;

/**
 * A line that opens by asking for something rather than answering.
 *
 * Unlike the shapes above this one is *not* decisive: people write real
 * summaries in the imperative mood ("Add a retry budget so a flapping upstream
 * cannot wedge the queue") and polite prose opens with "Please". So it does not
 * waive the floors — it lowers the word floor only, on the ground that an
 * instruction is recognisably an instruction at three words where arbitrary
 * prose is not, while the length floor still stands behind it.
 */
const IMPERATIVE =
  /^(?:please|describe|explain|list|link|add|include|provide|attach|paste|write|delete|remove|replace|fill|summari[sz]e|mention|specify|state|enter|upload|outline|detail|tick|complete)\b/i;
const IMPERATIVE_MIN_WORDS = 3;

/**
 * Scripts written without spaces between words.
 *
 * `words()` counts whitespace-separated tokens, so a Japanese or Chinese
 * sentence is one token however long it is, and the word floor made `forbidden`
 * inference inert for those languages entirely. The length floor is the better
 * primary test there: at twenty-four characters a Han or kana line is already
 * several words by any reckoning, so the floor carries the same argument the word
 * count was making, and no second constant has to be invented for it.
 */
const SPACE_FREE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

/** Tokens holding at least one letter — "N/A — backend only" is three, not four. */
function words(line: string): string[] {
  return line.split(/\s+/).filter((token) => /\p{L}/u.test(token));
}

/** The line with a leading bullet, quote marker or emphasis stripped, so that
 * "*Delete this whole section...*" is seen to open with "Delete". */
function opening(line: string): string {
  return line.replace(/^(?:(?:[-*+]|\d+[.)])\s+)?[*_>\s]*/, "");
}

/** Whether the line asks for something rather than answering. */
function isImperative(line: string): boolean {
  return IMPERATIVE.test(opening(line));
}

/**
 * Whether a task-list box has been ticked, left empty, or is not a box at all.
 *
 * Any mark inside the brackets counts as answered, not only "x": some teams use
 * "-" for "does not apply". A person put it there either way.
 */
function checkbox(line: string): "answered" | "unanswered" | undefined {
  const match = CHECKBOX.exec(line);
  if (match === null) return undefined;
  return match[1].trim().length === 0 ? "unanswered" : "answered";
}

/** The text inside a line that is nothing but one emphasis span, if it is one. */
function emphasised(line: string): string | undefined {
  const match = EMPHASIS_ONLY.exec(line);
  if (match === null) return undefined;
  return match[1] ?? match[2] ?? match[3] ?? match[4];
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
 * The rule is about shape, not size. Size was the previous rule — long enough,
 * enough words — and size banned this:
 *
 *     - [x] I have run the test suite locally
 *
 * Thirty-eight characters, eight words, no heading and no emphasis: it cleared
 * every floor, recurred in six bodies out of six, and the config `init` wrote
 * then rejected the next correctly-filled pull request with
 * `forbidden-text`. The line recurred *because people ticked it*. That is the
 * whole lesson: a completed answer is often the longer of the two, so length
 * cannot tell a template from the work of filling it in. Shape can, and these
 * are the shapes, each with its own standing:
 *
 *   ticked box     `- [x] ...` is an answer; the tick is the act of filling it
 *                  in. A veto, at any length, ahead of everything else — a
 *                  ticked box recurring in every body is the strongest evidence
 *                  the team completes its checklist, not the weakest. (Any mark
 *                  counts, not only "x": "- [-]" is somebody writing "n/a".)
 *   unticked box   `- [ ] ...` is a prompt nobody answered, so it is banned
 *                  without reference to the floors: a two-word unanswered box is
 *                  as unanswered as a ten-word one, and banning it cannot reject
 *                  the ticked form, which does not contain that substring. It
 *                  needs one real word, so a bare `- [ ]` — whose substring sits
 *                  inside every checklist in the repository — is left alone.
 *   HTML comment   `<!-- Describe your change -->` is scaffolding whatever its
 *                  length, and the floors missed it outright, because `<!--`
 *                  and `-->` hold no letters for the word floor to count. Also
 *                  floor-free. Only the opener qualifies; see HTML_COMMENT.
 *   imperative     "Describe...", "Please link...", "Write it in a way that..."
 *                  asks rather than answers — but this shape is not decisive on
 *                  its own, so it lowers the word floor rather than waiving the
 *                  floors. See IMPERATIVE.
 *
 * Structure is still never banned: "#" headings, pseudo-headings in bold or
 * italics *while they read as names* (see HEADING_WORDS — an italicised
 * fifteen-word instruction is a standard template idiom and is exactly what this
 * field exists to catch), and lines with no words in them at all.
 *
 * The length and word floors remain, as the backstop for every line the shapes
 * say nothing about — template prose asks for something ("Briefly describe what
 * this PR does.") while the answers that recur verbatim are short ("N/A", "TBD",
 * "same as above"), and a bare URL is one token rather than a sentence. They are
 * no longer the whole argument.
 *
 * Every one of these can be fooled, and each errs the same way on purpose: a
 * template line left un-banned rather than a real answer banned. A missing
 * `forbidden` entry is one a human adds after reading the file; a wrong one
 * silently rejects the team's work and says it was observed.
 */
function candidateLines(body: string): Set<string> {
  const lines = new Set<string>();
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) continue; // a heading recurring is structure, not boilerplate

    const box = checkbox(line);
    if (box === "answered") continue; // the tick is the answer; never ban it

    const spoken = words(line);

    // The two shapes that carry the whole argument by themselves. Both are
    // meaningless without a word in them, which is what keeps "<!-- -->" and a
    // label-less "- [ ]" out of a field matched by substring.
    if (spoken.length > 0 && (line.includes(HTML_COMMENT) || box === "unanswered")) {
      lines.add(line);
      continue;
    }

    const inner = emphasised(line);
    // ...and so is a heading in bold, while it still reads as a name.
    if (inner !== undefined && words(inner).length <= HEADING_WORDS && !isImperative(inner)) continue;
    if (PUNCTUATION_ONLY.test(line)) continue;

    if (line.length < MIN_LENGTH) continue;
    const floor = isImperative(line) ? IMPERATIVE_MIN_WORDS : MIN_WORDS;
    if (spoken.length < floor && !SPACE_FREE_SCRIPT.test(line)) continue;
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

  const banned = [...counts.entries()]
    .filter(([, count]) => count >= atLeast)
    // Most-repeated first, longest first to break a tie, then alphabetically so
    // the file does not change between runs over the same bodies.
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]));

  return {
    value: banned.map(([line]) => line),
    provenance: "observed",
    why: howOften(banned.map(([, count]) => count), bodies.length),
  };
}

/**
 * One sentence over a list of banned lines, true of all of them.
 *
 * It used to read `counts.get(value[0])` while `value` was sorted by length, so
 * "appears verbatim in 4 of 6 bodies" sat above a list whose second entry was in
 * all six: a count belonging to one entry, printed as though it described the
 * set. A sentence above a list has to be true of the list, so either every entry
 * shares a count and it is stated, or the range is.
 */
function howOften(counts: number[], bodies: number): string {
  // Nothing recurring is the ordinary outcome on a small sample, so say so
  // rather than reporting "appears verbatim in 0 of 3 bodies", which describes
  // a line that does not exist.
  if (counts.length === 0) {
    return "no line recurred often enough, or looked enough like instruction text, to ban";
  }
  if (counts.length === 1) return `appears verbatim in ${counts[0]} of ${bodies} bodies`;

  const least = Math.min(...counts);
  const most = Math.max(...counts);
  return least === most
    ? `${counts.length} line(s) each appear verbatim in ${most} of ${bodies} bodies`
    : `${counts.length} line(s) appear verbatim in ${least} to ${most} of ${bodies} bodies`;
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
 * How many bodies it takes before a share of them is evidence of a convention.
 *
 * One merged pull request carrying somebody's "## Note to self: revisit later"
 * is 100% of a sample of one; two agreeing is two people, not a house style. A
 * brand-new repository with one or two merged pull requests is precisely what
 * `init` is for, and the bot filter makes two an everyday sample rather than an
 * edge case — forty-eight dependabot merges and two written by people leaves
 * exactly two bodies to generalise from.
 *
 * Both settings that reject a later pull request answer to this one number.
 * They used to disagree: `required` wanted three bodies while a `forbidden`
 * substring ban fired on two, which had the more dangerous of the two settings
 * held to the weaker evidence. `forbidden` is matched with `body.includes` — it
 * rejects a pull request wherever those characters appear — so if either floor
 * were to move, it is this one that should move up, not the other down.
 */
export const MIN_BODIES_TO_GENERALISE = 3;

/**
 * What it takes to call a heading required.
 *
 * `required` is the setting that rejects a later pull request for not carrying
 * a section, so it is a claim about the team's convention, not about the sample.
 * Below the floor every heading is still reported — the names are real — but
 * none is marked required, and `why` says that is why.
 */
const REQUIRED_SHARE = 0.8;
const REQUIRED_MIN_BODIES = MIN_BODIES_TO_GENERALISE;

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
