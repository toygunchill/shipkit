# shipkit

Holds AI coding agents to a team's pull-request conventions.

A team's conventions are the last thing an agent gets right and the first thing
a reviewer notices. On the repository that motivated this tool, they live in
three places an agent cannot read: a pull-request template outside the
repository, a branch-name rule in a server-side ruleset, and tribal knowledge
about which Jira issue to cite and which branch to target.

Running the finished checker against the 78 most recent merged pull requests
there: **56 of them left the template's own instruction text in place,
unfilled**, and review passed anyway. A tool that only reformatted output would
not touch that number. Refusing to open the pull request is what does.

shipkit makes the conventions machine-readable, tells the agent what to write,
refuses output that does not comply, and warns before the steps that are
expensive to undo.

## It does not write the prose

The agent does. It already holds the full context of the change; a second model
call would cost money and lose it. shipkit gathers what is knowable from the
repository, the forge and the tracker, hands it over as a structured brief with
the rules attached, and accepts the answer only if it validates. It refuses
rather than repairs — a silent repair hides that the rules were ignored.

## Commands

```
shipkit check    Validate a title and body against .shipkit.yml. No side effects.
shipkit brief    Emit the JSON brief an agent fills in.
shipkit review   Show the change and the findings on a local page, and take one answer.
shipkit submit   Validate, warn, then commit, push and open the pull request.
shipkit mcp      Serve the same three as MCP tools over stdio.
```

`check` is the one to run in CI. Instructions are advisory and an agent can
ignore them; CI cannot be ignored, and it is the layer that moves the number
above.

## The way back

Everything above is shipkit talking. `shipkit review` is the way back.

It computes exactly what `submit` would compute — the same base, the same
uncommitted-work reads, the same pre-flight, the same readiness evaluation —
and pushes nothing. It serves one page on loopback, behind a single-use token,
showing the diff (including the work that is not committed yet, because that is
what the push will carry) and every finding, warning and piece of advice as a
card with a checkbox and a note field. It waits for one answer, writes it to
`.shipkit/fix-request.json`, and exits.

The next `shipkit brief` carries that file first, before the change and before
the rules, saying in so many words that a person chose it. A successful
`submit` moves it aside with a timestamp so a stale selection cannot haunt the
next run; a `submit` that refuses leaves it exactly where it was. The file is
excluded from staging everywhere the response file is, so it can never reach a
commit.

shipkit speaks, the human chooses, the agent fixes.

## What it refuses

Eight rules: the title's format, missing or empty sections, too few items under
*What to Test*, the template's own boilerplate left in place, no issue key
cited, a branch name the ruleset would reject, and a Jira key cited at the wrong
level — a Development sub-task where the parent Story belongs.

## What it warns about

Seven pre-flight checks, each for a failure that actually happened while the
tool was being designed: a push that will dismiss existing approvals; a branch
carrying another ticket's commits; a base that disagrees with the open pull
request; a label that blocks the merge gate; a cited issue that could not be
verified; untracked files that staging would sweep into the commit; and
the comment lines the push adds, which are asked about rather than
forbidden. Only the licence header is exempt: a plain comment counts when it is
indented, and a `///` counts wherever it sits.

Pre-flight reports. The human decides.

## Using it from an agent

Over MCP, one registration per agent per machine makes the tools appear in the
agent's own tool list — no prose copied into any repository. See
[docs/integration/](docs/integration/) for that and for the instruction-file
route used by agents without MCP.

## Installing

Not yet. See [packaging/](packaging/) — the Homebrew formula is written and the
release script works, but Homebrew installs from a URL and this repository has
no remote.

For now, from a checkout:

```bash
npm install && npm run build
node dist/cli.js --help
```

## Configuration

`.shipkit.yml` at the repository root. `docs/examples/example-app.shipkit.yml`
is a working one, reconstructed from a real team's rules — but note that it
sets `pr.approval: human` (see below); a reader copying it as a starting point
inherits that setting too.

There is no `shipkit init` yet, so it is written by hand.

### `pr.approval` and `pr.approvalTimeoutSeconds`

`pr.approval` decides who a pre-flight warning is answered by:

- `echo` (the default) — the caller's own acknowledgement of the warning ids
  is enough, exactly as before these keys existed. Setting this explicitly, or
  omitting it, preserves today's behaviour on every repository.
- `human` — a person must decide, every time, regardless of which ids the
  caller echoed back. This requires a separate approval surface listening on
  a local socket: the menu-bar app in `apps/menubar`. Build and launch it with

  ```
  ./scripts/app.sh
  open apps/menubar/build/shipkit.app
  ```

  The app is ad-hoc signed, so Gatekeeper blocks the first launch: right-click
  the bundle and choose Open once. When it is not running, `submit` under
  `human` refuses every warned push outright rather than pushing unapproved.

`pr.approvalTimeoutSeconds` (default `120`) is how long `submit` waits for
that person's decision before refusing and naming a fingerprint the call can
be repeated with to resume the same request.
