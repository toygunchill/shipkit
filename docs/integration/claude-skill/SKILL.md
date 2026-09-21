---
name: open-pr
description: Use when opening a pull request, or when a development task is finished and the work needs to land - writes the commit message and the PR body to this repository's conventions and opens the PR against the agreed target branch.
---

# Opening a pull request

This repository's pull-request conventions are machine-checked. Do not run
`gh pr create` directly and do not compose the body by hand; shipkit will refuse
output that does not comply, and refusing is the point.

## First, ask

Ask which branch to target. Release timing decides it and the repository does not
record it, so it is not yours to infer. Guessing wrong costs a round of dismissed
approvals.

## Then

Run `npx shipkit brief --base <target>`. It returns the change, the target, the
sections to fill with a hint for each, and the rules the output must satisfy.

Write `response.json` in the repository root:

```json
{
  "title": "<matches the brief's titlePattern>",
  "commitMessage": "<conventional-commit subject, optional body after a blank line>",
  "sections": { "<each section name from the brief>": "<your prose>" }
}
```

Every key under `sections` must be a section name the brief lists, spelled exactly.
Use `###` for sub-headings — a `##` line reads as a new section, so a `##` inside
one silently splits it.

Write each section to the `hint` the brief gives for it. The hints come from the
repository's own configuration and are where it says what a good answer looks
like — how long a Summary should be, whose language *What to Test* is written in.
shipkit has no opinion of its own about either.

Then run `npx shipkit submit --input response.json --base <target>`.

## Reading the outcome

**Exit 1** — the answer broke a rule, and the rule is named. Nothing was committed.
Fix the response and run it again.

**Exit 2 after warnings** — something expensive to undo is about to happen:
approvals a push will dismiss, commits belonging to another ticket, a base that
disagrees with the open pull request, a blocking label, or untracked files staging
would sweep into the commit. Read what shipkit printed before deciding what to do:

- If it names the warnings as unacknowledged, report them and ask before
  re-running with `--yes`. Do not pass `--yes` on your own judgement.
- If instead it says the approval surface is not running, or that this
  repository requires a person's approval, `--yes` cannot fix that — some
  repositories require a person's decision through a separate approval
  application before a push with warnings can proceed. Re-running with
  `--yes` reproduces the identical refusal. Tell the person what shipkit said
  and wait.

**Exit 0** — the pull request URL is on stdout. Report it.
