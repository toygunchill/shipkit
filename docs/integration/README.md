# Wiring shipkit into an agent

shipkit is a command-line tool, so integration is only ever "tell the agent to run
these commands instead of improvising". What differs between agents is *where the
instruction lives*, not what it says.

## The flow

```
1.  shipkit brief  --base <target>                  → facts, template, rules
2.  the agent writes response.json                  → title, commitMessage, sections
3.  shipkit submit --input response.json --base <target>
```

`brief` states the rules so the agent does not have to remember them. `submit`
refuses output that does not comply — it does not repair it, because a silent repair
hides the fact that the rules were ignored.

## The response the agent writes

`brief` does not yet describe this shape (see the deferred finding in the submit
plan), so the instruction file has to. Every key under `sections` must be one the
config declares, spelled exactly; an unrecognised one is refused rather than dropped,
so a typo surfaces as an error instead of losing the prose.

```json
{
  "title": "[ABC-31087] fix(invoice): default citizenship from passenger info",
  "commitMessage": "fix(invoice): default citizenship from passenger info\n\nOptional body.",
  "sections": {
    "Summary": "...",
    "Screenshots / Screen Recordings": "...",
    "What to Test": "- ...\n- ...\n- ...",
    "Issues Addressed": "- [ABC-31086](https://jira.example.com/browse/ABC-31086)"
  }
}
```

Use `###` for sub-headings inside a section. A `##` line is a section boundary as far
as any reader of the markdown is concerned — GitHub renders it as one — so shipkit
refuses it rather than letting the body silently split.

`response.json` may live in the repository. `submit` keeps it out of the commit.

## Where the instruction goes

| Agent | File |
|---|---|
| Claude Code, Claude CLI | `CLAUDE.md`, or a skill at `.claude/skills/open-pr/SKILL.md` |
| Codex | `AGENTS.md` |
| Copilot | `.github/copilot-instructions.md` |
| Antigravity | `AGENTS.md` is the common denominator; confirm against the version in use |

`AGENTS.md` is read by most agents and is the safest single place if you only want
one. Claude Code reads `CLAUDE.md`; a skill is better there, because it loads only
when a pull request is actually being opened rather than sitting in context all day.

Copy `CLAUDE.md.snippet` or `AGENTS.md.snippet` into the consuming repository, and
`claude-skill/SKILL.md` into `.claude/skills/open-pr/SKILL.md`.

## Where shipkit runs

shipkit runs **inside the repository you are opening the pull request for**, not in
its own. That repository already has the remote and the `gh` login; shipkit has no
remote and needs none. Everything it does — reading the branch, the commits, the open
pull request, then committing, pushing and opening — happens in the consuming
repository's checkout, as the current directory.

## Installing it

```bash
brew tap toygunchill/tools
brew trust toygunchill/tools
brew install shipkit
```

Then, in the repository you are opening the pull request for:

```bash
cd /path/to/your/checkout
shipkit init            # writes your conventions file from what your forge can prove
shipkit brief --base develop
```

`init` is not a one-time ceremony you can skip: **without a conventions file
shipkit does nothing**, because it holds no rules of its own. Every command that
reads your conventions stops and, at a terminal, offers to write one.

shipkit finds that file **by shape, not by name** — any YAML that parses as a
shipkit config — looking in `.`, `docs`, `docs/adr`, `.github`, `config` and
`.config`. Call it `pull-request-conventions.yml` if that is what your team calls
it; nothing has to be named after the tool that reads it. If two files both read
as a config, shipkit refuses and names them rather than picking one.

Every command takes `--repo <path>` if you would rather not stand in the
checkout, and `--config <path>` if the rules live somewhere else — a shared
conventions repository, say, which is the deployment `readiness:` resolves
symlinks for.

## Trying it without letting it act

`check` and `brief` only read. Run them against a branch you already have and see
what they say before `submit` is allowed anywhere near a commit:

```bash
cd /path/to/your/checkout

# What would shipkit say about a body you have already written?
shipkit check \
  --title "[ABC-31087] fix(invoice): default citizenship from passenger info" \
  --body-file /tmp/body.md

# What would it tell an agent about this branch?
shipkit brief --base develop

# And what does the change actually look like, with the findings on it?
shipkit review --base develop
```

None of them writes anything to your repository. `submit` is the only command that
commits, pushes or opens a pull request — and without `--yes` it stops at the first
warning having changed nothing. `tech-task` is the only other one that acts, and it
creates a Jira issue only when you run it by name.
