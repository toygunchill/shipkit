# shipkit — reviewing a pull request that is already open

**Date:** 2026-09-24
**Status:** Approved design, implementation in progress

## Problem

Everything shipkit does today happens *before* a pull request exists. It reads a local
branch, evaluates the change against the repository's conventions and readiness rules, and
either refuses the submission or opens the pull request. Once the pull request is open,
shipkit has nothing more to say.

But the reviewing is the part that costs a team its afternoons, and it is the part where a
machine-readable ruleset would help most. A repository that has written its conventions
down — as architecture decision records, as a readiness checklist — has already done the
expensive half of the work. Nothing reads them at review time.

The ask is to close that loop: review an open pull request, mine or somebody else's,
against the rules that repository already carries, see the remarks anchored to the lines
they are about, keep the ones worth keeping, add my own words, and post them as review
comments on GitHub.

## What shipkit does and does not do here

The existing division of labour holds and decides most of this design.

> shipkit does not write the prose. The agent does. It already holds the full context of
> the change; a second model call would cost money and lose it.

So the agent reviews. shipkit gathers what is knowable — the diff, the rules, the anchors
a comment is *allowed* to land on — hands it over as a structured brief, and accepts the
answer only if it validates. What is new is the last step: shipkit now writes the accepted
answer back to the forge.

That write is the first time shipkit has produced something other people see immediately,
and it is the constraint the rest of the design is arranged around.

## Decisions

| Decision | Choice | Reason |
|---|---|---|
| Who produces the remarks? | **The agent.** | The rules engine answers "is this change ready", and its findings are file-level. Line-level code review is a different question and the agent is already the thing that reads code. |
| What may it comment on? | **Only what a rule says.** | Every remark cites a rule id. A remark that cannot cite one is not written. This is the whole noise control: the output is not "what the model thinks", it is "ADR-012 says this, and this line does not". |
| How do comments reach GitHub? | **One review, published directly.** | One review is one notification; N comments would be N. Publishing directly rather than as a draft was the author's explicit call — the editor's tick is the human gate. |
| What event? | `COMMENT`, always. | `APPROVE` and `REQUEST_CHANGES` are a different decision with different social weight. Out of scope until this works. |
| Where is it started from? | **The menu bar**, falling back to the terminal. | See "The attachment problem" — the menu bar cannot run an agent, so it either hands the request to one or tells you to start one. |

### Why every remark must cite a rule

An agent asked to review a diff will always find something to say. That is not a feature:
a review that produces fifteen remarks of which four matter trains its reader to skim, and
a reviewer who skims is worse than no reviewer. Requiring a rule id is a hard filter that
the agent cannot talk its way past, and it moves the argument from "the model thinks this
is unclear" to "the repository decided this, in writing, and here is the line".

It also means the output improves when the team writes more rules down, rather than when
somebody tunes a prompt. That is the right incentive.

## The anchor problem

This is the part most likely to break, and it breaks at the last step, after the person has
already spent attention on the review.

GitHub refuses a review comment whose line is not part of the pull request's diff — a 422,
after everything else has succeeded. The line has to be one the diff touches, on the right
side: `RIGHT` for added and context lines, `LEFT` for deleted ones.

So shipkit computes the set of commentable anchors *before the agent is asked anything*, by
parsing the unified diff's hunk headers, and hands that set to the agent as the positions a
remark may use. Then it validates the answer against the same set. An agent that anchors
outside it is refused — not repaired, because a silently moved comment points at the wrong
line, which is worse than no comment.

A remark that genuinely belongs to no single line is not discarded. It becomes a
pull-request-level comment, and the editor says so in as many words, so a person is never
under the impression that a general observation was pinned to a line.

### Deriving the anchors

For each hunk header `@@ -a,b +c,d @@`:

- a line beginning `+` is commentable at the new-file line number, `side: RIGHT`
- a line beginning `-` is commentable at the old-file line number, `side: LEFT`
- a context line (leading space) is commentable at the new-file line number, `side: RIGHT`
- `\ No newline at end of file` advances neither counter

The anchor set is keyed by `path`, and carries the head commit id, which the review payload
needs.

## The flow

```
menu bar      "Review" on a pull request in the inbox
  shipkit     gh pr view + gh pr diff        → metadata, unified diff
  shipkit     load conventions + readiness from the base ref
  shipkit     parse the diff                 → allowed anchors
  shipkit     emit the brief                 → diff, rules, anchors
  agent       writes pr-remarks.json         → ruleId, path, line, side, body
  shipkit     validate                       → refuse unknown rule or bad anchor
  editor      remarks drawn on the lines they belong to, tick + note on each
  person      ticks, edits, adds their own
  shipkit     POST one review, event COMMENT
```

## The attachment problem

The menu-bar application cannot produce a review. It has no agent in it, and MCP is
request/response — a server cannot hand work to an agent that did not ask for it. This is a
property of the protocol, not something to engineer around, and pretending otherwise would
produce a button that silently does nothing.

What shipkit can know is whether an agent is *there*. The `shipkit mcp` process runs as a
child of the agent for exactly as long as the agent does, so it registers itself with the
menu-bar application on start and deregisters on exit. That registration is the answer to
"is an agent attached", and it is a fact rather than a guess.

- **No agent attached** — the menu bar says so and offers to open a terminal with
  `shipkit review --pr <n>` ready to run. The button never pretends to have done something.
- **An agent attached** — the request is written where the agent's next turn will find it.
  The button is one press, but the work begins on the agent's next turn, not instantly.

Instant delivery would need the agent to support MCP server-initiated notifications.
Support for that varies by agent and cannot be relied on across Claude Code, Copilot,
Codex and Antigravity, which is the compatibility this product is built for. If it turns
out to work in one of them, it is an optimisation on top of this design, not a replacement
for it.

## Refusing the agent's answer

`validate` refuses, naming what was wrong, when a remark:

- cites a rule id that is not in the loaded ruleset — including a plausible-looking one the
  agent invented, which is the failure this check exists for
- anchors to a `path` the diff does not touch
- anchors to a `(line, side)` outside that path's anchor set
- carries an empty body

Refusal is per-remark and the rest still reach the editor, because one bad anchor is not a
reason to throw away four good remarks. The refused ones are reported, not hidden — an
agent that keeps inventing rule ids is something the person should find out about.

## Publishing

One `POST /repos/{owner}/{repo}/pulls/{n}/reviews`, with `event: "COMMENT"`, `commit_id`
set to the head the anchors were computed against, and every ticked remark as an entry in
`comments`. Pull-request-level remarks go into the review `body`.

Because this publishes immediately, the editor's send control states what will happen
rather than inviting a reflex: the pull request, its author, the number of comments, and
that they will be visible to everyone. `--dry-run` prints the exact payload and posts
nothing. A review with no ticked remarks is not posted at all.

The head commit is recorded when the anchors are computed and sent with the payload. If the
author pushes while the review is open, GitHub's own outdating behaviour applies to the
comments rather than shipkit silently re-anchoring them to lines it never read.

## Testing

- Anchor derivation is a pure function over diff text. Fixtures, no network. The cases that
  matter: multiple hunks, a pure deletion, a pure addition, a file with no trailing newline,
  a rename, a binary file.
- Validation is a pure function over remarks plus an anchor set.
- The payload is built by a pure function and asserted on. **No test posts a review.** The
  `gh` call sits behind the injected runner seam `vcs/github.ts` already uses.
- No fixture contains any real repository's code, rules, or identities.

## Out of scope

- `APPROVE` and `REQUEST_CHANGES`.
- Replying to, or resolving, existing review threads.
- Reviewing anything that is not a GitHub pull request.
- Suggested changes (`suggestion` blocks). The anchor work here is what they would need,
  so this is a later addition rather than a different design.
