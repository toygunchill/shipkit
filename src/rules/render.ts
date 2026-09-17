import { stringify } from "yaml";
import type { Proposals } from "./propose.js";

/**
 * Everything derived is `advise`.
 *
 * `advise` never gates and never changes an exit code, so a proposal cannot block anyone's
 * push before a person has read it. `init` makes the same choice for the same reason,
 * defaulting `pr.approval` to `echo` rather than opting a team into `human` silently.
 * Raising a rule to `warn` or `block` stays a decision a team makes in writing.
 */
const DERIVED_SEVERITY = "advise";

function header(scanned: number, capped: boolean, covered: Proposals["covered"], absent: string[]): string {
  const lines = [
    "# A draft, not a checklist.",
    "#",
    "# shipkit did not read your team's mind or your review comments — it looked at the code",
    "# and kept the questions whose subject is actually here. The line above each rule says",
    "# what it saw. Delete what does not apply, rewrite what is nearly right, and raise the",
    "# severity of anything you mean to enforce.",
    "#",
    "# severity: advise never gates and never changes an exit code. warn asks a person on the",
    "# approval panel. block refuses the push. Everything below is advise, because nothing",
    "# should start gating your team's work before someone has read it.",
    "#",
    `# Read ${scanned.toLocaleString("en-US")} source ${scanned === 1 ? "file" : "files"}${
      capped ? " (the scan stopped there; the counts below are of what was read)" : ""
    }.`,
  ];
  if (covered.length > 0) {
    lines.push(
      "#",
      "# Left out — a tool you already run covers these, and a checklist that repeats the",
      "# linter teaches people to answer without reading:",
      ...covered.map((entry) => `#   ${entry.id}: ${entry.by}`),
    );
  }
  if (absent.length > 0) {
    lines.push(
      "#",
      "# Left out — nothing in this repository to ask about:",
      `#   ${absent.join(", ")}`,
    );
  }
  return lines.join("\n");
}

/**
 * The proposal as a file the readiness loader accepts.
 *
 * Built by `stringify`ing each rule on its own rather than the document whole, so a
 * provenance comment can sit above each one without the YAML library deciding where a
 * comment attaches — a mistake `init` made once and has a test for.
 */
export function renderRules(proposals: Proposals, scanned: number, capped: boolean): string {
  const body = proposals.rules
    .map((rule) => {
      const node = {
        id: rule.id,
        ask: rule.ask,
        why: rule.why,
        ...(rule.appliesTo === undefined ? {} : { appliesTo: rule.appliesTo }),
        severity: DERIVED_SEVERITY,
      };
      const yaml = stringify([node], { lineWidth: 0 }).trimEnd();
      return `  # observed: ${rule.evidence}\n${yaml
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n")}`;
    })
    .join("\n");

  return [
    header(scanned, capped, proposals.covered, proposals.absent),
    "",
    "version: 1",
    "rules:",
    body,
    "",
  ].join("\n");
}
