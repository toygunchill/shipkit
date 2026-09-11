# Splitting a change into commits

**Raised:** 2026-09-11, during the approval-surface work. Not scheduled.

## The ask

shipkit should be able to split finished work into several sensible commits
rather than one, and the choice — one commit, or split into parts — should be
made from the menu bar.

## Why it fits

shipkit already gathers the diff, the changed files and the commits on the
branch, and already has a contract where it supplies knowledge and the agent
supplies judgement. Deciding where a change divides is judgement: it needs to
know what the work was for, which is the one thing the agent has and shipkit
does not.

So the shape is the existing one. The brief carries the change; the agent
answers with a split — an ordered list of parts, each with a message and the
files it covers; shipkit validates it (every changed file accounted for exactly
once, every message matching the commit rules) and applies them in order.

The model doing it is whichever model is driving. shipkit never writes the
prose and would not write the split either.

## Where the menu bar comes in

The approval panel already shows what is about to happen. Putting the choice
there turns it from "yes or no" into "yes, and shaped this way" — the person
sees the proposed split, and can collapse it to one commit or send it back.

That is a larger change than it sounds: today the panel returns a decision, and
this would have it return a decision plus a shape. Worth doing only once the
decision half is working.

## What would need deciding

- **Files or hunks.** Splitting by file is simple and covers most cases. Hunks
  are what you actually want when one file carries two unrelated changes, and
  they are considerably more work — staging by hunk, and validating that the
  parts still sum to the whole.
- **What happens when a part does not build.** A split that leaves an
  intermediate commit broken is worse than one commit, and checking each part
  builds means building N times.
- **Where the choice lives.** A config default, a tool argument, the panel, or
  all three. The panel alone would leave CI and headless runs with no way to
  express it.
