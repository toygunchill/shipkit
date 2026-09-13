# shipkit — advising a technical task

**Date:** 2026-09-13
**Status:** Approved design, pending implementation plan

## Problem

A developer is given a ticket. While doing it they convert a screen from UIKit to
SwiftUI — work the ticket never asked for. The team's convention is that such work
gets its own technical item, so it is visible, estimated, and not smuggled into
somebody else's story. That convention lives nowhere a machine can read, and the
person who just finished the real work is the least likely to remember it.

This is the same shape as every other convention `shipkit` enforces, with one
difference that decides the whole design: **the tool cannot be sure.** Whether a
conversion was in scope depends on what the ticket asked for, and a wrong answer
here is expensive in both directions.

## What was measured

Nothing below is assumed. Each row was read from the Jira this will run against.

| Question | Answer | Evidence |
|---|---|---|
| Is there a special "technical debt" issue type? | No. `Story` in project `DCP`. | ABC-32605 |
| Where do these live? | Epic **ABC-12154**, "Technical Items - IOS" | 83 children, active for months, 47 of them Stories |
| Is the naming a convention? | Yes: `iOS - <subject> swift ui dönüşümü` | 2 of 2 matching stories, identical shape |
| Is the epic reliably attached? | **No** — 1 of the 2 forgot it | ABC-34414 has no epic link |
| Do these carry a description? | No. Empty. | ABC-32605, length 0 |
| Do they carry labels? | No. | 98 of 100 sprint issues carry none |
| What does creating one require? | `summary`, `customfield_10101`, `customfield_10102` | `editmeta` on ABC-32605 |
| Is `Portfolio / Servis Bilgisi` constant? | Its **parent** is: `Commercial`, the only allowed value. Its **child** is not. | 240 of 240 on the parent; the child varies within a team |
| Is `Digital Team` constant? | **No.** It is the team. | Squad D / Squad C / Squad A / Squad B, one per sprint |

The epic finding is the one that justifies building this at all: half the existing
conversion tickets are not attached to the epic they belong to. A human doing this
by hand forgets. That is precisely the class of thing this tool exists for.

### A sampling error worth recording

An earlier pass reported `Digital Team` as constant at 100/100. That sample was one
team's sprint, so the field could not have come out any other way. Re-measured
across all four active sprints it varies exactly with the team. The lesson is in the
spec because the same trap is available to anyone extending this: a field sampled
inside one team's work will always look like a constant.

## Decisions

| Decision | Choice | Reason |
|---|---|---|
| Does shipkit block the push? | **No.** | Detection cannot be certain. A gate that fires wrongly costs a blocked push; advice that fires wrongly costs a sentence. |
| Does shipkit open the ticket by itself? | **No, it offers.** | Creating a Jira issue is the first irreversible external effect in the product. It happens only when a person asks for it. |
| Where does the advice appear? | `brief` and `submit` output. | The agent acts on it and the human reads it. It is not on the approval panel — see below. |
| How is the team known? | **Derived** from the developer's own recent issues. | It varies per person, and `.shipkit.yml` is committed and shared. Zero configuration is the only thing that works for four teams. |
| What if the team cannot be derived? | Say so and stop. | The governing principle: confidently wrong is worse than absent. |

### Why advice is not a warning

`shouldRequestApproval` returns true whenever there is any unacknowledged warning,
and under `pr.approval: human` a person is asked every time. So adding this as a
`Warning` would gate every push carrying a conversion — the opposite of the decision
above, arrived at silently. Advice therefore needs its own channel, one that never
reaches `shouldRequestApproval` and never changes an exit code.

It also stays off the approval panel. The spec's rule is that a field displayed
there must be bound into the fingerprint; advice is not a decision and binding it
would tangle two unrelated ideas. It reaches the agent, which is who acts on it.

## Detection

A pure function over the changed files. The signal is a file that loses UIKit and
gains SwiftUI:

- lost: `UIViewController`, `UIView`, `@IBOutlet`, `@IBAction`, a deleted `.xib` or
  `.storyboard`
- gained: `some View`, `@State`, `@ObservedObject`, `var body:`

Detection must be **conservative**, and the reason is written into this project's
own history: `issue-unverified` fired on every run until it was fixed, and `init`
banned `N/A` because it recurred. A noisy advisor is one nobody reads, and this one
has no gate to make it matter. Prefer missing a conversion to inventing one.

Detection produces a signal, never a conclusion. Whether the conversion was **in
scope** is not decidable from the diff — it depends on what the ticket asked for.
The agent holds the ticket and the diff, so the agent judges. shipkit supplies the
observation and the convention; the agent supplies the reading.

## The advice

When a conversion is detected and the agent judges it out of scope:

```
This change converts UIKit to SwiftUI in 3 files, and ABC-31087 does not ask for it.
Work like this gets its own technical item under ABC-12154 (Technical Items
Maddeler - IOS) — half of the existing ones were never attached to it.

  shipkit tech-task --subject "Seyahat özeti"

Opens: iOS - Seyahat özeti swift ui dönüşümü — Story in DCP, epic ABC-12154,
Digital Team Squad B, sprint Squad B Sprint 45. Nothing is created until you
run it.
```

## Creating it

`shipkit tech-task --subject "<konu>"` assembles:

| Field | Value |
|---|---|
| `project` | from config, `DCP` |
| `issuetype` | from config, `Story` |
| `summary` | from config's pattern and `--subject` |
| `customfield_10101` | parent from config; **child derived, or `--portfolio`** |
| `customfield_10102` | **derived**: the dominant `Digital Team` on the developer's recent issues |
| `customfield_10006` | from config, `ABC-12154` |
| `customfield_10005` | the active sprint whose name begins with the derived team |
| description, labels | omitted — measured to be empty |

Configuration is only what is true for the whole repository:

```yaml
techTask:
  project: DCP
  issueType: Story
  epic: ABC-12154
  summaryPattern: "iOS - {subject} swift ui dönüşümü"
  fields:
    customfield_10101:
      value: "Commercial"   # the only allowed parent
      # no child: it tracks the work, not the repository
```

The six teams are `Squad A`, `Squad E`, `Squad F`, `Squad B`, `Squad C`
and `Squad D`. Only four had an active sprint when this was measured, so the
sprint lookup must tolerate a team that has none rather than assuming one exists.

Everything per-person is derived. A developer on Squad D runs the same command
against the same committed config and gets Squad D and Squad D Sprint 45.

### The portfolio child is the field that cannot be answered

`customfield_10101` is a cascading select, not a plain option, so its payload
carries a child: `{"value": "Commercial", "child": {"value": "…"}}`. The parent
has exactly one allowed value. The child has thirteen, and measuring them across the
four active sprints shows it tracks the *nature of the work*, not the team:

| Team | Distribution |
|---|---|
| Squad C | Only Digital 50/60 |
| Squad A | Only Digital 55/60 |
| Squad D | Only Digital 22, Kişiselleştirme 18, Loyalty 11, MCP Tool 7 |
| Squad B | Payment 36, Only Digital 20 |

**Correction.** An earlier draft said two of four teams have no majority. That was
wrong twice over, and both errors are worth keeping visible.

The arithmetic first: Squad B's 36 of 59 value-carrying issues is 61%, which is a
majority. Only Squad D lacks one, at 22 of 58.

The second error matters more. Those are *team sprint* distributions, and the
derivation reads the *developer's own* issues — so the table above is not evidence
about the input at all. Measured on one real developer's last 60 issues: 68% "Only
Digital", 28% "Payment". Note that this differs from their own team's modal value,
which is "Payment". Person and team are not the same distribution, and using one to
reason about the other is what produced the false claim.

So the threshold is a simple majority of the entries carrying a value. Two thirds
was considered and rejected: the only real personal sample sits at 68%, so a
two-thirds rule would decide this developer's case by 1.6 percentage points, and one
more issue elsewhere would flip it to a refusal. A rule that arbitrary is worse than
a looser one.

What keeps a loose threshold honest here is that the derived value is not silent: it
is printed in the advice before anything is created, `--dry-run` shows the whole
payload, and `--portfolio` overrides it. The rule the rest of the design follows —
refuse rather than guess — still holds for Squad D' four-way split, which is the
case it exists for.

### Deriving the team, and refusing to guess

Read the dominant `Digital Team` across the developer's recently assigned issues.
Cross-team work happens — one issue in a Squad A sprint carried Squad B — so a
majority is required, not a plurality. Below the threshold, or with no assigned
issues at all, `tech-task` refuses and names `--team` as the way to proceed. It
never picks the most common of two near-equal answers.

The same applies to the sprint: several sprints are active on one board at once
(four were, when this was written). Match on the derived team; on no match or more
than one, refuse and name `--sprint`.

### It goes through the approval surface

Creating the issue is the product's first write to a system outside the repository.
It is shown for approval before it happens, reusing what already exists, so a person
sees the exact fields before anything is created.

## Testing

- Detection is a pure function over file lists and contents; fixtures, no network.
- Field assembly is a pure function over config plus derived values; the Jira call
  is behind an injected seam, as `vcs` and `jira` already are.
- No test performs a Jira write. The create path is asserted on the payload built,
  never by creating anything.

## Out of scope

- Conversions other than UIKit to SwiftUI. The mechanism generalises; nothing else
  has been measured, and this design does not pretend otherwise.
- Editing or transitioning an existing issue.
- Anything on Confluence.
