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
 * What a rulesets payload states about branch naming.
 *
 * Three outcomes rather than a value-or-nothing, because "no ruleset names a
 * pattern" and "every pattern that exists is scoped to a subset of refs" are
 * different facts and want different things written into the config. The second
 * is the ordinary GitHub layout — one ruleset over `refs/heads/release/*`, one
 * over everything — and reporting the release pattern as *the* branch convention
 * makes every feature branch fail `branch-pattern`.
 */
export type RulesetBranchPattern =
  /** A ruleset that governs every ref requires this pattern. */
  | { kind: "required"; inferred: Inferred<string> }
  /** Patterns exist, but each governs only a subset of refs. Human-readable scopes. */
  | { kind: "ref-scoped"; scopes: string[] }
  /** Nothing in the payload states a branch-naming requirement. */
  | { kind: "none" };

/** GitHub's stand-in, in `conditions.ref_name.include`, for "every ref in the repository". */
const ALL_REFS = "~ALL";

/** GitHub's stand-in for "whatever this repository's default branch is called". */
const DEFAULT_BRANCH_REF = "~DEFAULT_BRANCH";

/** The prefix a branch ref carries, as distinct from a tag's or a note's. */
const BRANCH_PREFIX = "refs/heads/";

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * Whether excluding this ref narrows what a branch-naming pattern asks of the
 * branches people create.
 *
 * Not every exclusion scopes a ruleset. A branch-naming rule almost has to carry
 * one — `^(feature|bugfix)/…` cannot apply to `main`, which was created before
 * the convention and cannot be renamed to suit it — so `include: ["~ALL"]` with
 * `exclude: ["~DEFAULT_BRANCH"]` is the canonical shape of exactly the ruleset
 * this function exists to find. Treating any non-empty exclusion as ref-scoped
 * threw that away and wrote `^.+$` instead: capability lost on the commonest
 * real payload.
 *
 * So an exclusion counts only when it takes away something the pattern would
 * otherwise have required:
 *
 *   - `~DEFAULT_BRANCH` never does. That is what it is for.
 *   - a literal branch ref does only if the pattern matches it. Excluding
 *     `refs/heads/main` from `^(feature|bugfix)/…` removes a branch the rule
 *     would have rejected anyway; excluding it from `^.+$` really does carve
 *     something out.
 *   - anything else counts: a glob (`refs/heads/legacy/*`) names branches this
 *     code cannot enumerate, and a ref outside `refs/heads/` — a tag, or a
 *     token this parser has not seen — is not something to reason about. Both
 *     err towards calling the ruleset scoped, which is the direction that loses
 *     a pattern rather than imposing a wrong one.
 */
function narrowsTheConvention(excluded: string, pattern: string): boolean {
  const ref = excluded.trim();
  if (ref === DEFAULT_BRANCH_REF) return false;
  if (!ref.startsWith(BRANCH_PREFIX)) return true;

  const branch = ref.slice(BRANCH_PREFIX.length);
  if (/[*?[\]]/.test(branch)) return true; // a glob: which branches it names is unknown

  try {
    return new RegExp(pattern).test(branch);
  } catch {
    return true; // an uncompilable pattern proves nothing about the exclusion
  }
}

/**
 * Describes the subset of refs a ruleset applies to, or undefined when it applies
 * to every branch the pattern could govern.
 *
 * Absent or unreadable `conditions` count as "all refs": nothing in the payload
 * says otherwise, and this is the shape the older fixtures have. A `~ALL` include
 * is still not all refs once an exclusion takes branches away from it — but only
 * an exclusion that takes away branches the pattern was asking about; see
 * `narrowsTheConvention`. The scope reported back names the exclusions as the
 * payload wrote them, immaterial ones included: it describes the ruleset, and
 * the human reading it should see what it actually said.
 */
function refScope(conditions: unknown, pattern: string): string | undefined {
  if (typeof conditions !== "object" || conditions === null) return undefined;
  const refName = (conditions as Record<string, unknown>).ref_name;
  if (typeof refName !== "object" || refName === null) return undefined;

  const { include, exclude } = refName as Record<string, unknown>;
  const included = strings(include);
  const excluded = strings(exclude) ?? [];

  if (included === undefined) {
    // A ref_name that carries no readable include list. Unrecognised, so not
    // something to quote as a repository-wide fact.
    return "an unreadable ref_name condition";
  }
  const narrowing = excluded.filter((ref) => narrowsTheConvention(ref, pattern));
  if (included.includes(ALL_REFS) && narrowing.length === 0) return undefined;

  const scope = included.length === 0 ? "no refs" : included.join(", ");
  return excluded.length === 0 ? scope : `${scope} except ${excluded.join(", ")}`;
}

/**
 * The branch pattern one ruleset's rules require, if any.
 *
 * Only a rule that is actually enforced — a `regex` operator, a non-negated
 * match, and a pattern with something in it — states a requirement; anything else
 * is a different kind of match, a prohibition, or (for `""` and `"   "`) a value
 * that would go into the config claiming to be read from the forge while matching
 * nothing anybody's branch is called.
 */
function requiredPattern(rules: unknown[]): string | undefined {
  for (const rule of rules) {
    if (typeof rule !== "object" || rule === null) continue;
    const { type, parameters } = rule as Record<string, unknown>;
    if (type !== "branch_name_pattern") continue;
    if (typeof parameters !== "object" || parameters === null) continue;

    const { operator, pattern, negate } = parameters as Record<string, unknown>;
    if (operator !== "regex") continue;
    if (negate) continue; // negate forbids the pattern rather than requiring it
    if (typeof pattern !== "string") continue;
    if (pattern.trim().length === 0) continue; // states no requirement worth writing down

    try {
      new RegExp(pattern);
    } catch {
      continue; // not a compilable regex — refuse rather than propose a broken one
    }

    return pattern;
  }
  return undefined;
}

/**
 * Reads the required branch-naming pattern out of a GitHub rulesets payload
 * (GET /repos/{owner}/{repo}/rulesets).
 *
 * A ruleset whose `conditions` scope it to a subset of refs does not describe how
 * the team names branches generally, so one governing every ref is preferred
 * however late in the list it appears, and a payload holding only ref-scoped ones
 * reports itself as such rather than passing off a release convention as the
 * repository's.
 */
export function branchPatternFromRulesets(payload: unknown): RulesetBranchPattern {
  if (!Array.isArray(payload)) return { kind: "none" };

  const scopes: string[] = [];

  for (const ruleset of payload) {
    if (typeof ruleset !== "object" || ruleset === null) continue;
    const { enforcement, rules, name, conditions } = ruleset as Record<string, unknown>;
    if (enforcement !== "active") continue;
    if (!Array.isArray(rules)) continue;

    const pattern = requiredPattern(rules);
    if (pattern === undefined) continue;

    const label =
      typeof name === "string" && name.trim().length > 0 ? `ruleset "${name}"` : "an active ruleset";

    const scope = refScope(conditions, pattern);
    if (scope !== undefined) {
      scopes.push(`${label}, scoped to ${scope}`);
      continue;
    }

    return {
      kind: "required",
      inferred: {
        value: pattern,
        provenance: "read",
        why: `branch_name_pattern enforced by ${label} over every ref`,
      },
    };
  }

  return scopes.length === 0 ? { kind: "none" } : { kind: "ref-scoped", scopes };
}

// Matches the label-name argument out of GitHub Actions expressions of the form
// contains(github.event.pull_request.labels.*.name, 'some label'), wherever they
// appear inside an `if:` condition.
const BLOCKING_LABEL = /contains\(\s*github\.event\.pull_request\.labels\.\*\.name\s*,\s*'([^']*)'\s*\)/g;

/**
 * Whether the `contains(...)` call starting at `index` is negated.
 *
 * `!contains(labels, 'skip changelog')` describes a job that runs when the label
 * is *absent* — an opt-out. Recording it as a blocking label quotes the forge as
 * proving the reverse of what it says, so the leading `!` is looked for through
 * any whitespace and opening parentheses (`! contains`, `!(contains`) between it
 * and the call. A negation further out than that — `!(a && contains(...))` — is
 * not recognised; the miss costs a label, which is the cheaper direction to err in.
 */
function isNegated(expression: string, index: number): boolean {
  let at = index - 1;
  while (at >= 0 && (/\s/.test(expression[at]) || expression[at] === "(")) at -= 1;
  return at >= 0 && expression[at] === "!";
}

/**
 * Walks a parsed workflow for `if:` conditions, visiting each node once.
 *
 * `seen` is not an optimisation. A YAML anchor may refer to itself —
 * `jobs: &j\n  a:\n    steps: *j` — and the `yaml` package parses that happily
 * into a structure that points back at itself, at which point an unguarded walk
 * recurses until the stack gives out. That RangeError reached `runInit`, which
 * calls this one inference outside any try/catch of its own, so a workflow file
 * a person is free to write took the whole command down.
 *
 * A depth cap would not have been the fix: depth on its own never gets this far,
 * because the parser's own recursion gives out first and reports it as a parse
 * error that `blockingLabelsFromWorkflow` already tolerates. A cycle is what
 * gets past the parser, so a cycle is what is guarded.
 *
 * Visiting a shared (non-cyclic) alias once is the same answer as visiting it
 * twice: labels land in a set either way.
 */
function collectBlockingLabels(node: unknown, labels: Set<string>, seen: Set<object>): void {
  if (typeof node !== "object" || node === null) return;
  if (seen.has(node)) return;
  seen.add(node);

  if (Array.isArray(node)) {
    for (const item of node) collectBlockingLabels(item, labels, seen);
    return;
  }

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "if" && typeof value === "string") {
      for (const match of value.matchAll(BLOCKING_LABEL)) {
        if (isNegated(value, match.index ?? 0)) continue;
        labels.add(match[1]);
      }
    }
    collectBlockingLabels(value, labels, seen);
  }
}

const PULL_REQUEST_EVENTS = new Set(["pull_request", "pull_request_target"]);

/**
 * Whether the workflow runs on pull requests at all.
 *
 * An `if:` on a job in an `on: [push, schedule]` nightly is not a merge gate, and
 * a condition read out of one is a claim the workflow does not make. `on` may be a
 * string, a list or a map of event names; a YAML 1.1 reader would also turn the
 * key itself into the boolean `true`, which this parser (1.2) does not — the
 * `"true"` lookup is there so the answer does not depend on that staying true.
 */
function triggersOnPullRequest(doc: unknown): boolean {
  if (typeof doc !== "object" || doc === null) return false;
  const record = doc as Record<string, unknown>;
  const on = record.on ?? record["true"];

  if (typeof on === "string") return PULL_REQUEST_EVENTS.has(on);
  if (Array.isArray(on)) {
    return on.some((event) => typeof event === "string" && PULL_REQUEST_EVENTS.has(event));
  }
  if (typeof on === "object" && on !== null) {
    return Object.keys(on as Record<string, unknown>).some((event) =>
      PULL_REQUEST_EVENTS.has(event),
    );
  }
  return false;
}

/**
 * Reads which labels block a merge out of a GitHub Actions workflow that gates on
 * them via `if: contains(github.event.pull_request.labels.*.name, '<label>')`.
 * Returns the labels sorted, so the result does not depend on the order steps
 * happen to appear in, and returns undefined — not `[]` — when no such gate is
 * found: "no gate exists" and "a gate that blocks nothing" are different claims,
 * and only the first is true when nothing matched.
 *
 * A workflow that does not trigger on pull requests has no merge gate to read, and
 * a negated condition is an opt-out rather than a gate; neither contributes.
 */
export function blockingLabelsFromWorkflow(yamlText: string): Inferred<string[]> | undefined {
  let doc: unknown;
  try {
    doc = parse(yamlText);
  } catch {
    return undefined;
  }

  if (!triggersOnPullRequest(doc)) return undefined;

  const labels = new Set<string>();
  collectBlockingLabels(doc, labels, new Set());
  if (labels.size === 0) return undefined;

  const value = [...labels].sort();
  return {
    value,
    provenance: "read",
    why: `merge gate blocks on label(s): ${value.join(", ")}`,
  };
}
