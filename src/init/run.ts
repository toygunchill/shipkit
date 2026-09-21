import { basename, dirname, join } from "node:path";
import { parse } from "yaml";
import { configSchema } from "../config/schema.js";
import { boilerplateLines, MIN_BODIES_TO_GENERALISE, sectionSkeleton } from "../infer/bodies.js";
import { blockingLabelsFromWorkflow, branchPatternFromRulesets } from "../infer/forge.js";
import { inferJira, type JiraGuess } from "../infer/jira.js";
import { renderConfig, type InitDraft } from "../infer/render.js";
import type { Inferred, SectionSkeleton } from "../infer/types.js";

/**
 * One merged pull request, as much of it as the forge would say.
 *
 * The author comes back with the body because most merged pull requests in many
 * repositories are bot merges, and a sample of ten dependabot bodies plus one
 * human's infers dependabot's template as the house style — including a required
 * "Release notes" section that the human pull request in the very same sample
 * then fails.
 */
export type MergedPullRequest = {
  body: string;
  /** The author's login, when the forge reported one. */
  author?: string;
  /** Whether the forge itself called that author a bot. */
  authorIsBot?: boolean;
};

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
  mergedPullRequests: (limit: number) => MergedPullRequest[];
};

export type InitDeps = {
  sources: InitSources;
  exists: (path: string) => boolean;
  write: (path: string, text: string) => void;
  out: (line: string) => void;
  err: (line: string) => void;
  /**
   * Proposes a readiness checklist from the code, as `shipkit rules` does.
   *
   * Optional so a caller can set shipkit up without one — and so tests can leave it out.
   * It is part of `init` because a repository needs both halves to be set up, and a person
   * who runs one command reasonably expects to be set up. Leaving the second to be
   * discovered later means it is discovered by nobody.
   *
   * Returns `undefined` when there is nothing to propose, which is a real answer: the
   * catalogue found no rule whose subject is in this repository.
   */
  proposeReadiness?: (() => string | undefined) | undefined;
};

export type InitResult = {
  code: number;
  wrote: boolean;
  /** Fields nothing could determine. Named to a human rather than invented. */
  unresolved: string[];
  /** Where the readiness checklist was written, when one was proposed. */
  readinessPath?: string;
};

export type InitOptions = {
  config: string;
  force: boolean;
  limit: number;
  /**
   * Where a proposed readiness checklist goes, beside the config.
   *
   * Sibling-relative, because that is how `readiness:` is resolved — against the realpath
   * of the config, so a symlinked deployment finds the rules beside the link's target.
   */
  readinessFile?: string;
};

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

/** Where the spec's worked example cites its issue keys. */
const DEFAULT_JIRA_SECTION = "Issues Addressed";

/** Section names that read as the place issue keys are cited. */
const ISSUE_SECTION = /\b(issues?|tickets?|jira|stor(y|ies))\b/i;

/**
 * Logins a forge does not always flag as bots.
 *
 * `gh` reports `author.is_bot`, and that is believed first; this is the fallback
 * for the accounts it misses — `app/dependabot`, anything ending in `[bot]`, and
 * the handful of automations that merge under plain user accounts.
 */
const BOT_LOGIN = /(\[bot\]$|^app\/|^(dependabot|renovate|renovate-bot|github-actions|mergify|snyk-bot|imgbot|greenkeeper)$)/i;

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
 * nobody filled in: two thirds of what was actually read, never fewer than the
 * sample it takes to generalise at all. A proportion rather than a constant, so
 * six readable pull requests are not held to a threshold designed for
 * seventy-eight; a floor, because a handful of bodies agreeing is not a
 * convention — and this is the same floor `sectionSkeleton` holds `required` to,
 * which is the point (see MIN_BODIES_TO_GENERALISE).
 */
function boilerplateThreshold(bodyCount: number): number {
  return Math.max(MIN_BODIES_TO_GENERALISE, Math.ceil((bodyCount * 2) / 3));
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

/**
 * The bodies the inference actually ran on, and what was left out of them.
 *
 * The spec seeds the starter from the project's best-formed pull requests. A
 * repository's merged list is not that sample: bot merges dominate it, and their
 * bodies are the most uniform text in the repository, which is exactly what every
 * "most bodies agree" test in here mistakes for a convention.
 */
type Sample = { bodies: string[]; read: number; skipped: number };

function authoredByBot(pull: MergedPullRequest): boolean {
  if (pull.authorIsBot === true) return true;
  return typeof pull.author === "string" && BOT_LOGIN.test(pull.author.trim());
}

function sampleOf(pulls: MergedPullRequest[]): Sample {
  const bodies: string[] = [];
  let skipped = 0;
  for (const pull of pulls) {
    if (typeof pull?.body !== "string" || pull.body.trim().length === 0) continue;
    if (authoredByBot(pull)) {
      skipped += 1;
      continue;
    }
    bodies.push(pull.body);
  }
  return { bodies, read: bodies.length, skipped };
}

/** Says what the sample was, so "most bodies agree" can be weighed against how many. */
function sampleNote(sample: Sample): string {
  if (sample.skipped === 0) return `${sample.read} merged pull request(s) read`;
  return (
    `${sample.read} of ${sample.read + sample.skipped} merged pull request(s) read; ` +
    `${sample.skipped} skipped as bot-authored`
  );
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
    const reading = branchPatternFromRulesets(payload.value);
    if (reading.kind === "required") return reading.inferred;

    if (reading.kind === "ref-scoped") {
      // The pattern is real, but it governs release refs (or some other subset),
      // not how branches are named in general. Writing it here would reject every
      // feature branch on the first `check`, under a comment claiming the forge
      // said so.
      const scopes = reading.scopes.join("; ");
      err(
        `Every enforced branch_name_pattern rule is scoped to a subset of refs (${scopes}). ` +
          "A rule for some refs is not a naming convention for all of them, so branch.pattern " +
          "accepts everything and is left for a human.",
      );
      return {
        value: PERMISSIVE_BRANCH,
        provenance: "proposed",
        why:
          `the only enforced branch_name_pattern rules govern a subset of refs (${scopes}), ` +
          "which does not say how branches are named generally; this accepts every branch name, so replace it",
      };
    }

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

function forbidden(sample: Sample): Inferred<string[]> {
  const bodies = sample.bodies;

  // Below the floor the threshold cannot be met, so the answer is always the
  // empty list — and reporting the arithmetic behind that, "counted as template
  // text at 3 of 2", reads as a bug to anyone who opens the file. Say what
  // actually happened instead.
  if (bodies.length < MIN_BODIES_TO_GENERALISE) {
    const nothing =
      bodies.length === 0
        ? "no merged pull-request body was readable"
        : bodies.length === 1
          ? "one body cannot show that a line recurs, so nothing counted as template text"
          : `${bodies.length} bodies cannot show a convention, and a forbidden line is matched ` +
            `anywhere in a body, so it takes ${MIN_BODIES_TO_GENERALISE} before one is worth banning`;
    return {
      value: [],
      provenance: "proposed",
      why: `${nothing} (${sampleNote(sample)}); add the template lines that mean nobody answered`,
    };
  }

  const atLeast = boilerplateThreshold(bodies.length);
  const observed = boilerplateLines(bodies, atLeast);
  return {
    ...observed,
    why: `${observed.why} (counted as template text at ${atLeast} of ${bodies.length}; ${sampleNote(sample)})`,
  };
}

function sections(sample: Sample): Inferred<SectionSkeleton[]> {
  const bodies = sample.bodies;
  const proposed: Inferred<SectionSkeleton[]> = {
    value: DEFAULT_SECTIONS,
    provenance: "proposed",
    why: `no section headings could be observed (${sampleNote(sample)}); this is shipkit's suggested skeleton`,
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

  const notes = [`${observed.why} (${sampleNote(sample)})`];
  if (dropped > 0) {
    notes.push(`${dropped} heading(s) seen in under ${NOISE_FLOOR * 100}% of them dropped as noise`);
  }
  if (addedMinItems) {
    notes.push(`minItems ${WHAT_TO_TEST_MIN_ITEMS} on "What to Test" is proposed, not observed`);
  }
  return { value, provenance: "observed", why: notes.join("; ") };
}

/**
 * The schema's own opinion of what a `jira.baseUrl` may be, borrowed rather than
 * restated — a second definition of "is a URL" would drift from the one `check`
 * enforces, and the whole point is that they agree.
 */
const BASE_URL = configSchema.shape.jira.shape.baseUrl;

function jira(sample: Sample): Inferred<JiraGuess> {
  const bodies = sample.bodies;
  const observed = bodies.length === 0 ? undefined : inferJira(bodies);
  const link = observed?.value.baseUrl;

  if (link !== undefined && BASE_URL.safeParse(link).success) {
    return { ...observed!, why: `${observed!.why} (${sampleNote(sample)})` };
  }

  // A host scraped out of prose is not necessarily a URL: `https://a<b/browse/X-1`
  // is a link somebody typed and `check` cannot load a config holding it. Refusing
  // the value and saying so beats writing a file that will not parse.
  const unusable =
    link === undefined
      ? undefined
      : `the most-linked Jira host in those bodies, ${JSON.stringify(link)}, is not a URL this config can hold`;

  return {
    value: {},
    provenance: "proposed",
    // Not "observed": the value that reaches the file is a placeholder host, and
    // labelling a placeholder as something merged pull requests contain would be
    // a lie in the one column of this file a reader is meant to trust.
    why: `${
      unusable ??
      observed?.why ??
      "no merged pull-request bodies were readable, so no Jira link could be found"
    } (${sampleNote(sample)})`,
  };
}

/**
 * Which section the issue-key rule reads.
 *
 * `validate` only checks for an issue key when the section `jira.section` names is
 * present in the body, so a hardcoded "Issues Addressed" over sections called
 * ["Summary", "Ticket"] is not a strict rule — it is a rule that never runs, and
 * nothing on the page says so. Name a section that exists, or say plainly that
 * none of them looked like the place issue keys are cited.
 *
 * Always `proposed`, never the section list's own label. What was observed is
 * that a section called "Ticket" exists; that "Ticket" is where issue keys go is
 * shipkit's guess, made by ISSUE_SECTION over its name. Borrowing `observed`
 * from the list put that guess in the column of this file a reader is meant to
 * be able to trust without checking.
 */
function jiraSection(sections: Inferred<SectionSkeleton[]>): Inferred<string> {
  const names = sections.value.map((section) => section.name);
  const named =
    names.find((name) => name.trim().toLowerCase() === DEFAULT_JIRA_SECTION.toLowerCase()) ??
    names.find((name) => ISSUE_SECTION.test(name));

  if (named !== undefined) {
    return {
      value: named,
      provenance: "proposed",
      why:
        `the section above that reads as where issue keys are cited — the name is observed, ` +
        `picking it as the one is shipkit's guess; jira.keyPattern is checked inside "${named}" and nowhere else`,
    };
  }

  return {
    value: DEFAULT_JIRA_SECTION,
    provenance: "proposed",
    why:
      `none of the sections above (${names.join(", ")}) names the place issue keys are cited, ` +
      `so the issue-key rule will not run until this points at a section that exists`,
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
  const pulls =
    attempt(
      "merged pull requests",
      () => deps.sources.mergedPullRequests(options.limit),
      deps.err,
    ).value ?? [];
  const rulesets = attempt("the repository rulesets", () => deps.sources.rulesets(), deps.err);
  const workflow = attempt("the merge-gate workflow", () => deps.sources.mergeGateWorkflow(), deps.err);

  const sample = sampleOf(pulls);
  if (sample.skipped > 0) {
    deps.err(
      `Left ${sample.skipped} bot-authored pull request(s) out of the sample, inferring from the ` +
        `${sample.read} written by people. A starter built from dependabot's bodies is one the ` +
        "humans in the same sample fail.",
    );
  }

  const observedSections = sections(sample);
  const draft: InitDraft = {
    titlePattern: {
      value: CONVENTIONAL_TITLE,
      provenance: "proposed",
      why: "the conventional-commits shape; nothing on a forge states a title convention",
    },
    branchPattern: branchPattern(rulesets, deps.err),
    forbidden: forbidden(sample),
    blockingLabels: blockingLabels(workflow.value),
    sections: observedSections,
    jira: jira(sample),
    jiraSection: jiraSection(observedSections),
  };

  // Only a forge-proved branch pattern counts as resolved. Anything else in that
  // field is `^.+$`, which enforces nothing — and a permissive pattern nobody is
  // told about is how a bootstrap turns into a rule that silently never fires.
  const unresolved: string[] = [];
  if (draft.branchPattern.provenance !== "read") unresolved.push("branch.pattern");
  if (draft.jira.value.baseUrl === undefined) unresolved.push("jira.baseUrl");
  // A jira.section naming no section that exists is a rule that never runs. That
  // is a silence, which is the failure mode this command is built against.
  if (!draft.sections.value.some((section) => section.name === draft.jiraSection.value)) {
    unresolved.push("jira.section");
  }

  // Proposed before the config is rendered, so the config can name it. Nothing is written
  // yet: `proposeReadiness` returns text, and both writes happen below with the config
  // first — a failure writing the checklist must leave a usable config behind.
  const readinessTarget = options.readinessFile ?? join(dirname(options.config), "readiness.yml");
  const proposed =
    deps.proposeReadiness === undefined
      ? undefined
      : attempt("a readiness checklist", () => deps.proposeReadiness?.(), deps.err).value;
  const willWriteReadiness =
    proposed !== undefined && (!deps.exists(readinessTarget) || options.force);
  if (willWriteReadiness) {
    // Sibling-relative: `readiness:` resolves against the realpath of the config, which is
    // what lets a repository keep both files together and link to them from elsewhere.
    draft.readinessFile = `./${basename(readinessTarget)}`;
  }

  const text = renderConfig(draft);

  // What this command infers must load. The unit tests put every path through
  // `configSchema`; until now the command itself never did, so a ruleset with an
  // empty pattern, or a Jira host scraped out of prose that is not a URL, exited 0
  // over a file `check` cannot read. Refusing and naming the field is worse than a
  // correct value and better than a broken file.
  const failure = schemaFailure(text);
  if (failure !== undefined) {
    deps.err(
      `Refusing to write ${options.config}: what shipkit inferred does not load as a config — ${failure}. ` +
        "Nothing was written; a config that cannot be read is worse than no config.",
    );
    return { code: 2, wrote: false, unresolved };
  }

  try {
    deps.write(options.config, text);
  } catch (error) {
    deps.err(`Cannot write ${options.config}: ${reason(error)}`);
    return { code: 2, wrote: false, unresolved };
  }

  deps.out(`Wrote ${options.config}`);
  for (const [field, inferred] of summaryOrder(draft)) {
    deps.out(`  ${field}: ${inferred.provenance} — ${inferred.why}`);
  }

  // The second half of being set up. Written after the config and never before: a failure
  // here must leave a usable config behind rather than nothing at all.
  let readinessPath: string | undefined;
  if (deps.proposeReadiness !== undefined) {
    if (proposed === undefined) {
      deps.err(
        "No readiness checklist was proposed: nothing in this repository matched a rule " +
          "shipkit knows how to look for. That is a statement about the catalogue, not " +
          "about your code — write one by hand from what your own reviews keep asking.",
      );
    } else if (!willWriteReadiness) {
      deps.err(`${readinessTarget} already exists, so it was left alone. Pass --force to replace it.`);
    } else {
      try {
        deps.write(readinessTarget, proposed);
        readinessPath = readinessTarget;
        deps.out(`Wrote ${readinessTarget}`);
        deps.out(
          "  every rule is `advise`, which never gates a push, and every line says what it " +
            "was derived from. Read it before raising any of them.",
        );
      } catch (error) {
        deps.err(`Cannot write ${readinessTarget}: ${reason(error)}`);
      }
    }
  }

  return { code: 0, wrote: true, unresolved, ...(readinessPath === undefined ? {} : { readinessPath }) };
}

function summaryOrder(draft: InitDraft): [string, Inferred<unknown>][] {
  return [
    ["pr.titlePattern", draft.titlePattern],
    ["pr.forbidden", draft.forbidden],
    ["pr.blockingLabels", draft.blockingLabels],
    ["pr.sections", draft.sections],
    ["branch.pattern", draft.branchPattern],
    ["jira", draft.jira],
    ["jira.section", draft.jiraSection],
  ];
}

/**
 * Names the fields a rendered config fails the schema on, in the schema's own
 * words, or undefined when it loads.
 *
 * Exported to be tested directly. Both inputs known to reach it — a ruleset with
 * an empty pattern, a Jira host scraped out of prose that is not a URL — are now
 * refused where they are read, so no argument to `runInit` can drive this branch;
 * that is the intent, and it is also why the gate needs a test of its own. It is
 * here for the next such input, not for those two.
 */
export function schemaFailure(text: string): string | undefined {
  let document: unknown;
  try {
    document = parse(text);
  } catch (error) {
    return `the rendered YAML does not parse (${reason(error)})`;
  }

  const result = configSchema.safeParse(document);
  if (result.success) return undefined;

  return result.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}
