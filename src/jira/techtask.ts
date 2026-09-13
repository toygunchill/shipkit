/**
 * The technical item itself: the payload `shipkit tech-task` would send, and the reading
 * of a developer's recent issues that fills in the parts `.shipkit.yml` cannot hold.
 *
 * Two halves, deliberately separated. `buildCreatePayload` is pure and takes every value
 * already decided, so the shape of the request can be asserted without a Jira anywhere
 * near the test. `fetchRecentWork` and the two `…From` helpers are the impure half, and
 * they only ever read.
 *
 * Every field id and value below was measured against the live Jira and is recorded in
 * `docs/superpowers/specs/2026-09-13-shipkit-tech-task-design.md`. None of it is guessed,
 * and none of it should be "tidied" — a rounder-looking value here is a silently wrong
 * ticket, not a cleaner constant.
 */

import type { ShipkitConfig } from "../config/schema.js";
import type { Fetcher } from "./client.js";
import { derivePortfolioChild, deriveTeam, type Derived, type IssueFieldSample } from "./derive.js";
import { JiraError } from "./types.js";

/** The `techTask` block, once the caller has established there is one. */
export type TechTaskConfig = NonNullable<ShipkitConfig["techTask"]>;

export type TechTaskInput = {
  config: TechTaskConfig;
  subject: string;
  team: string;
  sprintId?: number;
  portfolioChild: string;
};

/**
 * `Portfolio / Servis Bilgisi`. A cascading select: its payload is
 * `{value, child: {value}}`, and a bare `{value}` is rejected. The parent has exactly one
 * allowed value and lives in config; the child varies with the work and is derived.
 */
export const PORTFOLIO_FIELD = "customfield_10101";
/** `Digital Team`, a plain option: `{value}`. Derived — it is the team, and it varies per person. */
export const TEAM_FIELD = "customfield_10102";
/** The epic link. A bare key string, not an object. */
export const EPIC_FIELD = "customfield_10006";
/** The sprint. A bare numeric id, not an object and not a name. */
export const SPRINT_FIELD = "customfield_10005";

/**
 * The request body for `POST /rest/api/2/issue`.
 *
 * Pure, and total over its input: everything it needs has already been decided or refused
 * by the caller. Description and labels are absent rather than empty, because every
 * existing one of these tickets has neither — sending `description: ""` would be shipkit
 * inventing a convention instead of following the one it measured.
 */
export function buildCreatePayload(input: TechTaskInput): Record<string, unknown> {
  const { config, subject, team, sprintId, portfolioChild } = input;

  // The four ids this module owns. Stripped out of the config spread rather than merely
  // written after it: spreading first only wins for a field this function sets
  // *unconditionally*, and three of the four are conditional. Before this, a repository
  // whose `fields:` block named `customfield_10005` supplied a sprint on the very runs the
  // command had decided there was none — `--sprint none` printed "given with --sprint" over
  // a payload carrying the config's sprint. A silently wrong value in a created ticket is
  // the class this whole design exists to prevent, so the ownership is enforced up front
  // and each id below is set, or deliberately left out, by this function alone.
  //
  // The portfolio parent is the one owned id whose config value is still read — not copied
  // through, but taken apart and rebuilt with the derived child under it, just below.
  const extra: Record<string, unknown> = { ...(config.fields ?? {}) };
  for (const owned of [PORTFOLIO_FIELD, TEAM_FIELD, EPIC_FIELD, SPRINT_FIELD]) delete extra[owned];

  const fields: Record<string, unknown> = {
    ...extra,
    project: { key: config.project },
    issuetype: { name: config.issueType },
    summary: config.summaryPattern.replaceAll("{subject}", subject),
    [TEAM_FIELD]: { value: team },
  };

  // The child is nested under whatever parent the repository configured. With no parent
  // configured there is nothing to nest it under, and a child alone is not a payload Jira
  // accepts — so the field is omitted rather than built into an invalid shape. `tech-task`
  // refuses before reaching here in that case; this is the safe reading of it, not the
  // route a person will take.
  //
  // `!Array.isArray` because `typeof [] === "object"`: a YAML list under
  // `customfield_10101:` is not a cascading-select parent, and spreading one would build
  // `{0: …, child: {…}}` — a child with no parent value, in a shape Jira rejects.
  const parent = config.fields?.[PORTFOLIO_FIELD];
  if (typeof parent === "object" && parent !== null && !Array.isArray(parent)) {
    fields[PORTFOLIO_FIELD] = { ...parent, child: { value: portfolioChild } };
  }

  // Measured: 1 of the 2 existing conversion tickets has no epic link. A human doing this
  // by hand forgets, which is most of why this command exists — but the epic is optional
  // in config, and an absent one is omitted rather than sent as an empty key.
  if (config.epic !== undefined) fields[EPIC_FIELD] = config.epic;

  // Omitted, never null. Six teams exist and four had an active sprint when this was
  // measured, so "no sprint" is an ordinary outcome, and `customfield_10005: null` is a
  // different request from one that leaves the sprint alone.
  if (sprintId !== undefined) fields[SPRINT_FIELD] = sprintId;

  return { fields };
}

/**
 * How many of the developer's recent issues to read.
 *
 * 60, because that is the sample the threshold in `derive.ts` was chosen against: the spec
 * measured one real developer's last 60 issues at 68% "Only Digital" / 28% "Payment", and
 * each team's portfolio distribution over 60. Deriving from a different sample size than
 * the one the rule was validated on would mean the rule has not been tested on its input.
 */
export const SAMPLE_SIZE = 60;

/**
 * The fewest issues that may carry a value for a field before it is derived at all.
 *
 * `derive.ts` deliberately has no floor: a majority of one is a majority, so a developer
 * whose sample carries a single value gets it at 1 of 1. That is the one case where the
 * majority rule cannot protect anybody, and the fetch size is decided here, so the floor is
 * here too.
 *
 * What this is based on, precisely: the spec measured **one** cross-team stray — an issue
 * inside a Squad A sprint carrying Squad B — which is the whole reason a majority is
 * required rather than a plurality. A single stray can only win a majority when it is the
 * only vote, so the floor that measurement actually supports is 3.
 *
 * 5 is one conservative step past that: it is the smallest sample in which *two* strays
 * still lose (3 of 5 beats 2, while 2 of 4 is not a majority and refuses anyway). Nothing
 * measures how many strays are typical, so that step is an extrapolation and is admitted as
 * one rather than dressed up — it is deliberately on the refusing side, because a refusal
 * names a flag and costs a person one argument, while a wrong value is carried into a ticket
 * nobody re-reads. Against a 60-issue fetch it excludes only a developer with almost no
 * history in this project, which is exactly the developer whose history proves least.
 */
export const MINIMUM_VOTES = 5;

/** The developer's recent work, reduced to what the three derivations vote on. */
export type RecentWork = {
  sample: IssueFieldSample[];
  /** Every sprint seen on those issues that is still active. Named for the team, by convention. */
  activeSprints: { id: number; name: string }[];
};

// A GET fetcher of the same shape `src/jira/client.ts` uses. Its own default is private to
// that module and exporting it would mean editing a file this change has no other business
// in, so this is a deliberate duplicate of eight lines rather than a second way of doing it.
const defaultFetcher: Fetcher = async (url, token) => {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!response.ok) {
    throw new JiraError(`Jira responded ${response.status} for ${url}`);
  }
  return response.json();
};

function redactToken(message: string, token: string): string {
  return message.split(token).join("[redacted]");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionValue(field: unknown): string | undefined {
  const option = asRecord(field);
  const value = option?.value;
  return typeof value === "string" ? value : undefined;
}

function cascadingChild(field: unknown): string | undefined {
  return optionValue(asRecord(field)?.child);
}

/**
 * One entry of the sprint field, in either shape Jira serves it in.
 *
 * **Unmeasured, unlike everything else in this module.** The spec measured how
 * `customfield_10005` is *written* — a bare numeric id — and never how it reads back. Jira
 * serves it either as an object or as a `toString()` of the greenhopper Sprint bean
 * (`…Sprint@1b2c[id=1234,rapidViewId=57,state=ACTIVE,name=Squad B Sprint 45,…]`), and
 * which one depends on the deployment. Both are read here.
 *
 * The failure direction is what makes that acceptable: an entry this cannot parse yields no
 * candidate, `pickSprint` then sees no sprint for the team and refuses naming `--sprint`.
 * Nothing here can produce a *wrong* sprint id, only a missing one.
 */
function parseSprint(entry: unknown): { id: number; name: string; active: boolean } | undefined {
  const object = asRecord(entry);
  if (object !== undefined) {
    const { id, name, state } = object;
    if (typeof id !== "number" || typeof name !== "string") return undefined;
    return { id, name, active: typeof state === "string" && state.toLowerCase() === "active" };
  }
  if (typeof entry !== "string") return undefined;
  const id = /\bid=(\d+)/.exec(entry);
  const name = /\bname=([^,\]]*)/.exec(entry);
  const state = /\bstate=([^,\]]*)/.exec(entry);
  if (id === null || name === null) return undefined;
  return {
    id: Number(id[1]),
    name: name[1],
    active: state !== null && state[1].toLowerCase() === "active",
  };
}

/**
 * The developer's own recent issues, and the sprints still active among them.
 *
 * `assignee = currentUser()` is what makes this zero-configuration: `.shipkit.yml` is
 * committed and shared by six teams, so the team, the portfolio child and the sprint cannot
 * live in it, and the token already identifies the person running the command.
 *
 * The active sprints come from these same issues rather than from a board, because a board
 * query needs a board id and there is nowhere in the config for one. The cost is real and
 * worth naming: a developer with no issue in their team's current sprint sees no candidate
 * for it, and gets a refusal naming `--sprint` rather than the sprint. A refusal is the
 * failure this whole feature is built to prefer.
 */
export async function fetchRecentWork(
  baseUrl: string,
  token: string,
  fetcher: Fetcher = defaultFetcher,
): Promise<RecentWork> {
  const query = new URLSearchParams({
    jql: "assignee = currentUser() ORDER BY updated DESC",
    maxResults: String(SAMPLE_SIZE),
    fields: [TEAM_FIELD, PORTFOLIO_FIELD, SPRINT_FIELD].join(","),
  });
  const url = `${baseUrl.replace(/\/$/, "")}/rest/api/2/search?${query.toString()}`;

  let raw: unknown;
  try {
    raw = await fetcher(url, token);
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = redactToken(rawMessage, token);
    if (error instanceof JiraError) throw new JiraError(message);
    throw new JiraError(`Cannot reach Jira to read your recent issues: ${message}`);
  }

  const issues = asRecord(raw)?.issues;
  if (!Array.isArray(issues)) {
    throw new JiraError("Jira returned no issue list for your recent issues");
  }

  const sample: IssueFieldSample[] = [];
  const activeSprints = new Map<number, string>();
  for (const issue of issues) {
    const fields = asRecord(asRecord(issue)?.fields);
    if (fields === undefined) continue;

    const team = optionValue(fields[TEAM_FIELD]);
    const portfolioChild = cascadingChild(fields[PORTFOLIO_FIELD]);
    sample.push({
      ...(team !== undefined ? { team } : {}),
      ...(portfolioChild !== undefined ? { portfolioChild } : {}),
    });

    const sprints = fields[SPRINT_FIELD];
    if (!Array.isArray(sprints)) continue;
    for (const entry of sprints) {
      const sprint = parseSprint(entry);
      if (sprint !== undefined && sprint.active) activeSprints.set(sprint.id, sprint.name);
    }
  }

  return {
    sample,
    activeSprints: [...activeSprints].map(([id, name]) => ({ id, name })),
  };
}

/** Distinct values seen for a field, so a refusal can say what it actually looked at. */
function seen(sample: IssueFieldSample[], field: keyof IssueFieldSample): string[] {
  const values = sample
    .map((issue) => issue[field]?.trim())
    .filter((value): value is string => !!value);
  return [...new Set(values)];
}

/**
 * `derive` applied to the sample, unless too little of the sample carries the field.
 *
 * The floor is checked on the entries that carry a value, matching the denominator
 * `derive.ts` votes on: a 60-issue fetch in which two issues name a team is a sample of two
 * for that question, however many rows it has.
 */
function withFloor(
  sample: IssueFieldSample[],
  field: keyof IssueFieldSample,
  what: string,
  flag: string,
  derive: (sample: IssueFieldSample[]) => Derived<string>,
): Derived<string> {
  const values = seen(sample, field);
  const carrying = sample.filter((issue) => !!issue[field]?.trim()).length;
  if (carrying < MINIMUM_VOTES) {
    return {
      unresolved:
        `Only ${carrying} of your ${sample.length} most recent issues carry a ${what} — too few to derive one from ` +
        `(${MINIMUM_VOTES} needed). Pass ${flag}.`,
      candidates: values,
    };
  }
  return derive(sample);
}

/** The developer's `Digital Team`, with the small-sample floor applied. */
export function teamFrom(sample: IssueFieldSample[]): Derived<string> {
  return withFloor(sample, "team", "Digital Team", "--team", deriveTeam);
}

/** The portfolio child, with the small-sample floor applied. */
export function portfolioChildFrom(sample: IssueFieldSample[]): Derived<string> {
  return withFloor(sample, "portfolioChild", "portfolio child", "--portfolio", derivePortfolioChild);
}
