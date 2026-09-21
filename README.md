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
shipkit check      Validate a title and body against .shipkit.yml. No side effects.
shipkit brief      Emit the JSON brief an agent fills in.
shipkit review     Show the change and the findings on a local page, and take one answer.
shipkit submit     Validate, warn, then commit, push and open the pull request.
shipkit init       Write a starter .shipkit.yml, reading what the forge can prove.
shipkit rules      Propose a readiness checklist from the code, for a repo that has none.
shipkit tech-task  Open the technical item for work the ticket did not ask for.
shipkit mcp        Serve brief, preview and apply as MCP tools over stdio.
```

`check` is the one to run in CI. Instructions are advisory and an agent can
ignore them; CI cannot be ignored, and it is the layer that moves the number
above.

### Any repository, any checklist

shipkit is installed once and used everywhere, so the repository and the
checklist are both arguments:

```
shipkit brief  --repo ~/code/other-app --base develop
shipkit review --repo ~/code/other-app --rules ~/conventions/team.yml ~/conventions/ios.yml
```

`--repo` defaults to the working directory, so every command means exactly
what it meant without it. A relative `--config` resolves against `--repo`, not
against the shell.

`--rules` **replaces** whatever the repository's config names, rather than
adding to it — "apply only this checklist" is the question the option answers.
Repeating it applies several, as a list under `readiness:` does. An id defined
in two of them is refused, naming both files: one answer would satisfy both, so
which rule applied would otherwise depend on the order they were listed in.

### When there is no checklist yet

```
shipkit rules --repo ~/code/other-app --out readiness.yml
```

This selects; it does not invent. shipkit ships a catalogue of candidate rules,
each with a detector, and proposes only the ones whose subject is actually in
the repository — with the evidence written above each line:

```yaml
  # observed: UIKit in 9 files, SwiftUI in 15 files
  - id: swiftui-direction
    appliesTo:
      - "**/*.swift"
    severity: advise
```

Three things it will not do. It will not propose a rule for something that is
not there — a checklist asking about what a repository does not have is one
people learn to skip. It will not repeat a linter you already run, and it says
which tool covered what. And everything it derives is `advise`, which never
gates and never changes an exit code, so nothing starts blocking your team's
work before a person has read the file.

The scope is derived too: rules are limited to the languages the repository is
actually written in, and the shared-layer rule names the shared directory it
found. A change touching only a README is asked nothing.

## Getting started

### 1. Install it

```bash
gh auth login                      # once, if you have not
brew tap toygunchill/tools
brew trust toygunchill/tools       # Homebrew refuses a third-party tap until you say so
brew install shipkit
```

Needs Node, which Homebrew pulls in. From a checkout instead:
`npm install && npm run build && node dist/cli.js --help`.

The menu-bar app is a second formula, kept separate so that installing the
command line does not drag in a Swift toolchain:

```bash
brew install shipkit-menubar
open $(brew --prefix shipkit-menubar)/shipkit.app
```

It builds from source and is ad-hoc signed, so the first launch needs Finder's
right-click → Open, once per machine. You only need it if your config sets
`pr.approval: human`, or if you want reviews answerable from the menu bar as
well as the browser.

shipkit runs **inside the repository you are opening the pull request for**, not
in its own. That repository already has the remote and the `gh` login; shipkit
needs neither of its own.

### 2. Teach it your conventions

```bash
cd /path/to/your/checkout
shipkit init
```

`init` reads what your forge can actually prove — the merged pull requests, the
branch ruleset, the merge gate — and writes a starter `.shipkit.yml` with a
label on every value saying where it came from: `read` is a fact, `observed` is
a pattern in what people did (not the same as what they intended), `proposed` is
shipkit's guess and yours to overrule. Read it before you trust it. It never
opts you into anything: `pr.approval` defaults to `echo`.

If your team also has a readiness checklist — the questions worth asking before
a change is ready, not the ones your linter already asks — you can have one
proposed from the code:

```bash
shipkit rules --out readiness.yml
```

It selects; it does not invent. Only rules whose subject is actually in your
repository, with the evidence written above each line, everything at `advise`
so nothing starts gating anyone's work before a person has read it. Point
`.shipkit.yml` at it with `readiness: ./readiness.yml` when you are happy.

### 3. Try it without letting it act

`check`, `brief`, `review` and `rules` never write to your repository, never
commit and never push. Only `submit` and `tech-task` act.

```bash
shipkit brief --base develop        # what shipkit knows and what it will ask for
shipkit review --base develop       # the change and the findings, on a local page
```

Run those on a branch you already have before `submit` goes anywhere near it.

### 4. Wire it into your agent

Over MCP, once per agent per machine — the tools then appear in the agent's own
tool list and nothing is copied into any repository:

```bash
claude mcp add shipkit -- shipkit mcp
```

For agents without MCP, an instruction file does the same job:
`AGENTS.md` for Codex and most others, `CLAUDE.md` or a skill for Claude Code,
`.github/copilot-instructions.md` for Copilot. Snippets for each are in
[docs/integration/](docs/integration/).

### 5. The loop, day to day

```
you              "open the PR"
  agent          shipkit brief --base develop
  agent          writes response.json — title, commit message, sections
  agent          shipkit submit --input response.json --base develop
  shipkit        refuses, or warns and asks, or commits, pushes and opens
```

When you want to look before that happens, put `shipkit review` in front of it.
The page shows the change as it stands — including work not committed yet,
because that is what the push will carry — with shipkit's remarks on the files
they are about, and a checkbox on every line you might want changed. Tick, add
your own words, send. The next `brief` carries your selection first, marked as
something a person chose rather than something a tool inferred.

### What it is not

Not a CI gate and not a rule. It is opt-in per repository and per person: a
teammate who does not run it is not blocked by it, and nothing here enforces
anything on anyone who has not chosen it. If you want a gate, `shipkit check`
is the one command with no side effects — that is the one to run in CI.

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

## Configuration

`.shipkit.yml` at the repository root. `docs/examples/example.shipkit.yml` is a
worked one — invented rather than measured, showing the shape and every key
that exists. Note that it sets `pr.approval: human` to make the key
discoverable; a reader copying it wholesale inherits that, and `init` defaults
to `echo` instead.

`shipkit init` writes a starter one by reading what the forge can prove, and
says where every value came from. `shipkit rules` does the same for the
readiness checklist, from the code.

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

## License

MIT — see [LICENSE](LICENSE). Copyright © 2026 Toygun Çil.

The worked files under `docs/examples/` are invented illustrations, not any
team's configuration, and nothing in `src/` depends on them. A team adopting
shipkit writes its own — `shipkit init` and `shipkit rules` propose a starting
point from what is actually in the repository and the forge.
