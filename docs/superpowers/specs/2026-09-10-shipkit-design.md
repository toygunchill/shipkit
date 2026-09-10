# shipkit — Design

**Date:** 2026-09-10
**Status:** Approved design, pending implementation plan

## Problem

A team's pull-request conventions are the last thing an AI coding agent gets right and
the first thing a reviewer notices. On the repository that motivated this tool
(`acme/example-app`), the conventions that actually gate a merge exist in three places,
none of which an agent can read:

| Convention | Where it lives today |
|---|---|
| PR body structure (Summary / Screenshots / What to Test / Issues Addressed) | Nowhere. Copied by hand from an older PR. |
| PR title format `[ABC-00000] type(scope): subject` | Tribal knowledge. |
| Branch name regex | A server-side GitHub ruleset. Discovered only when a push is rejected. |
| Target branch choice (develop vs release/x.y.z) | Tribal knowledge. |
| Three required approvals, blocking labels | Branch protection + a CI job. |
| Which Jira key to cite — the Bug or its Development subtask | Tribal knowledge. |

The repository's only agent-facing rules file, `.github/copilot-instructions.md`,
covers Swift style exclusively and says nothing about commits, branches, or pull
requests. So every agent — Claude Code, Copilot, Codex, Antigravity — improvises the
final mile, and a human fixes it afterwards.

shipkit closes that gap: it makes the conventions machine-readable, tells the agent
what to write, refuses output that does not comply, and warns before irreversible
steps.

## Goals

- Produce a compliant commit message, PR title, and PR body at the end of a task.
- Open the PR against the correct target branch.
- Suggest a branch name that satisfies the repository's naming rule.
- Work identically regardless of which agent drives it.
- Warn about mistakes that are expensive to undo.

## Non-goals

- Reviewing code quality. That is a separate concern with separate tools.
- Replacing CI. shipkit runs before the PR exists; CI runs after.
- Supporting forges other than GitHub, or trackers other than Jira, in v1.
  Abstraction without a second real consumer is speculation.
- Writing the prose itself. See "Who writes the prose".

## Decisions

These were settled during brainstorming and are inputs to the design, not open
questions.

| Decision | Choice | Reason |
|---|---|---|
| Form factor | CLI | Every agent can run a shell command. Agent-agnosticism comes free. |
| Who writes the prose | The agent | It already holds the full context of the change. A second LLM call would cost money and lose that context. |
| Rule source | `.shipkit.yml` in the consuming repo. `shipkit init` reads the machine-checkable rules from authoritative APIs and ships a starter body template for the team to edit. | Rulesets and branch protection are facts. The body template is not — see "Why the template cannot be inferred". |
| Autonomy | End-to-end, with a pre-flight gate | Matches how the tool is used — at the end of a task — while protecting the irreversible steps. |
| Home | Standalone repository | The product is not part of any consuming project. Consumers get only a config file. |
| Jira | Connected via API | Required to resolve the subtask-vs-parent question correctly. |
| Agent contract | Brief → fill → submit | The CLI states the rules; the agent does not have to remember them. |
| Language | Node + TypeScript, distributed on npm | `npx shipkit` needs no install step. |

## Who writes the prose

shipkit never generates the summary or the test plan. It:

1. Gathers everything knowable from the repository, the forge, and the tracker.
2. Hands that to the agent as a structured brief, together with the template to fill
   and the rules to obey.
3. Accepts the agent's answer only if it validates.

The agent supplies judgement; shipkit supplies knowledge and enforcement. This keeps
shipkit deterministic and testable, and keeps the LLM cost at zero.

## Command surface

```
shipkit init                     Write .shipkit.yml: rules read from the forge,
                                 body template seeded for the team to edit
shipkit branch "<description>"   Suggest a compliant branch name
shipkit brief [--base <branch>]  Emit the JSON brief for the agent;
                                 asks for the target branch when not given
shipkit submit --input <file>    Validate → pre-flight → commit → push → open PR
shipkit check                    Validate only; no side effects. Usable in CI.
```

`brief` is the only command that may prompt. When stdin is not a terminal — an agent
running unattended, or CI — it fails with the list of valid targets instead of
guessing, so a missing decision surfaces as an error rather than a wrong base.

### `shipkit init`

`init` draws a hard line between what the forge can prove and what only the team knows.

**Read from authoritative sources — these are facts, not guesses:**

- **Branch name pattern** — from the repository ruleset.
- **Required approvals** — from branch protection.
- **Blocking labels** — from the merge-gate workflow.
- **Jira base URL and key pattern** — from links already present in PR bodies.

**Not inferred — authored once, by the team:**

- **The PR body template.** `init` writes a starter template into `.shipkit.yml` and
  stops for review. The starter is seeded from the project's best-formed PRs, offered
  as a proposal to edit rather than a consensus to accept.

### Why the template cannot be inferred

The obvious design — diff the last N merged PR bodies and keep what they share — was
tried against the motivating repository and rejected. Of 80 recent merged PRs, 88%
carry an `Issues Addressed` heading, but the rest of the structure varies enough that
an intersection would produce something thinner than any real PR and truer to none of
them.

More importantly, inference would encode the current average. The team's stated
intent is the opposite: pick a baseline deliberately and hold new PRs to it. A tool
that mirrors existing inconsistency cannot fix it.

So the template is a decision the team makes once, with shipkit offering a good
starting point and enforcing it forever after.

## The contract

`shipkit brief` emits:

```json
{
  "change":   { "files": ["..."], "diffstat": "...", "commits": ["..."] },
  "ticket":   { "key": "ABC-31087", "type": "Development", "summary": "...",
                "parent": { "key": "ABC-31086", "type": "Bug", "summary": "..." },
                "linkPolicy": "parent" },
  "target":   { "branch": "release/3.76.0", "reason": "..." },
  "template": { "sections": [
                  { "name": "Summary", "required": true, "hint": "..." },
                  { "name": "What to Test", "required": true, "minItems": 3, "hint": "..." }
                ] },
  "rules":    { "titlePattern": "...", "branchPattern": "...",
                "forbidden": ["TBD", "TODO", "<!--"] },
  "responseSchema": { "...": "JSON Schema the agent's answer must satisfy" }
}
```

The agent writes a response file. `shipkit submit` reads it and refuses non-compliant
input rather than repairing it — silent repair would hide the fact that the agent
ignored the rules.

## Validation gate

`submit` and `check` enforce:

- Title matches the configured pattern.
- Every required section is present and non-empty.
- No template placeholders survive (`<!-- ... -->`, `TBD`, `TODO`).
- **What to Test** has at least `minItems` entries. This is the section agents most
  often reduce to one vague line.
- The cited Jira key satisfies `linkPolicy`. With `linkPolicy: parent`, a Development
  subtask is rejected in favour of its parent. This mirrors observed practice: across
  recent merged PRs whose title carried a Development subtask, every one linked the
  parent Story or Bug in the body — five of five, no exceptions.
- The branch name matches the configured pattern.
- The target branch is permitted for this branch type.

## Pre-flight

Before any irreversible step, `submit` stops and reports. Every check below exists
because the failure it catches actually happened while this tool was being designed:

| Check | Failure it prevents |
|---|---|
| Pushing will dismiss N existing approvals | Four approvals lost to a redundant merge commit; a fresh approval lost to a base change. |
| Diff carries M files unrelated to the ticket | A branch with `develop` merged into it, retargeted at a release branch, would have shipped three other squads' commits. |
| Branch is based on X but targets Y | A PR whose base was moved to 3.76 while its branch still sat on 3.75. |
| A blocking label is present | Two PRs sitting green-but-unmergeable behind an `in test` label. |
| Branch name violates the ruleset | A push rejected for a `.` in the branch name, discovered only at push time. |

Pre-flight reports; the human decides. It does not silently refuse.

## Target branch

shipkit does not attempt to derive the target branch. The choice depends on release
timing and scope — whether a fix rides the current train or waits for the next one —
which is a human judgement the repository does not record.

Resolution is therefore:

1. Explicit `--base`, when the caller already knows.
2. Otherwise **ask**. shipkit lists the plausible targets (the default branch and any
   live release branches), marks the repository default as the suggestion, and waits.

The answer is echoed in the brief so the agent writes against the right base, and
re-stated at pre-flight so a wrong pick is caught before the PR exists.

An earlier draft resolved this from the ticket's `fixVersion`. It was dropped: the
field is not reliably set, and guessing wrong here is exactly the failure that costs
a round of dismissed approvals.

## Modules

Pure logic is separated from I/O so that the interesting parts are testable without a
network or a repository.

| Module | Responsibility |
|---|---|
| `config` | Load, validate, and default `.shipkit.yml` |
| `infer` | Derive a config from observed repository data (`init`) |
| `brief` | Assemble the brief |
| `validate` | Enforce the validation gate |
| `preflight` | Detect the risky conditions above |
| `vcs` | Adapter over `git` and the GitHub API |
| `jira` | Adapter over the Jira API |

`config`, `infer`, `brief`, `validate`, and `preflight` are pure functions over plain
data. `vcs` and `jira` are the only modules that touch the outside world.

## Testing

- Unit tests for every pure module, driven by fixtures captured from real PRs —
  including the malformed ones this design is a reaction to.
- `infer` is tested against recorded API payloads: given these merged PRs, produce this
  config.
- `vcs` and `jira` are faked at the adapter boundary.
- One end-to-end test drives a scratch repository through
  `init → branch → brief → submit`.

## Open questions

- **Response transport.** The agent writes a file today. Accepting the response on
  stdin may suit some agents better; defer until a second agent is wired up.
- **Config discovery.** `.shipkit.yml` at the repository root is assumed. Monorepos may
  need per-package configs; no consumer needs this yet.
