import type { GitRunner } from "./baserules.js";

/**
 * The reviewer a repository defines for itself.
 *
 * A team that has written down how its changes should be reviewed has already done the
 * expensive part, and it is usually more specific than anything a general review would
 * produce: it knows which rules exist, what counts as a finding here, and what to leave
 * alone. shipkit's job is to put that in front of the agent and say to use it — not to let
 * the agent fall back on whatever review habit it arrived with.
 *
 * Read from the base ref, like the rules, so a reviewer's own branch is irrelevant.
 *
 * The list of places to look is per-agent because these files are: a Claude Code subagent,
 * a slash command, a Copilot prompt. shipkit does not care which of them a repository has
 * — it reads whichever exists and hands the text over, so the same brief works for an agent
 * that has never heard of any of them.
 */

export type ReviewerSurface = {
  path: string;
  /** Which tool the file is written for, for a person reading the brief. */
  flavour: string;
  instructions: string;
};

/** Where a repository's own reviewer is kept, by the tool it was written for. */
const SURFACES: { match: RegExp; flavour: string }[] = [
  { match: /^\.claude\/agents\/[^/]*review[^/]*\.md$/i, flavour: "Claude Code subagent" },
  { match: /^\.claude\/commands\/review[^/]*\.md$/i, flavour: "Claude Code command" },
  { match: /^\.github\/prompts\/[^/]*review[^/]*\.prompt\.md$/i, flavour: "Copilot prompt" },
  { match: /^\.codex\/prompts\/review[^/]*\.md$/i, flavour: "Codex prompt" },
];

/**
 * Every reviewer definition the repository carries at `ref`.
 *
 * A subagent is preferred over a command where both exist: a subagent is the one a tool
 * will actually dispatch as a separate reviewer, and a command is a person's entry point to
 * roughly the same text. Both are returned, in that order, and the caller uses the first.
 */
export function reviewersAt(ref: string, git: GitRunner): ReviewerSurface[] {
  const listed = git(["ls-tree", "-r", "--name-only", ref]);
  if (listed === undefined) return [];

  const paths = listed.split("\n").filter((line) => line.length > 0);
  const found: ReviewerSurface[] = [];

  for (const { match, flavour } of SURFACES) {
    for (const path of paths.filter((candidate) => match.test(candidate)).sort()) {
      const instructions = git(["show", `${ref}:${path}`]);
      // A file listed but unreadable is not a reviewer. Reporting none is better than
      // telling the agent to follow instructions nobody could produce.
      if (instructions !== undefined && instructions.trim().length > 0) {
        found.push({ path, flavour, instructions });
      }
    }
  }

  return found;
}

/**
 * What to say when a repository defines no reviewer.
 *
 * Asks for one, and offers to write it. A tool that reports a gap and leaves the person to
 * work out the remedy has done the easy half — and the remedy here is mechanical, because
 * the rules the reviewer would enforce are already in the repository.
 */
export function askForReviewer(repository: string): string {
  return (
    `${repository} defines no reviewer of its own, so this review would be whatever the ` +
    "agent happens to do by habit — which is the thing worth avoiding, since it varies by " +
    "agent, by day, and by how the question was phrased.\n\n" +
    "Add one: a file that says how changes here are reviewed, kept in the repository and " +
    "reviewed like anything else. shipkit looks for a Claude Code subagent under " +
    "`.claude/agents/`, a command under `.claude/commands/`, a Copilot prompt under " +
    "`.github/prompts/`, or a Codex prompt under `.codex/prompts/`.\n\n" +
    "`shipkit reviewer --write` drafts them from the rules the repository already carries, " +
    "for you to read and change before committing. Nothing is written without that flag."
  );
}
