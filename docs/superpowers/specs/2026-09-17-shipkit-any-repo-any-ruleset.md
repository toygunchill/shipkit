# shipkit — any repository, any ruleset

**Date:** 2026-09-17
**Status:** Approved design

## Problem

shipkit is installed once and used everywhere. Today it is neither: every command reads
`process.cwd()`, and the readiness checklist is a single path named inside one repository's
`.shipkit.yml`. A developer who installs it with Homebrew and wants to run it against a
checkout they are not standing in, or against a ruleset other than the one that repository
happens to name, cannot.

Three things follow from "installed once, used everywhere":

1. **Any repository.** The repository is an argument, not the process's working directory.
2. **Any ruleset.** Which checklist applies is a decision at the point of use, not a
   property baked into one repository's config.
3. **No ruleset.** A repository that has never configured one should not silently get no
   checklist at all. shipkit should be able to propose one from the code in front of it.

## Decisions

| Decision | Choice | Reason |
|---|---|---|
| How is a repository named? | `--repo <path>`, default `.` | One option, every command, same spelling as the MCP tools already use. |
| How is `--config` resolved? | Relative paths against `--repo`; absolute as given | `shipkit brief --repo ../other` must read *that* repository's config, not one beside the shell. This is exactly what `configPath` in the MCP surface already does, so the function moves and both callers share it. |
| How is a ruleset named? | `--rules <path>`, repeatable | A person running against someone else's repository needs to say which checklist they mean. |
| Does `--rules` merge with `readiness:`? | **No — it replaces it.** | A merge makes "run only this ruleset" unexpressible, and the whole point of the flag is to answer *which* checklist. Replacement is also the only behaviour that reads the same whether or not the target repository has a config at all. |
| May several rulesets apply at once? | Yes: `--rules` repeats, and `readiness:` takes a list | A team ruleset plus a platform ruleset is the real case. |
| Two files, one rule id? | **Refuse**, naming both files | Already refused within one file, for a reason that does not weaken across files: the second rule is unreachable by any answer. Silently taking the first would make which file wins depend on argument order. |
| What if nothing names a ruleset? | `shipkit rules` proposes one from the code | See below. Never applied silently. |

## Deriving a ruleset from the code

The measured checklist in `docs/examples/example-app.readiness.yml` was extracted by reading
one team's code and its review comments. That is not a thing a command can do. What a command
*can* do honestly is decide, for each rule in a catalogue shipkit ships, whether its subject
exists in this repository at all — and say what it measured.

So `shipkit rules` selects; it does not invent. Each catalogue entry carries a detector over
the repository's tracked files, and an entry is proposed only when its detector finds its
subject, with the evidence written into the file beside it:

```yaml
# observed: 412 files use async/await, actor or @MainActor
- id: concurrency
  severity: advise
```

A rule whose subject is absent is omitted entirely rather than emitted disabled. A checklist
listing questions about things this repository does not have is a checklist people learn to
skip, and this project has already paid for that lesson twice — `issue-unverified` firing on
every run, and `forbidden` banning `N/A`.

**Everything derived is `advise`.** `advise` never gates and never changes an exit code, so a
proposal cannot block anyone's push before a person has read it. `init` makes the same choice
for the same reason, defaulting `pr.approval` to `echo` rather than opting a team into `human`
silently. Raising a rule to `warn` or `block` stays a decision a team makes in writing.

**What a linter already enforces is not proposed.** The measured checklist's governing rule
was that nothing SwiftLint or Sonar already catches appears in it, because a checklist that
repeats the linter trains people to answer without reading. When a linter's configuration is
present, `shipkit rules` says which topics it saw covered and leaves them out.

### The command

```
shipkit rules --repo <path> [--out <file>]
```

Writes to stdout by default, so it composes; `--out` writes a file and refuses to overwrite
one. It creates nothing else, changes no config, and — like `init` — the file it produces is a
draft with provenance on every line, meant to be read and edited before anything points at it.

## Out of scope

- Inferring `severity` from anything. Severity is a team's decision about consequence.
- Reading review comments or a forge. `init` does that for PR conventions; a checklist
  derived from comments needs the reading `docs/examples` records, not a heuristic.
- Fetching a ruleset over the network. `--rules` takes a path; a shared ruleset is deployed
  as a checkout and a symbolic link, which `readinessPath` already resolves.
