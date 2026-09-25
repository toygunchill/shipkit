import type { ReadinessRule } from "../readiness/types.js";

/**
 * Drafting the reviewer a repository does not have yet.
 *
 * Not a template with the rules pasted in: the rules *are* the reviewer. A repository that
 * has written down what it expects has already decided what a review here should look for,
 * and the only thing missing is a file saying so in the shape each agent reads.
 *
 * Drafted, never installed silently. What comes out is a starting point to be read,
 * argued with and committed like anything else — a reviewer nobody read is a reviewer
 * nobody trusts, and it would be answering on the team's behalf.
 */

export type ReviewerFile = {
  path: string;
  /** What the file is for, in a sentence, when reporting what was written. */
  purpose: string;
  contents: string;
};

/** A repository name reduced to something usable as an agent's name. */
export function agentName(repository: string): string {
  const last = repository.split("/").filter((part) => part.length > 0).pop() ?? "repo";
  const slug = last.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${slug.length > 0 ? slug : "repo"}-reviewer`;
}

function ruleLines(rules: readonly ReadinessRule[]): string {
  if (rules.length === 0) {
    return "_This repository's ruleset is empty. Until it has rules, there is nothing here to review against._";
  }
  return rules
    .map((rule) => {
      const why = rule.why === undefined ? "" : `\n  ${rule.why}`;
      return `- **${rule.id}** — ${rule.ask}${why}`;
    })
    .join("\n");
}

/**
 * The body every flavour shares.
 *
 * One text, because a repository whose Claude reviewer and Copilot reviewer disagree has
 * two rulesets pretending to be one, and nobody finds out until two people get different
 * answers about the same line.
 */
function body(rulesDirectory: string, rules: readonly ReadinessRule[]): string {
  return `You review changes in this repository against the rules it carries in \`${rulesDirectory}\`.

You are read-only. Never edit, create or delete a file, and never run a command that changes
the working tree. Use \`git diff\`, \`git log\`, \`git show\` and \`git grep\` to read.

## What to review against

${ruleLines(rules)}

## How to report

Every finding cites the id of the rule it comes from. A remark you cannot attribute to a
rule is not written — not because it is wrong, but because a review that ranges beyond what
the repository decided is an opinion, and an opinion nobody asked for teaches its reader to
skim the ones they did ask for.

Anchor each finding to the file and line it is about. Say what is wrong and what to do
instead; do not restate the rule, which the reader can look up by its id.

The rules bind the change, not the file. What a change adds follows them; what was already
there stays unless the change is about it.

Finding nothing is a valid review. Say so rather than filling the space.`;
}

/**
 * One draft per agent this repository might use.
 *
 * All of them, rather than asking which agent the team has: the files are small, they cost
 * nothing to carry, and a team with two agents in it should not have to notice that the
 * second one was never set up.
 */
export function renderReviewer(
  repository: string,
  rulesDirectory: string,
  rules: readonly ReadinessRule[],
): ReviewerFile[] {
  const name = agentName(repository);
  const shared = body(rulesDirectory, rules);
  const description =
    `Review a change in ${repository} against the rules in ${rulesDirectory}. ` +
    "Use before opening a pull request, or when asked to review a diff, a branch or a set " +
    "of changed files. Reports findings with rule ids; does not modify files.";

  return [
    {
      path: `.claude/agents/${name}.md`,
      purpose: "Claude Code dispatches this as a separate reviewer",
      contents: `---\nname: ${name}\ndescription: ${description}\ntools: Read, Grep, Glob, Bash\n---\n\n${shared}\n`,
    },
    {
      path: ".claude/commands/review.md",
      purpose: "`/review` in Claude Code, for a person asking directly",
      contents:
        `---\ndescription: Review the current change against the rules in ${rulesDirectory}\n` +
        `argument-hint: "[branch, pull request number or path]"\n---\n\n` +
        "Work out what to review, in this order: the target named in $ARGUMENTS; otherwise " +
        "the uncommitted changes in the working tree; otherwise this branch against its base.\n\n" +
        `${shared}\n`,
    },
    {
      path: ".github/prompts/review.prompt.md",
      purpose: "Copilot reads this one",
      contents:
        `---\ndescription: Review the current change against the rules in ${rulesDirectory}\n---\n\n` +
        `${shared}\n`,
    },
  ];
}
