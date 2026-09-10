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
| Rule source | `.shipkit.yml` in the consuming repo, bootstrapped by `shipkit init` | A hand-written config nobody writes is a product nobody uses. Inference removes the starting cost. |
| Autonomy | End-to-end, with a pre-flight gate | Matches how the tool is used — at the end of a task — while protecting the irreversible steps. |
| Home | Standalone repository | The product is not part of any consuming project. Consumers get only a config file. |
| Jira | Connected via API | Required to resolve the Bug-vs-subtask question correctly. |
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
shipkit init                     Infer .shipkit.yml from the repository; human reviews and commits it
shipkit branch "<description>"   Suggest a compliant branch name
shipkit brief                    Emit the JSON brief for the agent
shipkit submit --input <file>    Validate → pre-flight → commit → push → open PR
shipkit check                    Validate only; no side effects. Usable in CI.
```

### `shipkit init`

Writes a config by observation rather than interrogation:

- **PR template** — fetch the last N merged PRs, diff their bodies, and keep the
  headings and boilerplate they share. A structure repeated across merged PRs is the
  de-facto template, whether or not a template file exists.
- **Title and branch patterns** — derive a regex from merged PR titles and branch
  names; cross-check against any repository ruleset the API exposes.
- **Approvals and blocking labels** — read branch protection and the labels that
  correlate with failing merge gates.
- **Jira base URL and key pattern** — extract from links already present in PR bodies.

Output is a commented `.shipkit.yml` for a human to review. Inference proposes; it never
silently governs.

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
  subtask is rejected in favour of its parent Bug.
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

## Target branch resolution

Resolved in order, first match wins:

1. Explicit `--base`.
2. A rule in `.shipkit.yml` matching the branch prefix and, optionally, the ticket's
   `fixVersion` (this is what routes a bugfix to `release/3.76.0` rather than
   `develop`).
3. The repository default branch.

The chosen branch and the reason for it appear in the brief, so the agent can question
it, and in the pre-flight output, so the human can.

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
