# shipkit over MCP — Design

**Date:** 2026-09-11
**Status:** Approved design, pending implementation plan
**Builds on:** `docs/superpowers/specs/2026-09-10-shipkit-design.md`

## Problem

shipkit works. Nothing reaches for it.

A command-line tool sitting on `PATH` is invisible to a coding agent. Something has to
tell the agent that this repository has conventions and that shipkit enforces them,
and today that something is a block of prose copied into `CLAUDE.md`, `AGENTS.md`, or
`.github/copilot-instructions.md` — once per repository, per agent, by hand. The
instruction files in `docs/integration/` exist because of this, and they are the
weakest part of the product: they must be maintained in every consuming repository,
they drift, and an agent is free to ignore them.

The original goal was "install it once, and every agent can use it". A global install
does not achieve that, because a global install writes nothing into any repository.

MCP does. A registered server's tools appear in the agent's tool list with their
descriptions, from one registration per agent per machine. The instruction stops
being prose someone remembered to copy and becomes part of the agent's tool surface.

## Goals

- One registration per agent per machine makes shipkit reachable in every repository.
- The acting tool cannot run on a reflex. Preview and apply are separate, and apply
  refuses until the warnings it would produce have been seen.
- No duplicated logic. The MCP handlers and the CLI call the same functions.
- The CLI keeps working unchanged.

## Non-goals

- **Replacing the CLI.** MCP exists only inside an agent session. `shipkit check` in
  CI is the only layer an agent cannot skip, and CI has no MCP.
- **Carrying the rules.** MCP puts the *tool* everywhere; `.shipkit.yml` still has to
  live in the consuming repository. `init` remains necessary and is out of scope here.
- **A remote server.** stdio only. The agent spawns `shipkit mcp` as a child process
  and talks over stdin/stdout. Nothing listens on a port. An HTTP transport would need
  authentication and would still need local `git`, so it buys nothing.
- **Packaging.** The Homebrew tap is separate work, and pointless before this exists.
- **Writing the prose.** Unchanged from the base design, and restated below because it
  is the question this design is most likely to be misread on.

## Who produces the title, the commit message, and the prose

The agent. shipkit generates none of it.

This is the base design's central decision and it does not change here. The agent
already holds the full context of the change; a second LLM call would cost money and
lose that context. shipkit supplies knowledge — the facts, the template, the rules —
and enforcement. It accepts the agent's answer only if it validates, and refuses
rather than repairs, because a silent repair hides that the rules were ignored.

Under MCP the division is the same, only the transport differs: the brief becomes a
tool result instead of a file, and the answer becomes tool arguments instead of
`response.json`.

**One gap, stated plainly.** `commitMessage` is validated only as a non-empty string.
There is no `commitPattern` in the config and no rule in `validate` that reads it, so
the base design's first goal — "produce a compliant commit message" — has nothing
behind it. That is a real hole, it is independent of MCP, and it is not fixed here.

## Surface

```
shipkit mcp        Serve the tools over stdio. Blocks until the parent closes it.
```

Three tools. Every one takes `repo` explicitly.

### `shipkit_brief`

```
repo: string          absolute path to the repository
base: string          target branch
config?: string       path to .shipkit.yml, default <repo>/.shipkit.yml
```

Returns the brief: the change, the resolved target, the sections to fill with a hint
for each, and the rules the answer must satisfy. Reads only.

Unlike the CLI's `brief`, this never prompts for a missing base. A tool call is not a
terminal; `base` is required and a missing one is an error naming the plausible
targets, which is the same contract the CLI already applies when stdin is not a tty.

### `shipkit_preview`

```
repo, base, config?
title: string
commitMessage: string
sections: Record<string, string>
```

Returns three things and changes nothing:

- `findings` — validation failures, each with its rule id and message.
- `warnings` — pre-flight warnings, each with its check id and message.
- `body` — the rendered pull-request body, exactly as it would be posted.

`body` is there so the agent can see what it is about to publish rather than trusting
that its sections were assembled the way it imagined.

### `shipkit_apply`

```
repo, base, config?, title, commitMessage, sections
acknowledge?: string[]    check ids of the warnings the caller has seen
```

Re-runs validation and pre-flight from scratch. It never assumes `shipkit_preview`
was called; nothing forces it to have been.

- Any validation finding: refuse, return the findings, change nothing.
- Warnings whose ids are not all present in `acknowledge`: refuse, return the
  warnings, change nothing.
- Otherwise: commit, push, and open or update the pull request. Returns the URL.

### Why the acknowledgement echoes ids

A boolean gate does not survive contact with an agent. `yes: true` is one more field
to fill in, and a model that has decided to proceed will fill it in without having
read anything.

Echoing the ids costs the agent nothing it should not already have done, and buys two
properties a boolean cannot. The caller must have received the warnings to name them.
And the set is checked against what pre-flight produces *now*, so if the situation
changed between the two calls — a review landed, a label was added — the ids no
longer match and the gate closes again.

This matters more under MCP than on the command line. `shipkit submit --yes` is typed
by a person who saw the warnings scroll past. A tool call is not.

## What MCP removes

The response file disappears. The agent passes `sections` as an argument, so there is
no `response.json` on disk — and with it goes the entire apparatus built to stop that
file from being committed: the staging pathspec exclusion, the `literal`/`top` magic,
the realpath normalisation for symlinked checkouts, the out-of-repo path handling.
None of it runs on the MCP path.

It all stays for the CLI, which still reads a file. `runSubmit` therefore takes the
response as an object plus an *optional* path; MCP passes no path, and the exclusion
logic is skipped rather than fed a value it has to special-case.

## What MCP requires

**`cwd` must reach the adapters.** `src/vcs/git.ts` already threads `cwd` through
every call. `src/vcs/github.ts` and `src/vcs/mutate.ts` do not — `gh`, `git commit`
and `git push` all rely on `process.cwd()`.

For the CLI that is correct: the user changed directory before running it. For a
server the agent spawned, the working directory is whatever the agent chose, which
may be a different worktree or a parent directory. Every adapter must take `cwd`, and
the MCP handlers pass `repo`.

This is a correctness fix in its own right, not MCP scaffolding. A CLI invoked
through a wrapper that does not `cd` has the same bug today.

## Architecture

The MCP layer is a transport. It contains no rules, no validation, and no git.

```
                 ┌── src/cli.ts ────────────┐
                 │  parses argv, reads the  │
                 │  response file, prints   │
                 └───────────┬──────────────┘
                             │
  ┌── src/mcp/server.ts ──┐  │     ┌─────────────────────────────┐
  │  tool schemas, stdio, ├──┴────▶│ runSubmit / assembleBrief / │
  │  result shaping       │        │ validate / preflight        │
  └───────────────────────┘        └─────────────┬───────────────┘
                                                 │
                                   ┌─────────────▼───────────────┐
                                   │ vcs, jira — the only I/O    │
                                   └─────────────────────────────┘
```

`runSubmit(options, deps)` already returns an exit code and writes through injected
sinks rather than `console`. That shape was chosen so the mutating sequence could be
driven by fakes in tests; it makes a second caller almost free. The MCP handler
collects the sink output instead of printing it, and maps the exit code to a tool
result.

Splitting preview from apply needs one change in the core: the sequence currently
validates, warns, and acts in one pass. It gains a mode that stops after warning and
reports, which `shipkit_preview` uses and `shipkit apply` does not — the same
function, one flag, so the two paths cannot drift.

## Module layout

| File | Responsibility |
|---|---|
| `src/mcp/server.ts` | Construct the server, register the three tools, serve over stdio |
| `src/mcp/tools.ts` | Tool schemas and the handlers that map arguments to core calls |
| `src/mcp/result.ts` | Shape a core result into a tool result; render errors as data, not exceptions |

Errors reach the agent as structured content, not as protocol faults. A validation
failure is an answer to the question the agent asked, not a malfunction — and an
agent that receives a fault learns nothing it can act on.

## Testing

- Tool handlers are tested against fake deps, exactly as `runSubmit` already is. No
  test starts a server, spawns `git`, or calls `gh`.
- One test per refusal: a finding refuses, an unacknowledged warning refuses, a stale
  acknowledgement refuses, and each asserts that no mutating dep was called.
- The stale-acknowledgement case is the one that matters: acknowledge the ids from a
  first call, change the pre-flight facts, and assert the second call still refuses.
- `shipkit_preview` and `shipkit_apply` are checked against the same inputs to
  confirm they agree on findings and warnings — a preview that disagrees with what
  apply will do is worse than no preview.
- One end-to-end test drives a scratch repository through `brief → preview → apply`
  with a local bare remote, covering everything except `gh pr create`.

## Registration

One line per agent, per machine. Exact syntax is verified against the installed
version at wiring time rather than written from memory here.

- **Claude Code / Claude CLI** — `claude mcp add --scope user shipkit -- shipkit mcp`
- **Codex** — an `mcp_servers` entry in `~/.codex/config.toml`
- **Copilot** — MCP configuration in the editor's settings
- **Antigravity** — to be confirmed against the version in use

`docs/integration/` stays for agents without MCP and shrinks to that role.

## Open questions

- **Progress and long calls.** Jira resolution and `gh` add latency to `apply`. MCP
  has a progress mechanism; whether it is worth using is unknown until the latency is
  measured against a real repository.
- **Multi-repo sessions.** `repo` is a required argument, so nothing breaks, but an
  agent working across two checkouts must pass the right one every time. Whether that
  wants a guard is a question for after it has been used.
