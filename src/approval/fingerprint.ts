import { createHash } from "node:crypto";
import type { Warning } from "../preflight/types.js";

/** Everything an approval is bound to. */
export type Situation = {
  repo: string;
  branch: string;
  base: string;
  head: string;
  /** The pull-request title, as the application displays it. */
  title: string;
  /** The commit message, as the application displays it. */
  commitMessage: string;
  /** The size of the change, as the application displays it. */
  diffstat: string;
  warnings: Warning[];
};

/**
 * The marker for *this* canonical form, bumped to v2 when `diffstat` joined the
 * hash. Deliberately not `PROTOCOL_VERSION`, which stays at 1: the wire shape
 * did not change — `diffstat` was always transmitted and the application always
 * displayed it — only what is bound did. Resyncing the two would announce a
 * version disagreement to every surface that is in fact perfectly compatible,
 * and a shipkit and an application that disagree about the hash already refuse
 * each other by fingerprint mismatch, which is the check that matters.
 */
const VERSION = "shipkit-approval-v2";

/**
 * Warnings ordered by check id, then message, using code-unit order — the same order
 * `canonical` hashes them in. `run.ts` sends the request's warnings through this before
 * putting them on the wire, so the order a person is shown can never diverge from the order
 * that was hashed.
 */
export function sortWarnings(warnings: Warning[]): Warning[] {
  return [...warnings].sort((a, b) => {
    if (a.check !== b.check) return a.check < b.check ? -1 : 1;
    if (a.message !== b.message) return a.message < b.message ? -1 : 1;
    return 0;
  });
}

/**
 * Renders a situation so that two implementations in two languages produce
 * identical bytes.
 *
 * Every value is prefixed with its UTF-8 byte length rather than escaped. A
 * delimiter that can occur inside a warning message is a disagreement waiting
 * for the first message that contains one, and escaping rules are exactly the
 * kind of detail two implementations get subtly different.
 *
 * Warnings are sorted by check id, then message, using code-unit order (the
 * order that `<` and `>` produce in JavaScript and Swift). This avoids
 * locale-sensitive collation which would produce different results on machines
 * with different default locales, making the fixture non-portable. For these
 * strings (ASCII check ids and UTF-8 messages), code-unit order equals byte
 * order, ensuring both implementations agree.
 *
 * UTF-8 encoding substitutes unpaired UTF-16 surrogates with U+FFFD before
 * counting and hashing. Both `Buffer.byteLength(value, "utf8")` and
 * `createHash().update(value, "utf8")` apply this substitution; a Swift
 * implementation must do the same or reject such input.
 */
export function canonical(situation: Situation): string {
  const field = (value: string) => `${Buffer.byteLength(value, "utf8")}:${value}`;
  const sorted = sortWarnings(situation.warnings);
  const lines = [
    VERSION,
    field(situation.repo),
    field(situation.branch),
    field(situation.base),
    field(situation.head),
    field(situation.title),
    field(situation.commitMessage),
    field(situation.diffstat),
    String(sorted.length),
  ];
  for (const warning of sorted) {
    lines.push(field(warning.check), field(warning.message));
  }
  return lines.join("\n");
}

/** Lowercase hex SHA-256 of the canonical form's UTF-8 bytes. */
export function fingerprint(situation: Situation): string {
  return createHash("sha256").update(canonical(situation), "utf8").digest("hex");
}

/**
 * The field names that differ between two situations, in a fixed order. Built for the
 * refusal after a fingerprint mismatch: "the situation changed" tells a person nothing
 * they can act on, but "diffstat changed" points straight at the watcher or autosave that
 * touched the tree during the wait. `warnings` counts as one field — naming which warning
 * changed would mean explaining preflight's check ids to someone who approved a push, not
 * a preflight run.
 */
export function changedFields(before: Situation, after: Situation): string[] {
  const changed: string[] = [];
  if (before.repo !== after.repo) changed.push("repo");
  if (before.branch !== after.branch) changed.push("branch");
  if (before.base !== after.base) changed.push("base");
  if (before.head !== after.head) changed.push("head");
  if (before.title !== after.title) changed.push("title");
  if (before.commitMessage !== after.commitMessage) changed.push("commitMessage");
  if (before.diffstat !== after.diffstat) changed.push("diffstat");
  if (canonicalWarnings(before.warnings) !== canonicalWarnings(after.warnings)) {
    changed.push("warnings");
  }
  return changed;
}

// Same length-prefixing `canonical` uses, for the same reason: a plain `\n` join could
// call two genuinely different warning lists equal if a check id or message happens to
// contain the delimiter. This only feeds a diagnostic message, never the hash itself, but
// there is no reason to give it a weaker equality check than the one that matters.
function canonicalWarnings(warnings: Warning[]): string {
  const field = (value: string) => `${Buffer.byteLength(value, "utf8")}:${value}`;
  return sortWarnings(warnings)
    .map((warning) => `${field(warning.check)}\n${field(warning.message)}`)
    .join("\n");
}

/**
 * Everything a review offer is bound to.
 *
 * The same property the approval situation has, for the same reason: what the person sees is
 * what was hashed, so a panel cannot display one review and answer a different one. `head` is
 * absent because a review happens before there is a commit to name, and `title` because
 * nothing has been drafted when a review runs without `--input`.
 */
export type ReviewSituation = {
  /** The repository's name, as the panel displays it. */
  repo: string;
  /**
   * The checkout's absolute path, which the panel never displays and the editor
   * button resolves a file against.
   *
   * Bound into the hash even though nobody reads it, because the property this
   * fingerprint protects is not only "what is shown" but "what happens when a
   * button is pressed": `root` decides which file on this machine opens, and a
   * field that steers a side effect is exactly a field that must not be
   * changeable between the hash and the click.
   */
  root: string;
  /**
   * Where shipkit's own review page is, token and all.
   *
   * Bound for the reason `root` is: the panel's primary action opens this, so
   * it steers what happens when a button is pressed, and a field that does that
   * must not be changeable between the hash and the click.
   */
  url: string;
  branch: string;
  base: string;
  /** Empty when the review is running without an agent's answer. */
  commitMessage: string;
  diffstat: string;
  items: readonly { kind: string; id: string; message: string; severity: string }[];
  files: readonly { path: string; status: string; line: number }[];
};

/** The marker for the review canonical form, versioned separately from the approval one. */
const REVIEW_VERSION = "shipkit-review-v1";

/**
 * Renders a review offer so that two implementations in two languages produce identical
 * bytes. Length-prefixed exactly like `canonical`, and for exactly the same reason: a
 * delimiter that can occur inside a message is a disagreement waiting for the first message
 * that contains one.
 *
 * Nothing is sorted. Warnings are sorted in an approval because their order is arbitrary and
 * two runs could produce it differently; review items arrive in a deliberate order —
 * refusals first, then warnings, then advice — and that order is part of what the person
 * reads. Sorting here would hash something other than what is shown, which is the one thing
 * a fingerprint exists to prevent.
 */
export function canonicalReview(situation: ReviewSituation): string {
  const field = (value: string) => `${Buffer.byteLength(value, "utf8")}:${value}`;
  const lines = [
    REVIEW_VERSION,
    field(situation.repo),
    field(situation.root),
    field(situation.url),
    field(situation.branch),
    field(situation.base),
    field(situation.commitMessage),
    field(situation.diffstat),
    String(situation.items.length),
  ];
  for (const item of situation.items) {
    lines.push(field(item.kind), field(item.id), field(item.message), field(item.severity));
  }
  lines.push(String(situation.files.length));
  for (const file of situation.files) {
    lines.push(field(file.path), field(file.status), String(file.line));
  }
  return lines.join("\n");
}

/** Lowercase hex SHA-256 of the review canonical form's UTF-8 bytes. */
export function reviewFingerprint(situation: ReviewSituation): string {
  return createHash("sha256").update(canonicalReview(situation), "utf8").digest("hex");
}
