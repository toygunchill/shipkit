# shipkit — answering a review from the menu bar

**Date:** 2026-09-18
**Status:** Approved design

## Problem

`shipkit review` serves a page on loopback and waits for one answer. The menu-bar
application, meanwhile, receives only what `submit` sends it: an approval request. So a
person running a review has exactly one place to answer it, and it is a browser tab — while
the surface they already keep open all day, the one that tells them which pull requests are
waiting, knows nothing about it.

The ask is not "start a review from the menu bar". It is: **when a review is running, it
should be answerable from either surface**, and the choice should be made at the moment of
answering, not at the moment of starting.

## What already exists, and what that decides

The socket protocol already carries two kinds of request. An approval has no `kind` field;
a Keychain token request carries `kind: "token"` (`Listener.swift`). So a third kind needs
no version bump and no compatibility story — the discriminator is already there and already
tested. A review offer is `kind: "review"`.

`runReview` already waits on `Promise.race([answer, wait(REVIEW_TIMEOUT_MS)])`. A second
source of answers is a third promise in that race, not a new control flow.

## The defect this uncovers, which is not new

`Listener.serve` reads one line, then hands the request to the presenter and awaits a human
decision. **While it is waiting, nothing is reading the socket.** A client that goes away —
`shipkit submit` hitting its own timeout and exiting, or a person pressing Ctrl-C — is not
noticed until the eventual `send`, which fails silently because `SO_NOSIGPIPE` is set.

Today that means an approval panel can outlive the run it belongs to: the person reads it,
clicks Approve, and nothing happens anywhere. Nobody is told. With two answer surfaces the
same hole gets worse and more likely — the browser answering first would leave a review on
the panel that cannot be answered.

So the fix belongs to this design even though the bug predates it: **while a request is
presented, watch its connection for end-of-file and withdraw the request when the peer goes
away.** One mechanism, both kinds, and the existing approval hole closes with it.

## The race

Both surfaces are offered the same review. The first answer wins; the loser is withdrawn.

| Who answers first | What happens |
|---|---|
| The page | `runReview` takes the selection, stops the HTTP server and closes the socket. The panel sees EOF and withdraws the review without asking anyone anything. |
| The panel | The socket answer resolves the same promise the page would have. The HTTP server is closed; a page still open gets a 409 on submit, which is what it already says for a second answer. |
| Neither | The ten-minute timeout fires, both are closed, nothing is written — exactly today's behaviour. |

The selection is written **once**, by `runReview`, in the callback that both paths reach.
Nothing about the file, the archive or the brief changes: the panel is a second way to say
the same thing, not a second thing to say.

## What the panel shows

The offer carries what the page carries, minus the diff:

- the repository, branch and base, so a person who has three checkouts knows which one
- the commit message when there is one, and the diffstat
- **the items** — every finding, warning, readiness rule and piece of advice, with its
  channel and severity, each with a checkbox and a note field, exactly as the page has them
- **the files** the change touches, each with a button that opens it in the editor

The items are the answer to "I want to see the rules side in the menu bar too": a readiness
rule reaches the panel through the same `ReviewItem` the page draws, so there is one list and
one wording, not two that drift.

The diff itself is not sent. A menu-bar popover is the wrong shape for four hundred files,
the page is one click away, and the editor button is the better answer to "let me look at
this properly" — which is what the button is for.

## Opening the editor from the panel

The application launches `/usr/bin/xed` by absolute path, with a timeout, on a path **taken
from the offer and nowhere else**. The confinement rule is the one `POST /open` already has
and which a review confirmed holds: the set of openable paths is the set shipkit itself
computed, and a path that is not a member is refused. The panel cannot ask for a file that
was not in the offer, because the panel has no way to name one.

## Fingerprint

A review offer is fingerprinted like an approval request, over the fields the panel displays.
The property is the same one the approval surface has: **what the person sees is what was
hashed**, so a request whose fingerprint does not match its own fields is refused without
being shown. The cross-language vector file grows two review vectors, and both languages
compute them independently — the contract is the fixture, not either implementation.

Unlike an approval, a review decision is **not journalled**. The journal exists so that the
same push is not approved twice within ten minutes; a review is a person reading a diff, and
re-running it after answering is an ordinary thing to do, not a repetition to be suppressed.

## Out of scope

- Starting a review from the menu bar. Explicitly not wanted: the review belongs to a
  working tree and a base branch, and the surface that knows those is the shell.
- Showing the diff on the panel. The page and the editor both do it better.
- Showing a repository's readiness checklist outside a running review. There is a real
  question there — "what will this repo ask me?" — but it is a different feature with a
  different trigger, and nothing measured says anyone wants it yet.
