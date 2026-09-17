# The pull requests that are waiting on you

**Raised:** 2026-09-13 as an idea. **Built:** 2026-09-17, v1, in the menu-bar
panel. This file is no longer a proposal; it is the reasoning behind what
shipped and the list of what v1 knowingly does not do.

Clicking the menu-bar icon used to open the Jira token pane, which said this
application's subject was a setting. It is not. When nothing is waiting for a
decision, the panel now opens on three counts — pull requests waiting for this
person's review, ones they reviewed that need another look, and their own open
ones with answers on them — and the token sits behind an "Add/Edit Jira Token"
navigation.

## Why it fits, where the token counter did not

shipkit is about the last mile of a pull request, and "which pull request needs
me" is the same subject. The data is already reachable through a `gh` seam, and
the panel is already a per-user surface that holds the Jira token.

## The condition, which is not negotiable

The menu-bar mark currently means one thing: **someone is waiting on your
decision and a push is blocked on it.** That is a rare, high-signal state, and
the whole approval design rests on the person believing it.

A review queue is the opposite: almost always non-empty, rarely urgent. If it
shares the mark's state, the approval signal degrades into a number people stop
reading — the same failure as a warning that always fires, which this project
has already fixed twice. So: its own section inside the panel, never the mark.

**As built:** `ShipkitMark.statusImage(isPending:)` is still driven by
`model.pending != nil` and nothing else, and a pending approval still takes the
whole panel — `ApprovalPanel` outranks the inbox, because consent outranks
convenience.

## The three areas, as built

### 1. Waiting on your review

`is:open is:pr archived:false review-requested:<login>`. Cheap, and exactly
what it says.

### 2. Needs another look

Pull requests I already reviewed, that are still open and not mine, where
something has happened **that asks something of me**.

The first implementation compared `updatedAt` against my last review. That was
wrong, and the user said so: `updatedAt` bumps on a label, an assignee, a
milestone, and on somebody else's approval. A bucket that lights up for those is
a bucket that gets ignored.

So membership is **positive evidence**, not movement. A pull request qualifies
when, since my last submitted review:

- **the code moved** — `headRefOid` differs from the commit my review was
  submitted against. Object ids, not timestamps: a force-push leaves timestamps
  describing a tree that no longer exists, and the oid simply stops matching; or
- **somebody else wrote words** — a conversation comment by anyone but me, or
  another person's `COMMENTED` or `CHANGES_REQUESTED` review. Inline thread
  replies arrive as single-comment `COMMENTED` reviews, so that clause catches
  those too.

Excluded by name, and not to be "simplified" back into `updatedAt`: other
people's `APPROVED` and `DISMISSED` reviews, and anything that only moves
`updatedAt`.

### 3. My pull requests

`is:open is:pr archived:false author:<login>`. News is measured against an
**anchor** — my own last touch on the pull request, taken as the latest of: my
own most recent conversation comment, the latest commit's `committedDate`, and
the pull request's `createdAt` as a floor. Anything after that by somebody else
— a review in **any** state, or a comment — is news.

**The inversion, which is the point of keeping two filters:** area 2 excludes
other people's approvals as noise; area 3 counts them, because on your own pull
request an approval is news — this team needs three before it can merge. Same
event, opposite meaning, decided by which side of the review you are on. The two
filters live next to each other in `PullRequestInbox.swift` with this written
above both of them.

Its count and its list deliberately differ from the other two: the **count** is
the number of pull requests with news, because every count on this panel means
"needs me"; the **list** is the author's whole open slate, news first, the quiet
ones dimmed below.

## How it asks

One `gh api graphql` call with three aliased `search` fields, preceded by one
`gh api user` to learn the login — two process spawns per refresh, and `@me` is
never used in a search string because it is not dependable across GitHub
Enterprise versions and an unrecognised term returns an empty result rather than
an error, which would read as a confident zero.

Refreshed when the panel appears, every five minutes while it stays open, and
on a manual control. A refresh in flight dims the previous numbers rather than
blanking them.

`gh` is looked for at `/opt/homebrew/bin/gh`, `/usr/local/bin/gh`,
`/usr/bin/gh`, in that order: an application launched by LaunchServices has no
shell `PATH`. The spawn has a deadline so a hung `gh` cannot wedge the panel.

## Refuse rather than lie

If `gh` is missing, unauthenticated, slow, or answers with something that does
not match the query that was sent, the counts show as **an em dash with one line
saying why** — never a zero, never the previous numbers presented as current.
A zero on this panel always means the search ran and came back empty.

## What v1 knowingly does not do

- **Window caps.** `reviews(last: 20)` and `comments(last: 10)` per pull
  request. Past those, my own review or my own comment can fall out of the
  window; the pull request is then treated as one I have no anchor on and stays
  **out** of its bucket. A silent miss rather than a false alarm — the right
  direction for buckets whose value is being quiet.
- **Someone else's commit on my branch** moves area 3's anchor forward, because
  the anchor treats the latest commit as mine. True in the overwhelming case;
  the alternative is asking for every commit's author in an already large query.
- **Only the first 50 results per search**, and only open pull requests.
- **Nothing is cached.** A refresh that fails leaves no numbers on screen, by
  design.

## What would make it not worth keeping

This space is crowded — GitHub's own inbox, `gh dash`, editor and launcher
extensions. The only advantage here is being in a window that is already open
for another reason. If people do not already keep the panel open, that advantage
is imaginary, and the honest move is to delete this rather than grow it.
