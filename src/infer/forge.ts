import { parse } from "yaml";
import type { Inferred } from "./types.js";

// These parsers read data from a forge server this code has never spoken to — the
// fixtures they're tested against are written from GitHub's published schema, not
// captured live (see tests/fixtures/forge). A fixture proves the parser survives
// *that* shape; it cannot prove the shape is the one a real server sends. So every
// payload is walked defensively, one optional field at a time, and any shape that
// doesn't match what we expect yields undefined rather than a thrown error — the
// first run against a real server should diagnose itself, not crash.

/**
 * Reads the required branch-naming pattern out of a GitHub rulesets payload
 * (GET /repos/{owner}/{repo}/rulesets). Only a rule that is actually enforced —
 * `enforcement: "active"`, a `regex` operator, and a non-negated match — states a
 * requirement; anything else is disabled, a different kind of match, or a
 * prohibition rather than a requirement, so it is skipped rather than guessed at.
 */
export function branchPatternFromRulesets(payload: unknown): Inferred<string> | undefined {
  if (!Array.isArray(payload)) return undefined;

  for (const ruleset of payload) {
    if (typeof ruleset !== "object" || ruleset === null) continue;
    const { enforcement, rules, name } = ruleset as Record<string, unknown>;
    if (enforcement !== "active") continue;
    if (!Array.isArray(rules)) continue;

    for (const rule of rules) {
      if (typeof rule !== "object" || rule === null) continue;
      const { type, parameters } = rule as Record<string, unknown>;
      if (type !== "branch_name_pattern") continue;
      if (typeof parameters !== "object" || parameters === null) continue;

      const { operator, pattern, negate } = parameters as Record<string, unknown>;
      if (operator !== "regex") continue;
      if (negate) continue; // negate forbids the pattern rather than requiring it
      if (typeof pattern !== "string") continue;

      try {
        new RegExp(pattern);
      } catch {
        continue; // not a compilable regex — refuse rather than propose a broken one
      }

      const label = typeof name === "string" ? `ruleset "${name}"` : "an active ruleset";
      return { value: pattern, provenance: "read", why: `branch_name_pattern enforced by ${label}` };
    }
  }

  return undefined;
}

// Matches the label-name argument out of GitHub Actions expressions of the form
// contains(github.event.pull_request.labels.*.name, 'some label'), wherever they
// appear inside an `if:` condition.
const BLOCKING_LABEL = /contains\(\s*github\.event\.pull_request\.labels\.\*\.name\s*,\s*'([^']*)'\s*\)/g;

function collectBlockingLabels(node: unknown, labels: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectBlockingLabels(item, labels);
    return;
  }
  if (typeof node !== "object" || node === null) return;

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "if" && typeof value === "string") {
      for (const match of value.matchAll(BLOCKING_LABEL)) {
        labels.add(match[1]);
      }
    }
    collectBlockingLabels(value, labels);
  }
}

/**
 * Reads which labels block a merge out of a GitHub Actions workflow that gates on
 * them via `if: contains(github.event.pull_request.labels.*.name, '<label>')`.
 * Returns the labels sorted, so the result does not depend on the order steps
 * happen to appear in, and returns undefined — not `[]` — when no such gate is
 * found: "no gate exists" and "a gate that blocks nothing" are different claims,
 * and only the first is true when nothing matched.
 */
export function blockingLabelsFromWorkflow(yamlText: string): Inferred<string[]> | undefined {
  let doc: unknown;
  try {
    doc = parse(yamlText);
  } catch {
    return undefined;
  }

  const labels = new Set<string>();
  collectBlockingLabels(doc, labels);
  if (labels.size === 0) return undefined;

  const value = [...labels].sort();
  return {
    value,
    provenance: "read",
    why: `merge gate blocks on label(s): ${value.join(", ")}`,
  };
}
