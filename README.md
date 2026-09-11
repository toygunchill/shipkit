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
shipkit submit   Validate, warn, then commit, push and open the pull request.
shipkit mcp      Serve the same three as MCP tools over stdio.
```

`check` is the one to run in CI. Instructions are advisory and an agent can
ignore them; CI cannot be ignored, and it is the layer that moves the number
above.

## What it refuses

Eight rules: the title's format, missing or empty sections, too few items under
*What to Test*, the template's own boilerplate left in place, no issue key
cited, a branch name the ruleset would reject, and a Jira key cited at the wrong
level — a Development sub-task where the parent Story belongs.

## What it warns about

Six pre-flight checks, each for a failure that actually happened while the tool
was being designed: a push that will dismiss existing approvals; a branch
carrying another ticket's commits; a base that disagrees with the open pull
request; a label that blocks the merge gate; a cited issue that could not be
verified; and untracked files that staging would sweep into the commit.

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
is a working one, reconstructed from a real team's rules.

There is no `shipkit init` yet, so it is written by hand.
