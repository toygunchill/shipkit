# Idea — the pull requests that are waiting on you

**Raised:** 2026-09-13. Not built.

Show, in the menu-bar panel, the pull requests that need this person: ones
requesting their review, ones that changed after they commented, ones they
approved that have not merged.

## Why it fits, where the token counter did not

shipkit is about the last mile of a pull request, and "which pull request needs
me" is the same subject. The data is already reachable through the `GhRunner`
seam, and the panel is already a per-user surface that holds the Jira token.

## The condition, which is not negotiable

The menu-bar mark currently means one thing: **someone is waiting on your
decision and a push is blocked on it.** That is a rare, high-signal state, and
the whole approval design rests on the person believing it.

A review queue is the opposite: almost always non-empty, rarely urgent. If it
shares the mark's state, the approval signal degrades into a number people stop
reading — the same failure as a warning that always fires, which this project
has already fixed twice. So: its own section inside the panel, never the mark.

## The three subsets are not equally worth building

| Subset | Value | Cost |
|---|---|---|
| Changed after I commented | **Highest.** Genuinely hard to find in GitHub's own UI, and the thing that falls through. | Highest. Not one `gh` call — needs timeline events compared against the person's last review. |
| Review requested of me | Real. | Low: `gh search prs --review-requested=@me --state=open`. |
| I approved, still not merged | Low on its own; worth something only as "approved and going stale". | Low. |

Build the middle one first if this is built at all: it is the cheapest and it
proves whether anyone opens the panel for this at all, before paying for the
timeline comparison.

## What would make it not worth building

This space is crowded — GitHub's own inbox, `gh dash`, editor and launcher
extensions. The only advantage here is being in a window that is already open
for another reason. If people do not already keep the panel open, that
advantage is imaginary and this should not be built.
