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
