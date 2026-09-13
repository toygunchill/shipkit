import { boilerplateLines, sectionSkeleton } from "../infer/bodies.js";
import { blockingLabelsFromWorkflow, branchPatternFromRulesets } from "../infer/forge.js";
import { inferJira, type JiraGuess } from "../infer/jira.js";
import { renderConfig, type InitDraft } from "../infer/render.js";
import type { Inferred, SectionSkeleton } from "../infer/types.js";

/**
 * Where the facts come from. Every member may throw: there may be no remote, no
 * `gh` on the path, no permission on a private server. `runInit` calls each
 * inside its own try/catch and carries on with what it has, because a repository
 * with no forge access still needs a starter file — that is the common
 * bootstrap case, not an error.
 */
export type InitSources = {
  rulesets: () => unknown;
  mergeGateWorkflow: () => string | undefined;
  mergedBodies: (limit: number) => string[];
};

export type InitDeps = {
  sources: InitSources;
  exists: (path: string) => boolean;
  write: (path: string, text: string) => void;
  out: (line: string) => void;
  err: (line: string) => void;
};

export type InitResult = {
  code: number;
  wrote: boolean;
  /** Fields nothing could determine. Named to a human rather than invented. */
  unresolved: string[];
};

export type InitOptions = { config: string; force: boolean; limit: number };

/**
 * Accepts every branch name. Written only when no branch rule could be read.
 *
 * The alternative — proposing a plausible-looking convention — is the one
 * failure mode this command must not have: a pattern nobody chose, quietly
 * rejecting every branch the team actually uses. So the permissive pattern goes
 * in and `branch.pattern` is named in `unresolved`, where a human sees it.
 */
const PERMISSIVE_BRANCH = "^.+$";

/** The conventional-commits shape. A suggestion; nothing on a forge proves it. */
const CONVENTIONAL_TITLE = "^(feat|fix|chore|refactor|docs|test)(\\([a-z0-9-]+\\))?: .+";

/** The section named in the spec's worked example, proposed when nothing is readable. */
const DEFAULT_SECTIONS: SectionSkeleton[] = [
  { name: "Summary", required: true },
  { name: "Screenshots / Screen Recordings", required: true },
  { name: "What to Test", required: true, minItems: 3 },
  { name: "Issues Addressed", required: true },
];

/**
 * The section agents most often reduce to one vague line, so it carries a floor
 * on how many items it must hold — even when the section list itself came from
 * observation. `sectionSkeleton` observes names and required-ness only, so an
 * observed skeleton arrives with no `minItems` at all, and observing the past
 * faithfully would drop the very check that exists to correct it.
 */
const WHAT_TO_TEST = "what to test";
const WHAT_TO_TEST_MIN_ITEMS = 3;

/**
 * A heading in fewer than a tenth of the bodies is somebody's stray note, not a
 * section — but only once there are enough bodies for a tenth to mean anything.
 * One heading in 78 is noise; one in 4 is a real optional section, which is why
 * the floor is conditioned on the count rather than applied always.
 */
const NOISE_FLOOR = 0.1;
const NOISE_FLOOR_NEEDS_BODIES = 10;

/**
 * How many bodies must share a line verbatim before it counts as template text
 * nobody filled in: two thirds of what was actually read, never fewer than two.
 * A proportion rather than a constant, so six readable pull requests are not
 * held to a threshold designed for seventy-eight; a floor of two, because one
 * body cannot be evidence that anything recurs.
 */
function boilerplateThreshold(bodyCount: number): number {
  return Math.max(2, Math.ceil((bodyCount * 2) / 3));
}

/** Says what a payload actually was, so an unrecognised shape diagnoses itself. */
function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `an array of ${value.length} item(s)`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length === 0 ? "an object with no keys" : `an object with keys: ${keys.join(", ")}`;
  }
  return typeof value;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs one source, explaining itself rather than throwing.
 *
 * The outcome is a discriminated result, not a bare `undefined`, because for at
 * least one source — the rulesets — "nothing was read" and "something arrived
 * and made no sense" call for different messages, and an undefined cannot tell
 * them apart.
 */
type Attempt<T> = { read: true; value: T } | { read: false; value: undefined };

function attempt<T>(label: string, run: () => T, err: (line: string) => void): Attempt<T> {
  try {
    return { read: true, value: run() };
  } catch (error) {
    err(`Could not read ${label}: ${reason(error)}`);
    return { read: false, value: undefined };
  }
}

/** How many distinct bodies carry each `## ` heading. */
function headingCounts(bodies: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const body of bodies) {
    const seen = new Set<string>();
    for (const raw of body.split("\n")) {
      const match = /^##\s+(.+)$/.exec(raw.trim());
      if (match === null) continue;
      const name = match[1].trim();
      if (seen.has(name)) continue;
      seen.add(name);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return counts;
}

function branchPattern(payload: Attempt<unknown>, err: (line: string) => void): Inferred<string> {
  if (payload.read) {
    const read = branchPatternFromRulesets(payload.value);
    if (read !== undefined) return read;
    err(
      `No enforced branch_name_pattern rule in the rulesets payload (got ${describeShape(payload.value)}). ` +
        "Writing a branch.pattern that accepts everything rather than inventing one.",
    );
  }
  return {
    value: PERMISSIVE_BRANCH,
    provenance: "proposed",
    why: "no ruleset proved a branch convention; this accepts every branch name, so replace it",
  };
}

function blockingLabels(workflow: string | undefined): Inferred<string[]> {
  if (workflow !== undefined) {
    const read = blockingLabelsFromWorkflow(workflow);
    if (read !== undefined) return read;
  }
  return {
    value: [],
    provenance: "proposed",
    why: "no workflow gating on a pull-request label was found; add the labels that block a merge",
  };
}

function forbidden(bodies: string[]): Inferred<string[]> {
  if (bodies.length === 0) {
    return {
      value: [],
      provenance: "proposed",
      why: "no merged pull-request bodies were readable; add the template lines that mean nobody answered",
    };
  }
  const atLeast = boilerplateThreshold(bodies.length);
  const observed = boilerplateLines(bodies, atLeast);
  return {
    ...observed,
    why: `${observed.why} (counted as template text at ${atLeast} of ${bodies.length})`,
  };
}

function sections(bodies: string[]): Inferred<SectionSkeleton[]> {
  const proposed: Inferred<SectionSkeleton[]> = {
    value: DEFAULT_SECTIONS,
    provenance: "proposed",
    why: "no section headings could be observed; this is shipkit's suggested skeleton",
  };
  if (bodies.length === 0) return proposed;

  const observed = sectionSkeleton(bodies);
  const counts = headingCounts(bodies);
  const floored =
    bodies.length > NOISE_FLOOR_NEEDS_BODIES
      ? observed.value.filter((s) => (counts.get(s.name) ?? 0) / bodies.length >= NOISE_FLOOR)
      : observed.value;
  if (floored.length === 0) return proposed;

  const dropped = observed.value.length - floored.length;
  let addedMinItems = false;
  const value = floored.map((section) => {
    if (section.name.trim().toLowerCase() !== WHAT_TO_TEST) return section;
    if (section.minItems !== undefined) return section;
    addedMinItems = true;
    return { ...section, minItems: WHAT_TO_TEST_MIN_ITEMS };
  });

  const notes = [observed.why];
  if (dropped > 0) {
    notes.push(`${dropped} heading(s) seen in under ${NOISE_FLOOR * 100}% of them dropped as noise`);
  }
  if (addedMinItems) {
    notes.push(`minItems ${WHAT_TO_TEST_MIN_ITEMS} on "What to Test" is proposed, not observed`);
  }
  return { value, provenance: "observed", why: notes.join("; ") };
}

function jira(bodies: string[]): Inferred<JiraGuess> {
  const observed = bodies.length === 0 ? undefined : inferJira(bodies);
  if (observed !== undefined && observed.value.baseUrl !== undefined) return observed;
  return {
    value: {},
    provenance: "proposed",
    // Not "observed": the value that reaches the file is a placeholder host, and
    // labelling a placeholder as something merged pull requests contain would be
    // a lie in the one column of this file a reader is meant to trust.
    why:
      observed?.why ??
      "no merged pull-request bodies were readable, so no Jira link could be found",
  };
}

/**
 * Writes a starter config, saying of every field whether the forge proved it,
 * merged pull requests merely show it, or shipkit is suggesting it.
 *
 * Returns 0 when a file was written and 2 when it refused to overwrite one.
 * A source that fails is not a failure of the command.
 */
export function runInit(options: InitOptions, deps: InitDeps): InitResult {
  if (deps.exists(options.config) && !options.force) {
    deps.err(`${options.config} already exists. Pass --force to overwrite it.`);
    return { code: 2, wrote: false, unresolved: [] };
  }

  // Each source in its own try/catch: one unreachable forge must not cost us the
  // three facts the other sources could still have given.
  const bodies =
    attempt("merged pull-request bodies", () => deps.sources.mergedBodies(options.limit), deps.err)
      .value ?? [];
  const rulesets = attempt("the repository rulesets", () => deps.sources.rulesets(), deps.err);
  const workflow = attempt("the merge-gate workflow", () => deps.sources.mergeGateWorkflow(), deps.err);

  const draft: InitDraft = {
    titlePattern: {
      value: CONVENTIONAL_TITLE,
      provenance: "proposed",
      why: "the conventional-commits shape; nothing on a forge states a title convention",
    },
    branchPattern: branchPattern(rulesets, deps.err),
    forbidden: forbidden(bodies),
    blockingLabels: blockingLabels(workflow.value),
    sections: sections(bodies),
    jira: jira(bodies),
  };

  // Only a forge-proved branch pattern counts as resolved. Anything else in that
  // field is `^.+$`, which enforces nothing — and a permissive pattern nobody is
  // told about is how a bootstrap turns into a rule that silently never fires.
  const unresolved: string[] = [];
  if (draft.branchPattern.provenance !== "read") unresolved.push("branch.pattern");
  if (draft.jira.value.baseUrl === undefined) unresolved.push("jira.baseUrl");

  try {
    deps.write(options.config, renderConfig(draft));
  } catch (error) {
    deps.err(`Cannot write ${options.config}: ${reason(error)}`);
    return { code: 2, wrote: false, unresolved };
  }

  deps.out(`Wrote ${options.config}`);
  for (const [field, inferred] of summaryOrder(draft)) {
    deps.out(`  ${field}: ${inferred.provenance} — ${inferred.why}`);
  }
  if (unresolved.length > 0) {
    deps.err(
      `Could not be determined and needs a human: ${unresolved.join(", ")}. ` +
        `Each is a placeholder in ${options.config}, not a convention shipkit read anywhere.`,
    );
  }

  return { code: 0, wrote: true, unresolved };
}

function summaryOrder(draft: InitDraft): [string, Inferred<unknown>][] {
  return [
    ["pr.titlePattern", draft.titlePattern],
    ["pr.forbidden", draft.forbidden],
    ["pr.blockingLabels", draft.blockingLabels],
    ["pr.sections", draft.sections],
    ["branch.pattern", draft.branchPattern],
    ["jira", draft.jira],
  ];
}
