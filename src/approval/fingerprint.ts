import { createHash } from "node:crypto";
import type { Warning } from "../preflight/types.js";

/** Everything an approval is bound to. */
export type Situation = {
  repo: string;
  branch: string;
  base: string;
  head: string;
  warnings: Warning[];
};

const VERSION = "shipkit-approval-v1";

/**
 * Renders a situation so that two implementations in two languages produce
 * identical bytes.
 *
 * Every value is prefixed with its UTF-8 byte length rather than escaped. A
 * delimiter that can occur inside a warning message is a disagreement waiting
 * for the first message that contains one, and escaping rules are exactly the
 * kind of detail two implementations get subtly different.
 *
 * Warning order is taken as given. `preflight` pushes its checks in a fixed
 * order, so the same situation always renders the same way, and sorting would
 * need a byte-wise comparator agreed across both languages for nothing.
 */
export function canonical(situation: Situation): string {
  const field = (value: string) => `${Buffer.byteLength(value, "utf8")}:${value}`;
  const lines = [
    VERSION,
    field(situation.repo),
    field(situation.branch),
    field(situation.base),
    field(situation.head),
    String(situation.warnings.length),
  ];
  for (const warning of situation.warnings) {
    lines.push(field(warning.check), field(warning.message));
  }
  return lines.join("\n");
}

/** Lowercase hex SHA-256 of the canonical form's UTF-8 bytes. */
export function fingerprint(situation: Situation): string {
  return createHash("sha256").update(canonical(situation), "utf8").digest("hex");
}
