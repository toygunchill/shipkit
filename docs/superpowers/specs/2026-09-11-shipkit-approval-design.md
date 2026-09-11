# The approval surface — Design

**Date:** 2026-09-11
**Status:** Approved design, pending implementation plan
**Builds on:** `2026-09-10-shipkit-design.md`, `2026-09-11-shipkit-mcp-design.md`

## Problem

The MCP design says, about the gate on `shipkit_apply`:

> A tool call has no human who watched the warnings scroll past.

It answers that by making the agent echo back the warning ids it saw. That binds
the agent — it must have received the warnings to name them, and a changed
situation invalidates them. It does not bind the human, who still sees only what
the agent chooses to paste into a chat window.

So the warnings that matter most — a push about to dismiss four approvals, a
branch carrying another squad's commits, a label that will block the merge —
reach a person only by the agent's goodwill. Every one of those is on the
pre-flight list because it actually happened, and in each case a person would
have said no if asked.

This design puts the person back in. A menu-bar application receives the
refusal, renders the warnings, and returns a decision. The agent cannot
fabricate it.

## Goals

- A human decision, made against a rendering of the warnings, can satisfy the
  gate.
- A team can require that decision rather than merely allow it.
- shipkit keeps working with no application installed, exactly as it does today.
- The Jira token stops living in a shell export.

## Non-goals

- **Confluence.** shipkit does not use it.
- **Approving from anywhere but this machine.** No network listener, no remote
  transport, no phone. A local socket and a local UI.
- **Notification Center, sounds, or any attempt to interrupt.** The menu-bar
  icon changes shape; that is the whole notification.
- **Remembering a decision beyond the request it was made for.** See "Nothing is
  remembered".
- **Replacing the echo gate.** It stays, and remains the default.

## How a decision travels

The MCP server is a short-lived child of the agent. The menu-bar application is
long-lived. They meet at a Unix domain socket.

```
agent ──calls──▶ shipkit_apply ──▶ pre-flight produces warnings
                                        │
                        all acknowledged │ no
                                        ▼
                              connect to the socket
                                   │         │
                        no listener│         │listener
                                   ▼         ▼
                         today's refusal   request ──▶ menu bar badges
                                                           │
                                            approve / deny ▼
                                   ◀────────────── decision
```

### The socket

`~/Library/Application Support/shipkit/approvals.sock`, in a directory created
`0700`. `SHIPKIT_APPROVAL_SOCKET` overrides the path — tests need it, and it
costs one line.

The socket file is `chmod`ed to `0600` **after** binding, not left to the
process umask. Measured: a freshly bound socket comes out `0755`, so a listener
that only creates the file and trusts its defaults is world-readable. The `0700`
directory is the real control either way, and the mode on the socket is the
second lock rather than the first.

A Unix socket rather than a localhost port: there is no port to collide with,
nothing is reachable from another machine, and the filesystem permissions are
the access control. An HTTP transport would need authentication invented for it
and would still need local `git`.

### The messages

Newline-delimited JSON. One request per connection, one response, then close.
Readable with `nc` when something goes wrong, which is worth more than
compactness for a protocol that carries this much weight.

Request:

```json
{
  "protocol": 1,
  "fingerprint": "8f2c…",
  "repo": "/Users/x/example-app",
  "branch": "bugfix/squadb/31087-invoice",
  "base": "release/3.76.0",
  "head": "a44dcf5d9f8a0c59fb282d667cfab5e1e809d6bd",
  "title": "fix(invoice): default citizenship from passenger info",
  "commitMessage": "fix(invoice): default citizenship from passenger info",
  "diffstat": "12 files changed, 148 insertions(+), 37 deletions(-)",
  "warnings": [
    { "check": "approvals-dismissed", "message": "Pushing will dismiss 4 …" },
    { "check": "blocking-label", "message": "Label \"in test\" will block …" }
  ]
}
```

Response:

```json
{ "protocol": 1, "fingerprint": "8f2c…", "decision": "approved" }
```

`decision` is `approved`, `denied`, or `pending`. A response whose `fingerprint`
does not match the request is discarded and treated as a denial — a reply about
some other request is not an answer to this one.

`protocol` is checked. A mismatch is reported as a version disagreement naming
both sides, not as a parse failure.

## The fingerprint

The echo gate's real property is not that ids are named, but that they are
checked against what pre-flight produces *now*: a review landing between two
calls closes it again. A human decision has to keep that property or this design
is a downgrade.

So an approval is bound to a SHA-256 over a canonical rendering of:

- the repository path,
- the branch, the base, and the current `HEAD` commit,
- the pull-request title and the commit message,
- every warning, its check id **and its message**, ordered by id.

The title and the commit message are in the hash because they are on the
screen. The application shows them so the reader knows which change they are
approving, and a field that is displayed but not bound is a field the reader
can be shown one version of while another is committed: two calls with the same
warnings and the same head, differing only in prose, produce the same
fingerprint, and the second collects the decision made about the first.

Including the messages, not only the ids, is deliberate. "Pushing will dismiss 4
approvals" and "… 2 approvals" carry the same id. If a fifth approval lands
while the request sits waiting, the id set is unchanged and the situation is
not. Messages are generated from the facts, so folding them in folds in the
facts. The cost is that rewording a message invalidates a decision in flight,
which happens only when the code changes.

After a decision arrives, `shipkit_apply` recomputes the fingerprint from freshly
read facts before it acts. A mismatch voids the approval and the request goes
back to the human.

`readRepoState` does not currently return a `HEAD` sha. It gains one.

## Waiting, and not waiting forever

The person may be in a meeting; the MCP client has a call timeout.

`shipkit_apply` waits up to `approvalTimeoutSeconds` (default 120). On timeout it
returns a refusal that names the fingerprint and says to call again. The second
call reconnects and, because the application keeps decisions by fingerprint for
ten minutes, either finds the answer waiting or resumes waiting for it.

Keying the journal by fingerprint rather than by a request id is what makes this
safe: a resumed call is only satisfied by a decision made about the identical
situation. It also means two agents racing on the same branch cannot pick up
each other's answers unless the situation is genuinely identical, in which case
they should.

## What a denial means under `echo`

Unresolved, and named here rather than left to be discovered.

Under `echo` the gate opens when the caller's acknowledgement covers the
warnings, and it opens without asking anyone. So a caller that is refused by a
person can simply call again with the ids echoed back and proceed: the surface
is never consulted a second time, and the refusal is discarded rather than
overridden. The whole premise is that an agent cannot fabricate a human
decision, and this is the same hole seen from the other side — it can discard
one.

Every cheap repair is wrong. Asking every time turns `echo` into `human`.
Not asking means never learning a denial happened. Asking only to check whether
a decision already exists needs a query the protocol does not have, answered
from a journal that lives in the application.

So it belongs with the application, and the decision to make there is whether a
denial binds the situation it was made about — for as long as the journal keeps
it — regardless of policy. This design's position is that it should: a person's
"no" about a fingerprint should outrank an agent's acknowledgement of the same
fingerprint. Implementing that means a protocol addition and is out of scope
for the Node half.

## Nothing is remembered

No "approve all", no "don't ask again for this repository", no trusted-branch
list. The ten-minute journal is scoped to one fingerprint and exists so a
timed-out call can resume; it is not a memory of preference.

A consent surface with a remember-me checkbox is a consent surface that has
stopped working, and the failures this tool exists to prevent are exactly the
ones that look routine until the one time they are not.

## Policy: `pr.approval`

A new key under `pr` in `.shipkit.yml`, `echo` or `human`, defaulting to `echo`.

**`echo`** — today's behaviour, plus a convenience. Echoed ids satisfy the gate.
If ids were not echoed and the application is running, shipkit asks. Existing
repositories are unaffected.

**`human`** — only a decision from the approval surface satisfies the gate.
Echoed ids do not, and neither does the CLI's `--yes`, which is refused with a
message naming the policy.

That last point is a real cost and it is chosen, not overlooked. `--yes` is
typed before the warnings are rendered; under a policy whose whole purpose is
that someone looked, accepting it would make the policy decorative. The
consequence is that in a `human` repository the command line cannot push past a
warning without the application running. On a developer's own machine — which is
the only place either the CLI or an MCP server runs — that is a small price. In
CI there is no `submit`, only `check`, so nothing changes there.

`docs/examples/example-app.shipkit.yml` sets `human`. This repository stays on
the default.

## With no application running

The connection fails. shipkit then behaves by policy:

- `echo` — exactly as it does today: refuse and name the ids to acknowledge.
- `human` — refuse, and say that the approval surface is not running and how to
  start it.

Neither reports a socket error. A person reading the output should learn what to
do, not what failed inside.

This is the property that keeps the application optional. Everything shipkit does
today keeps working with nothing installed, and a repository only becomes
dependent on the application by choosing `human`.

## What the person sees

The judgement has to be possible in a few seconds without opening a terminal.

```
shipkit wants to push  ·  example-app
bugfix/squadb/31087-invoice → release/3.76.0

⚠ Pushing will dismiss 4 approvals on #881
⚠ Branch carries commits citing ABC-27975, not ABC-31087
⚠ Label "in test" will block the merge gate

fix(invoice): default citizenship from passenger info
12 files changed, 148 insertions(+), 37 deletions(-)

                          [ Deny ]  [ Approve push ]
```

The warnings are the content. The title and diffstat are there so the reader
knows which change they are approving. Nothing is pre-selected and neither
button is the default.

The menu-bar mark carries the state: `design/icon/mark-pending.svg` while a
request waits, `mark.svg` otherwise. The silhouette changes rather than a colour,
because a menu-bar icon is tinted by the system and cannot carry its own.

## The Jira token

Today `resolveIssue` reads `SHIPKIT_JIRA_TOKEN` from the environment. An MCP
server is spawned by the agent, and an agent launched from the Dock does not
source a shell profile — so the variable may simply not be there, `resolveIssue`
returns nothing, and `issue-unverified` fires on every single run. That is how a
warning becomes one nobody reads.

The application stores the token in the Keychain (`service: shipkit`,
`account: jira`) from a Settings panel.

An earlier draft had shipkit read it back with `security find-generic-password
-s shipkit -a jira -w`, a subprocess call to a system binary in the same shape
`git` and `gh` already have. **That does not work, and it was measured rather
than assumed.** An item written by an application through `SecItemAdd` cannot be
read by `/usr/bin/security`: the command blocks on a SecurityAgent
authorisation prompt — eight seconds to an alarm, no output, no error. Adding
`/usr/bin/security` as a trusted application, through
`SecTrustedApplicationCreateFromPath` and `SecAccessCreate`, does not fix it
either. The obvious repair fails the same way.

The application reading its own item prompts for nothing. So the token travels
over the socket that already exists, as a second kind of request:

```json
{ "protocol": 1, "kind": "token", "account": "jira" }
```

answered with the secret or with nothing. One channel, one place holding the
keychain access that works, and no new dependency — which is what the
subprocess call was for.

The environment variable is still read first, so CI and a deliberate override
are untouched, and a machine with no surface running behaves exactly as it does
today.

Order: the environment first, so CI and explicit overrides keep working, then the
Keychain. A token in neither place is not an error; it is the existing
`issue-unverified` warning, unchanged.

## Modules

| Path | Responsibility |
|---|---|
| `src/approval/fingerprint.ts` | The canonical rendering and its hash. Pure. |
| `src/approval/protocol.ts` | Request and response shapes, and their validation. Pure. |
| `src/approval/client.ts` | Connect, send, await, time out. The only part that touches the socket. |
| `src/approval/policy.ts` | Given policy, acknowledgement and decision, does the gate open. Pure. |
| `src/secrets/keychain.ts` | Read a secret, with a runner seam. |
| `apps/menubar/` | The Swift application: listener, journal, UI, Keychain writes. |

`runSubmit` gains one injected dependency, `requestApproval`, and its gate
consults `policy`. The existing acknowledgement path is untouched under `echo`.

## Testing

- `fingerprint`, `protocol` and `policy` are pure and tested directly.
- `client` is tested against a real Unix socket in a temporary directory. That is
  local IPC, not a mutation, and a fake would test the fake.
- One test per refusal: no listener, a denial, a timeout, a protocol mismatch, a
  fingerprint that changed between request and action. Each asserts that no
  mutating dependency was called.
- **A shared fingerprint fixture.** Two implementations compute this hash — one
  in TypeScript, one in Swift — and they must agree exactly or an approval can
  never match its request. A checked-in file of canonical inputs and their
  expected hashes is read by both test suites. This is the one place where a
  silent disagreement would be invisible until someone tried to approve
  something.
- The Swift side is built and tested by its own toolchain. `npm test` does not
  invoke `swift`, and neither suite's failure is hidden by the other.

## Open questions

- **Several waiting requests.** The design assumes one at a time, which is what
  one person driving one agent produces. Two agents on two repositories is
  plausible; whether the popover needs a list or the second request simply
  queues is a question for after it has happened.
- **The application quitting mid-wait.** The client's timeout covers it, and the
  caller retries. Whether that should be distinguished from a timeout in the
  message is unknown until it is seen.
