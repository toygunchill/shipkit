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
shipkit check      Validate a title and body against your conventions. No side effects.
shipkit brief      Emit the JSON brief an agent fills in.
shipkit review     Show the change and the findings on a local page, and take one answer.
shipkit submit     Validate, warn, then commit, push and open the pull request.
shipkit init       Write a starter conventions file, reading what the forge can prove.
shipkit rules      Propose a readiness checklist from the code, for a repo that has none.
shipkit tech-task  Open the technical item for work the ticket did not ask for.
shipkit pr-review  Review a pull request that is already open, and post the remarks.
shipkit reviewer   Draft a reviewer for this repository, from the rules it carries.
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

## shipkit holds no rules of its own

This is the thing to understand before anything else. shipkit does not know what a good
pull-request title looks like, which sections a body needs, which branch names your team
allows, or which Jira level to link. It knows *how to check* those things against values
you supply.

Those values live in your repository, in two files:

| | What it holds |
|---|---|
| a conventions file | the title pattern, the body's sections, the branch pattern, the Jira level, which labels block a merge, who answers a warning |
| a readiness checklist (optional) | the questions worth asking before a change is ready — the ones your own reviews keep asking |

**Without the first, shipkit does nothing.** Every command that reads your conventions —
`check`, `brief`, `review`, `submit`, `tech-task` — stops, and at a terminal offers to
write one.

That separation is deliberate. A tool carrying one team's conventions is a tool the next
team has to fork. It also means changing your mind is a pull request in *your* repository,
not a release of somebody else's software.

### Name it whatever you call it

shipkit finds the conventions file **by shape, not by name**: any YAML that parses as a
shipkit config is one. `.shipkit.yml` still works and is tried first, but
`pull-request-conventions.yml` is a better name for what the file actually holds — it is
your team's decision, not this tool's, and it should not be named after whatever reads it
today.

It looks in `.`, `docs`, `docs/adr`, `.github`, `config` and `.config` — a bounded list
rather than a walk of your repository, so nothing is read that nobody offered. Anywhere
else, pass `--config`.

If two files both read as a config, shipkit refuses and names them. Two answers to "what
are this repository's conventions" is not something to settle by which filename sorts
first.

Where the files sit is up to you. `init` writes them side by side and points the first at
the second; a repository keeping its conventions beside its architecture decisions can put
them anywhere, because `readiness:` is resolved against the *realpath* of the config it was
loaded from — a symbolic link works.

## Getting started

### 1. Install it

```bash
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

#### Upgrading the menu-bar app: quit it first

```bash
pkill -f ShipkitMenuBar
brew upgrade shipkit-menubar
open $(brew --prefix shipkit-menubar)/shipkit.app
```

`brew upgrade` replaces the files; it does not stop what is already running, and
nothing restarts the app afterwards. Skip the first line and the old build stays
up — two icons in the menu bar, and only one of them is the version you just
installed.

That is worse than cosmetic. Every running instance binds the same socket path,
but only one of them can be the listener. The icon you click may belong to a
build that is no longer receiving anything, so a `submit` waiting under
`pr.approval: human` sits there unanswered while a panel is open in front of
you. If the menu bar ever shows more than one mark, `pkill -f ShipkitMenuBar`
and open the app again — that is the whole fix.

shipkit runs **inside the repository you are opening the pull request for**, not
in its own. That repository already has the remote and the `gh` login; shipkit
needs neither of its own.

### 2. Teach it your conventions

```bash
cd /path/to/your/checkout
shipkit init
```

`init` sets up both halves and writes nothing you have to wire together yourself.

It reads what your forge can actually prove — the merged pull requests, the branch
ruleset, the merge gate — and writes a starter conventions file with a label on every
value saying where it came from: `read` is a fact, `observed` is a pattern in what people did
(not the same as what they intended), `proposed` is shipkit's guess and yours to overrule.
Read it before you trust it. It never opts you into anything: `pr.approval` defaults to
`echo`.

Then it proposes a readiness checklist from your code, writes it beside the config, and
points `readiness:` at it. That half selects; it does not invent — only rules whose subject
is actually in your repository, with the evidence above each line, everything at `advise`
so nothing starts gating anyone's work before a person has read it. If nothing in your
repository matches the catalogue, `init` says so rather than writing an empty file.

`shipkit rules` does that second half on its own, if you want to redo it later.

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

Name the installed command, as above, rather than a path into a checkout. Pointing an agent
at `node /path/to/shipkit/dist/cli.js mcp` works and then quietly stops being true: the
agent runs whatever was last built there, so a `brew upgrade` changes nothing for it and a
forgotten `npm run build` leaves it on old code with no sign that anything is stale.

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

## Reviewing a pull request that is already open

Everything above happens before a pull request exists. `pr-review` is the other end: read
an open pull request — yours or somebody else's — judge it against the rules the
repository already carries, and post what survives.

```bash
shipkit pr-review brief --pr 943 --repo-slug acme/widget > brief.json
# the agent reads brief.json and writes remarks.json
shipkit pr-review post  --pr 943 --repo-slug acme/widget --remarks remarks.json
```

The agent writes the review, as it writes everything else here. shipkit supplies what it
cannot know — the diff, the rules, and the exact positions a comment is allowed to land
on — and refuses an answer that does not hold up.

**Every remark must cite a rule.** An agent asked to review a diff will always find
something to say, and a review of fifteen remarks where four matter teaches its reader to
skim. A remark citing an id the repository does not have is refused and reported, which is
also the only defence against an agent inventing a plausible-looking one rather than
staying silent. The output improves when your team writes more rules down — not when
somebody tunes a prompt.

**Anchors are computed before the agent is asked anything.** GitHub refuses a comment on a
line outside the diff, with a 422, after the review is assembled and sent — the worst
moment to fail. So the commentable positions are derived from the diff up front, handed to
the agent as the ones it may use, and checked again before anything is posted. An anchor
outside the set is refused rather than moved to a nearby line: a comment pointing at the
wrong line is worse than one that was never written. A remark belonging to no single line
becomes a comment on the pull request, and the editor says so rather than pinning it
somewhere arbitrary.

**It uses your repository's own reviewer.** A team that has written down how changes here
are reviewed has already done the specific part, and shipkit carries that text into the
brief rather than letting the agent fall back on whatever review habit it arrived with —
which varies by agent, by day, and by how the question was phrased. It looks for a Claude
Code subagent under `.claude/agents/`, a command under `.claude/commands/`, a Copilot prompt
under `.github/prompts/`, or a Codex prompt under `.codex/prompts/`, reading whichever
exists from the same ref as the rules. The instructions are inlined, not named: the agent
may be standing in a checkout that does not carry the file, and a path it has to go and
find is one it can fail to find without saying so.

If your repository defines none, shipkit says so and asks for one — and offers to write it:

```bash
shipkit reviewer            # print the drafts, touch nothing
shipkit reviewer --write    # put them in the repository
```

The rules *are* the reviewer, so there is nothing to invent: what comes out lists the rules
the repository already carries, requires a rule id on every finding, and is read-only. One
file per agent your team might use, all saying the same thing — a repository whose Claude
reviewer and Copilot reviewer disagree has two rulesets pretending to be one, and nobody
finds out until two people get different answers about the same line. An existing reviewer
is never overwritten without `--force`: it is a document a team argued about.

`post` opens an editor before anything is published. The remarks are drawn on the lines
they are about, nothing is ticked when it opens, and each one can be rewritten or given
your own words — which are appended under the remark rather than blended into it, so a
reader can tell which sentence a human wrote. `--dry-run` goes through the same editor and
prints the payload instead of posting it. `--yes` skips the editor entirely.

Everything ticked goes out as **one review**, because N comments would be N notifications
to someone whose afternoon this is interrupting. Publishing is immediate, so the button
names the pull request, whose it is, and how many comments — a control saying "Send" would
be the wrong size for what it does.

### Starting one from the menu bar

The inbox draws a magnifying glass beside every pull request. Pressing it asks for that one
to be reviewed. The row itself still opens the pull request in a browser: asking for a
review is a different thing and must not be reachable by aiming at the title and missing.

What happens next depends on something worth understanding, because it decides what the
button can honestly promise.

**The menu bar cannot review anything.** It holds no agent, and MCP is request/response — a
server cannot hand work to an agent that did not ask for it. That is the protocol, not an
omission. What the application *can* know is whether an agent exists: `shipkit mcp` runs as
a child of the agent for exactly as long as the agent does, so it holds one connection open,
and that connection is the answer. No heartbeat, nothing to expire.

So the button does one of two things, and says which:

- **An agent is running.** The request is saved, and you ask your agent to pick it up — it
  will not hear about it on its own. It finds the request through `shipkit_pending_review`.
- **No agent is running.** It says so and offers a terminal, opened empty. Which command
  starts your agent is not something shipkit can know, and the request waits until you do.

The request replaces any earlier one rather than queueing. A queue means a press answered
minutes later on a pull request you have stopped thinking about — and what is being asked
for ends in comments published under your name.

Without a menu-bar application at all, `shipkit pr-review brief --pr <n> --repo-slug <slug>`
is the whole of it; nothing above is required.

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

One YAML file, named whatever your team calls it and living in any of the
directories listed under [Name it whatever you call it](#name-it-whatever-you-call-it)
— or anywhere at all, with `--config`. `docs/examples/example.shipkit.yml` is a
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
