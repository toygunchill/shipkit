/**
 * The `tech-task` fields that cannot live in `.shipkit.yml`.
 *
 * `.shipkit.yml` is committed and shared by six teams; `Digital Team`, the portfolio
 * child and the sprint differ per person, so they are derived from the developer's own
 * recent issues instead. Every function here can therefore be confidently wrong, and a
 * wrong value is worse than an absent one: a missing field is named and a person supplies
 * it, while a wrong one is carried silently into a ticket nobody re-reads after creation.
 * So each returns `Derived<T>` — a value, or a refusal that names the flag to pass and
 * lists what was actually seen.
 *
 * Pure over already-fetched data. The fetching lives elsewhere.
 */

/** One recent issue, reduced to the fields a derivation votes on. Either may be absent. */
export type IssueFieldSample = { team?: string; portfolioChild?: string };

/**
 * A derived value, or a refusal.
 *
 * `unresolved` is a sentence a person can act on — it names the flag that unblocks them.
 * `candidates` is what was actually seen, commonest first, so they can see how close it
 * was: "22, 18, 11, 7" reads very differently from "36, 20", and both are refusals.
 */
export type Derived<T> = { value: T } | { unresolved: string; candidates: string[] };

/**
 * A value must hold strictly more than this share of the votes.
 *
 * Half, not a plurality. Cross-team work happens — one issue inside a Squad A sprint
 * carried Squad B — so the commonest answer is not by itself evidence of the right one.
 * Measured against the live Jira — those are *team sprint* distributions rather than the
 * per-developer sample this actually votes on, and the spec says so, but they are the
 * widest set of real shapes measured: this threshold accepts Squad A's portfolio child at
 * 55/60, Squad C's at 50/60 and Squad B's at 36 of 59, and refuses Squad D' 22/18/11/7.
 *
 * Someone will want to lower it the first time a derivation refuses on their machine.
 * What that trades away: at a plurality, Squad D' four-way split resolves to a value
 * held by 38% of the sample, which would be wrong for the other 62% — quietly, in a field
 * nobody re-reads. Below half there is no reading of the data that makes the winner more
 * likely right than wrong. Pass `--team` or `--portfolio` instead; that is what they are for.
 *
 * Raising it is the live question, not lowering it, and the spec's own correction is what
 * settles it. Two thirds was considered and rejected there: the only *personal* sample ever
 * measured — one real developer's last 60 issues — sits at 68% "Only Digital", so a
 * two-thirds rule would decide that developer's case by 1.6 percentage points, and one
 * issue landing elsewhere would flip it into a refusal. A rule that arbitrary is worse than
 * a looser one. (An earlier draft of the spec argued the opposite from Squad B's 36/20,
 * calling it a team with "no majority at all". It is 36 of 59, which is 61% and a majority
 * — and it is a team sprint distribution besides, so it was never evidence about this
 * function's input. Only Squad D lacks a majority.) So half is what this is, and
 * `tests/jira/derive.test.ts` pins the consequence.
 */
export const MAJORITY_THRESHOLD = 0.5;

/**
 * The denominator: issues that carry a value for the field, not every issue sampled.
 *
 * A blank field is an absence of evidence, not a vote against whatever the people who did
 * fill it in agreed on. Counting blanks would make the outcome depend on how many unfilled
 * issues the sample happened to sweep up — a refusal the developer cannot fix by fixing
 * anything, since the blanks are on issues that are not theirs to correct. Neither reading
 * changes any of the four measured teams (Squad D refuses at 22/58 and at 22/60; Fly
 * High passes at 55/60 either way), so the choice is pinned by a test on synthetic data.
 */
function votes(sample: IssueFieldSample[], field: keyof IssueFieldSample): string[] {
  return sample.map((issue) => issue[field]?.trim()).filter((value): value is string => !!value);
}

/** Distinct values with their counts, commonest first; ties keep first-seen order. */
function tally(values: string[]): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * The value held by strictly more than `MAJORITY_THRESHOLD` of `values`, if there is one.
 *
 * Returns the ranked candidates instead of a value when there is not — including for an
 * empty input, where the ranking is empty and there is nothing to name.
 */
function majority(values: string[]): { value: string } | { candidates: string[] } {
  const ranked = tally(values);
  const leader = ranked[0];
  if (leader !== undefined && leader.count > values.length * MAJORITY_THRESHOLD) {
    return { value: leader.value };
  }
  return { candidates: ranked.map((entry) => entry.value) };
}

/**
 * The developer's `Digital Team`, from the teams on their recently assigned issues.
 *
 * Usually unanimous on one person's own issues, which is why this works at all. It refuses
 * rather than picking the most common of two near-equal answers, and refuses an empty
 * sample rather than inventing a team.
 */
export function deriveTeam(sample: IssueFieldSample[]): Derived<string> {
  const seen = votes(sample, "team");
  const decided = majority(seen);
  if ("value" in decided) return decided;
  return {
    unresolved:
      seen.length === 0
        ? "No Digital Team on any of the sampled issues. Pass --team to say which team this is for."
        : "No single Digital Team holds a majority of the sampled issues. Pass --team to say which team this is for.",
    candidates: decided.candidates,
  };
}

/**
 * The child of the cascading portfolio field, from the developer's recent issues.
 *
 * This is the field least likely to be answerable. The child tracks the nature of the work
 * rather than the team, and one of the four measured teams has no majority at all — Sky
 * Stones splits 22/18/11/7 across four values. (An earlier draft of the spec said two of
 * four; the second, Squad B, is a majority at 36 of 59. The spec carries the correction.)
 * Refusing here is an ordinary outcome rather than an edge case, and the refusal names
 * `--portfolio` because that is the only honest way to fill this in.
 */
export function derivePortfolioChild(sample: IssueFieldSample[]): Derived<string> {
  const seen = votes(sample, "portfolioChild");
  const decided = majority(seen);
  if ("value" in decided) return decided;
  return {
    unresolved:
      seen.length === 0
        ? "No portfolio child on any of the sampled issues. Pass --portfolio to say which one this work belongs under."
        : "No single portfolio child holds a majority of the sampled issues — it tracks the nature of the work, not the team. Pass --portfolio to say which one this work belongs under.",
    candidates: decided.candidates,
  };
}

/**
 * The active sprint belonging to `team`.
 *
 * Several sprints are active on one board at once — four were, when this was measured —
 * and each is named for its team, so the team name is the discriminator. It is matched as
 * a whole leading word, not a bare prefix: `Squad A` and `Squad E` are both real
 * teams, and a bare prefix test would make one team's sprint a candidate for the other.
 *
 * Six teams exist and only four had a sprint, so no match is ordinary rather than
 * exceptional. More than one match is refused too — taking the first would silently prefer
 * whatever order the board happened to return.
 */
export function pickSprint(sprints: { id: number; name: string }[], team: string): Derived<number> {
  const matches = sprints.filter((sprint) => sprint.name === team || sprint.name.startsWith(`${team} `));
  if (matches.length === 1) return { value: matches[0].id };
  if (matches.length === 0) {
    return {
      unresolved: `No active sprint on the board belongs to ${team}. Pass --sprint with the sprint id, or --team if the team itself is wrong.`,
      // What was actually seen: the sprints that are active, so a person can pick one.
      candidates: sprints.map((sprint) => sprint.name),
    };
  }
  return {
    unresolved: `More than one active sprint belongs to ${team}. Pass --sprint with the sprint id.`,
    candidates: matches.map((sprint) => sprint.name),
  };
}
