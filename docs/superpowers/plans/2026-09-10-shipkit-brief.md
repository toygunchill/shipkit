# shipkit `brief` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an agent everything it needs to write a compliant pull request — the change, the ticket, the target branch, the template and the rules — as one JSON brief, and complete the validation gate with the two rules Plan 1 deferred.

**Architecture:** Three thin adapters read the outside world (`git`, the `gh` CLI, the Jira REST API). Everything they learn is reduced to plain data and handed to pure functions, so `validate` stays synchronous and testable with plain objects. `brief` composes the adapters' output into the JSON contract; the adapters are the only code in this slice that performs I/O.

**Tech Stack:** Node 25, TypeScript, `commander`, `zod`, `yaml`, `vitest`. External binaries: `git`, `gh`. External service: Jira REST API v2.

**Spec:** `docs/superpowers/specs/2026-09-10-shipkit-design.md`
**Plan 1 (merged):** `docs/superpowers/plans/2026-09-10-shipkit-check.md`
**Reference examples:** `docs/examples/example-app-pr-bodies.md`, `docs/examples/example-app.shipkit.yml`

## Global Constraints

- ESM only. Relative imports inside `src/` carry the `.js` extension.
- TypeScript `strict: true`. No `any` in committed code.
- Exit codes: `0` clean, `1` findings, `2` usage or configuration error.
- Findings print one per line as `<rule>: <message>`.
- Existing rule ids are unchanged: `title-pattern`, `section-missing`, `section-empty`, `section-min-items`, `forbidden-text`, `issue-key-missing`. This plan adds exactly two: `branch-pattern`, `issue-level`.
- `validate()` stays **pure and synchronous**. Facts gathered by adapters are passed in; `validate` never performs I/O.
- Adapters shell out with `execFileSync` and an explicit argument array — never a shell string, so no argument is ever interpolated into a shell.
- The Jira token is read from the `SHIPKIT_JIRA_TOKEN` environment variable. It is never logged, never written to a file, and never included in the brief.

## Scope

Delivered: `shipkit brief`, plus `branch-pattern` and `issue-level` enforced by `shipkit check`.

Deferred to the next plan: `submit`, the pre-flight checks, `init`, and `branch`. Everything in this slice is **read-only** — no command here creates a commit, pushes, or opens a pull request.

## File Structure

| File | Responsibility |
|---|---|
| `src/vcs/git.ts` | Local repository facts: branch, changed files, diffstat, commit subjects |
| `src/vcs/github.ts` | Forge facts via `gh`: default branch and candidate base branches |
| `src/vcs/types.ts` | `RepoState`, `VcsError` |
| `src/jira/client.ts` | Fetch one issue and its parent; `JiraError` |
| `src/jira/types.ts` | `IssueFacts` |
| `src/validate/rules.ts` | Extended with the two new rules |
| `src/brief/assemble.ts` | Pure: facts in, brief object out |
| `src/brief/types.ts` | `Brief` |
| `src/cli.ts` | Adds the `brief` command; `check` gains the new facts |
| `tests/**` | One test file per module |

---

### Task 1: Git adapter

**Files:**
- Create: `src/vcs/types.ts`
- Create: `src/vcs/git.ts`
- Test: `tests/vcs/git.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `class VcsError extends Error`
  - `type RepoState = { branch: string; changedFiles: string[]; diffstat: string; commits: string[] }`
  - Note: `PullRequestState` and `findPullRequest` are deliberately NOT built here. Nothing in this slice reads a pull request — pre-flight does, in the next plan, and it can add them to the same files then.
  - `function readRepoState(base: string, cwd?: string): RepoState` — `base` is the branch to diff against. Throws `VcsError` when a git command fails.

- [ ] **Step 1: Write the failing test**

`tests/vcs/git.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { readRepoState, VcsError } from "../../src/vcs/git.js";

let repo: string;

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "shipkit-git-"));
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "base"], repo);
  git(["checkout", "-q", "-b", "feature/x"], repo);
  writeFileSync(join(repo, "a.txt"), "two\n");
  writeFileSync(join(repo, "b.txt"), "new\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "feat: add b and change a"], repo);
});

describe("readRepoState", () => {
  it("reports the current branch", () => {
    expect(readRepoState("main", repo).branch).toBe("feature/x");
  });

  it("lists files changed against the base", () => {
    expect(readRepoState("main", repo).changedFiles.sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("returns a diffstat mentioning both files", () => {
    const stat = readRepoState("main", repo).diffstat;
    expect(stat).toContain("a.txt");
    expect(stat).toContain("b.txt");
  });

  it("lists commit subjects not on the base", () => {
    expect(readRepoState("main", repo).commits).toEqual(["feat: add b and change a"]);
  });

  it("throws VcsError for an unknown base", () => {
    expect(() => readRepoState("no-such-branch", repo)).toThrow(VcsError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vcs/git.test.ts`
Expected: FAIL — cannot resolve `../../src/vcs/git.js`.

- [ ] **Step 3: Write the implementation**

`src/vcs/types.ts`:

```ts
export class VcsError extends Error {}

export type RepoState = {
  branch: string;
  changedFiles: string[];
  diffstat: string;
  commits: string[];
};

```

`src/vcs/git.ts`:

```ts
import { execFileSync } from "node:child_process";
import { VcsError, type RepoState } from "./types.js";

export { VcsError };
export type { RepoState };

function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr ?? (error as Error).message;
    throw new VcsError(`git ${args.join(" ")} failed: ${String(detail).trim()}`);
  }
}

export function readRepoState(base: string, cwd: string = process.cwd()): RepoState {
  const range = `${base}...HEAD`;
  return {
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"], cwd).trim(),
    changedFiles: git(["diff", "--name-only", range], cwd).split("\n").filter(Boolean),
    diffstat: git(["diff", "--stat", range], cwd).trim(),
    commits: git(["log", "--format=%s", range], cwd).split("\n").filter(Boolean),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/vcs/git.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/vcs tests/vcs
git commit -m "feat(vcs): read local repository state"
```

---

### Task 2: GitHub adapter

**Files:**
- Create: `src/vcs/github.ts`
- Test: `tests/vcs/github.test.ts`

**Interfaces:**
- Consumes: `VcsError` from `src/vcs/types.js` (Task 1).
- Produces:
  - `type GhRunner = (args: string[]) => string` — the seam the tests replace.
  - `function defaultBranch(run?: GhRunner): string`
  - `function baseCandidates(run?: GhRunner): string[]` — the default branch first, then any `release/*` branches, deduplicated.
  - Both throw `VcsError` when `gh` fails.

The default runner executes `gh` with `execFileSync`. Injecting `run` keeps every test offline.

- [ ] **Step 1: Write the failing test**

`tests/vcs/github.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { baseCandidates, defaultBranch } from "../../src/vcs/github.js";

const fake = (replies: Record<string, string>) => (args: string[]): string => {
  const key = args.join(" ");
  const match = Object.keys(replies).find((k) => key.includes(k));
  if (!match) throw new Error(`unexpected gh call: ${key}`);
  return replies[match];
};

describe("defaultBranch", () => {
  it("reads the repository default", () => {
    const run = fake({ "defaultBranchRef": JSON.stringify({ defaultBranchRef: { name: "develop" } }) });
    expect(defaultBranch(run)).toBe("develop");
  });
});

describe("baseCandidates", () => {
  it("puts the default branch first and adds release branches", () => {
    const run = fake({
      "defaultBranchRef": JSON.stringify({ defaultBranchRef: { name: "develop" } }),
      "api repos": JSON.stringify([
        { name: "release/3.75.0" },
        { name: "release/3.76.0" },
        { name: "develop" },
      ]),
    });
    expect(baseCandidates(run)).toEqual(["develop", "release/3.75.0", "release/3.76.0"]);
  });
});

```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vcs/github.test.ts`
Expected: FAIL — cannot resolve `../../src/vcs/github.js`.

- [ ] **Step 3: Write the implementation**

`src/vcs/github.ts`:

```ts
import { execFileSync } from "node:child_process";
import { VcsError } from "./types.js";

export type GhRunner = (args: string[]) => string;

const defaultRunner: GhRunner = (args) => {
  try {
    return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr ?? (error as Error).message;
    throw new VcsError(`gh ${args.join(" ")} failed: ${String(detail).trim()}`);
  }
};

function call<T>(run: GhRunner, args: string[]): T {
  let raw: string;
  try {
    raw = run(args);
  } catch (error) {
    if (error instanceof VcsError) throw error;
    throw new VcsError(`gh ${args.join(" ")} failed: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new VcsError(`gh ${args.join(" ")} returned unparseable JSON`);
  }
}

export function defaultBranch(run: GhRunner = defaultRunner): string {
  const data = call<{ defaultBranchRef: { name: string } }>(
    run,
    ["repo", "view", "--json", "defaultBranchRef"],
  );
  return data.defaultBranchRef.name;
}

export function baseCandidates(run: GhRunner = defaultRunner): string[] {
  const fallback = defaultBranch(run);
  const branches = call<{ name: string }[]>(
    run,
    ["api", "repos/{owner}/{repo}/branches", "--paginate", "--jq", "[.[] | {name}]"],
  );
  const releases = branches
    .map((b) => b.name)
    .filter((name) => name.startsWith("release/"))
    .sort();
  return [fallback, ...releases.filter((name) => name !== fallback)];
}

```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/vcs/github.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/vcs/github.ts tests/vcs/github.test.ts
git commit -m "feat(vcs): read forge state through gh"
```

---

### Task 3: Jira adapter

**Files:**
- Create: `src/jira/types.ts`
- Create: `src/jira/client.ts`
- Test: `tests/jira/client.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `class JiraError extends Error`
  - `type IssueFacts = { key: string; type: string; summary: string; parent?: { key: string; type: string; summary: string } }`
  - `type Fetcher = (url: string, token: string) => Promise<unknown>` — the seam the tests replace.
  - `async function fetchIssue(baseUrl: string, key: string, token: string, fetcher?: Fetcher): Promise<IssueFacts>`
  - The token is passed as a bearer header by the default fetcher and never appears in any thrown message.

- [ ] **Step 1: Write the failing test**

`tests/jira/client.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fetchIssue, JiraError } from "../../src/jira/client.js";

const BASE = "https://jira.example.com";

const payload = (over: Record<string, unknown> = {}) => ({
  key: "ABC-31454",
  fields: {
    summary: "Geliştirme",
    issuetype: { name: "Development" },
    parent: {
      key: "ABC-31444",
      fields: { summary: "Brand Identity fields", issuetype: { name: "Story" } },
    },
    ...over,
  },
});

describe("fetchIssue", () => {
  it("maps the issue and its parent", async () => {
    const issue = await fetchIssue(BASE, "ABC-31454", "tok", async () => payload());
    expect(issue).toEqual({
      key: "ABC-31454",
      type: "Development",
      summary: "Geliştirme",
      parent: { key: "ABC-31444", type: "Story", summary: "Brand Identity fields" },
    });
  });

  it("omits parent when the issue has none", async () => {
    const issue = await fetchIssue(BASE, "ABC-31789", "tok", async () =>
      payload({ parent: undefined }),
    );
    expect(issue.parent).toBeUndefined();
  });

  it("sends the token as a bearer header", async () => {
    let seen = "";
    await fetchIssue(BASE, "ABC-1", "secret", async (_url, token) => {
      seen = token;
      return payload();
    });
    expect(seen).toBe("secret");
  });

  it("throws JiraError when the payload is not an issue", async () => {
    await expect(fetchIssue(BASE, "ABC-1", "tok", async () => ({ errorMessages: ["nope"] })))
      .rejects.toThrow(JiraError);
  });

  it("never puts the token in the error message", async () => {
    const failing = async () => { throw new Error("boom"); };
    await expect(fetchIssue(BASE, "ABC-1", "s3cr3t", failing)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("s3cr3t") }) as Error,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/jira/client.test.ts`
Expected: FAIL — cannot resolve `../../src/jira/client.js`.

- [ ] **Step 3: Write the implementation**

`src/jira/types.ts`:

```ts
export class JiraError extends Error {}

export type IssueRef = {
  key: string;
  type: string;
  summary: string;
};

export type IssueFacts = IssueRef & {
  parent?: IssueRef;
};
```

`src/jira/client.ts`:

```ts
import { JiraError, type IssueFacts, type IssueRef } from "./types.js";

export { JiraError };
export type { IssueFacts, IssueRef };

export type Fetcher = (url: string, token: string) => Promise<unknown>;

const defaultFetcher: Fetcher = async (url, token) => {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!response.ok) {
    throw new JiraError(`Jira responded ${response.status} for ${url}`);
  }
  return response.json();
};

type RawIssue = {
  key?: string;
  fields?: {
    summary?: string;
    issuetype?: { name?: string };
    parent?: { key?: string; fields?: { summary?: string; issuetype?: { name?: string } } };
  };
};

function toRef(key: string | undefined, type: string | undefined, summary: string | undefined): IssueRef {
  if (key === undefined || type === undefined) {
    throw new JiraError("Jira issue is missing its key or type");
  }
  return { key, type, summary: summary ?? "" };
}

export async function fetchIssue(
  baseUrl: string,
  key: string,
  token: string,
  fetcher: Fetcher = defaultFetcher,
): Promise<IssueFacts> {
  const url = `${baseUrl.replace(/\/$/, "")}/rest/api/2/issue/${encodeURIComponent(key)}`;

  let raw: unknown;
  try {
    raw = await fetcher(url, token);
  } catch (error) {
    if (error instanceof JiraError) throw error;
    throw new JiraError(`Cannot reach Jira for ${key}: ${(error as Error).message}`);
  }

  const issue = raw as RawIssue;
  if (issue.key === undefined || issue.fields === undefined) {
    throw new JiraError(`Jira returned no issue for ${key}`);
  }

  const facts: IssueFacts = toRef(issue.key, issue.fields.issuetype?.name, issue.fields.summary);
  const parent = issue.fields.parent;
  if (parent !== undefined) {
    return {
      ...facts,
      parent: toRef(parent.key, parent.fields?.issuetype?.name, parent.fields?.summary),
    };
  }
  return facts;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/jira/client.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/jira tests/jira
git commit -m "feat(jira): fetch an issue and its parent"
```

---

### Task 4: The two deferred rules

**Files:**
- Modify: `src/validate/rules.ts`
- Test: `tests/validate/rules.test.ts`

**Interfaces:**
- Consumes: `IssueFacts` from `src/jira/types.js` (Task 3); the existing `validate` from Plan 1.
- Produces: `ValidateInput` gains two optional fields, so every existing caller keeps working unchanged:
  - `branch?: string` — when present, checked against `config.branch.pattern`, emitting `branch-pattern`.
  - `issues?: IssueFacts[]` — facts for the keys cited in the issues section. When `config.jira.linkPolicy` is `"story"`, any cited issue whose own type is not Story or Bug **and** which has a parent emits `issue-level`, naming the parent to cite instead. An issue with no parent is accepted as-is, because it is already at the top of its own chain.
- The two new rule ids are exactly `branch-pattern` and `issue-level`.

- [ ] **Step 1: Write the failing test**

Append to `tests/validate/rules.test.ts`:

```ts
describe("branch-pattern", () => {
  it("accepts a branch matching the configured pattern", () => {
    const result = validate({
      title: TITLE, body: goodBody, config,
      branch: "bugfix/squadb/31087-invoice-default-citizenship",
    });
    expect(result.findings.map((f) => f.rule)).not.toContain("branch-pattern");
  });

  it("reports a branch that does not match", () => {
    const result = validate({
      title: TITLE, body: goodBody, config,
      branch: "bugfix/squadb/31087-invoice-default-citizenship-3.75",
    });
    expect(result.findings.map((f) => f.rule)).toContain("branch-pattern");
  });

  it("stays silent when no branch is supplied", () => {
    const result = validate({ title: TITLE, body: goodBody, config });
    expect(result.findings.map((f) => f.rule)).not.toContain("branch-pattern");
  });
});

describe("issue-level", () => {
  const story = { key: "ABC-31444", type: "Story", summary: "s" };
  const subtask = {
    key: "ABC-31454", type: "Development", summary: "Geliştirme",
    parent: { key: "ABC-31444", type: "Story", summary: "s" },
  };

  it("accepts a Story cited directly", () => {
    const result = validate({ title: TITLE, body: goodBody, config, issues: [story] });
    expect(result.findings.map((f) => f.rule)).not.toContain("issue-level");
  });

  it("rejects a Development subtask and names its parent", () => {
    const result = validate({ title: TITLE, body: goodBody, config, issues: [subtask] });
    const finding = result.findings.find((f) => f.rule === "issue-level");
    expect(finding).toBeDefined();
    expect(finding?.message).toContain("ABC-31444");
  });

  it("accepts an issue with no parent whatever its type", () => {
    const orphan = { key: "ABC-31789", type: "Story", summary: "removal" };
    const result = validate({ title: TITLE, body: goodBody, config, issues: [orphan] });
    expect(result.findings.map((f) => f.rule)).not.toContain("issue-level");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/validate/rules.test.ts`
Expected: FAIL — `branch-pattern` and `issue-level` are never emitted, so the two "reports"/"rejects" cases fail.

- [ ] **Step 3: Write the implementation**

In `src/validate/rules.ts`, extend the input type and add the rules. Add this import at the top:

```ts
import type { IssueFacts } from "../jira/types.js";
```

Extend `ValidateInput`:

```ts
export type ValidateInput = {
  title: string;
  body: string;
  config: ShipkitConfig;
  branch?: string;
  issues?: IssueFacts[];
};
```

Change the function signature to destructure the new fields, and append these two blocks immediately before the `return { ok: ..., findings }` statement:

```ts
  if (branch !== undefined && !new RegExp(config.branch.pattern).test(branch)) {
    findings.push({
      rule: "branch-pattern",
      message: `Branch "${branch}" does not match ${config.branch.pattern}`,
    });
  }

  if (config.jira.linkPolicy === "story") {
    for (const issue of issues ?? []) {
      if (!STORY_LEVEL.has(issue.type) && issue.parent !== undefined) {
        findings.push({
          rule: "issue-level",
          message:
            `${issue.key} is a ${issue.type}; cite its parent ${issue.parent.key} ` +
            `(${issue.parent.type}) instead`,
          section: config.jira.section,
        });
      }
    }
  }
```

Add this constant just above `countItems` at the top of the file:

```ts
const STORY_LEVEL = new Set(["Story", "Bug"]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/validate/rules.test.ts`
Expected: PASS — the existing rules tests plus 6 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/validate/rules.ts tests/validate/rules.test.ts
git commit -m "feat(validate): enforce branch pattern and issue level"
```

---

### Task 5: Assemble the brief

**Files:**
- Create: `src/brief/types.ts`
- Create: `src/brief/assemble.ts`
- Test: `tests/brief/assemble.test.ts`

**Interfaces:**
- Consumes: `RepoState` (Task 1), `IssueFacts` (Task 3), `ShipkitConfig` and `Section` from `src/config/schema.js`.
- Produces:
  - `type Brief` with exactly these top-level keys: `change`, `ticket`, `target`, `template`, `rules`.
  - `function assembleBrief(input: { repo: RepoState; target: { branch: string; reason: string }; issue?: IssueFacts; config: ShipkitConfig }): Brief`
  - `assembleBrief` is pure — it performs no I/O and never reads the environment.

- [ ] **Step 1: Write the failing test**

`tests/brief/assemble.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { assembleBrief } from "../../src/brief/assemble.js";

const config = loadConfig("tests/fixtures/valid.shipkit.yml");
const repo = {
  branch: "bugfix/squadb/31087-invoice-default-citizenship",
  changedFiles: ["Sources/Scenes/Payment/Invoice/PaymentAddInvoiceViewModel.swift"],
  diffstat: " 1 file changed, 17 insertions(+), 2 deletions(-)",
  commits: ["fix(invoice): default citizenship from passenger info"],
};
const target = { branch: "release/3.76.0", reason: "chosen by the caller" };

describe("assembleBrief", () => {
  it("carries the change through unchanged", () => {
    const brief = assembleBrief({ repo, target, config });
    expect(brief.change.files).toEqual(repo.changedFiles);
    expect(brief.change.commits).toEqual(repo.commits);
    expect(brief.change.branch).toBe(repo.branch);
  });

  it("states the target and why it was chosen", () => {
    const brief = assembleBrief({ repo, target, config });
    expect(brief.target).toEqual({ branch: "release/3.76.0", reason: "chosen by the caller" });
  });

  it("lists every configured section with its hint and requirements", () => {
    const brief = assembleBrief({ repo, target, config });
    expect(brief.template.sections.map((s) => s.name)).toEqual(
      config.pr.sections.map((s) => s.name),
    );
    const test = brief.template.sections.find((s) => s.name === "What to Test");
    expect(test?.minItems).toBe(3);
    expect(test?.required).toBe(true);
  });

  it("passes the rules the agent must obey", () => {
    const brief = assembleBrief({ repo, target, config });
    expect(brief.rules.titlePattern).toBe(config.pr.titlePattern);
    expect(brief.rules.branchPattern).toBe(config.branch.pattern);
    expect(brief.rules.forbidden).toEqual(config.pr.forbidden);
  });

  it("reports the ticket and the key the body must cite", () => {
    const issue = {
      key: "ABC-31454", type: "Development", summary: "Geliştirme",
      parent: { key: "ABC-31444", type: "Story", summary: "Brand Identity fields" },
    };
    const brief = assembleBrief({ repo, target, config, issue });
    expect(brief.ticket?.key).toBe("ABC-31454");
    expect(brief.ticket?.cite).toBe("ABC-31444");
  });

  it("cites the issue itself when it has no parent", () => {
    const issue = { key: "ABC-31789", type: "Story", summary: "removal" };
    const brief = assembleBrief({ repo, target, config, issue });
    expect(brief.ticket?.cite).toBe("ABC-31789");
  });

  it("omits the ticket when none was resolved", () => {
    expect(assembleBrief({ repo, target, config }).ticket).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/brief/assemble.test.ts`
Expected: FAIL — cannot resolve `../../src/brief/assemble.js`.

- [ ] **Step 3: Write the implementation**

`src/brief/types.ts`:

```ts
export type BriefSection = {
  name: string;
  required: boolean;
  minItems?: number;
  hint?: string;
};

export type Brief = {
  change: { branch: string; files: string[]; diffstat: string; commits: string[] };
  ticket?: {
    key: string;
    type: string;
    summary: string;
    cite: string;
    parent?: { key: string; type: string; summary: string };
  };
  target: { branch: string; reason: string };
  template: { sections: BriefSection[] };
  rules: {
    titlePattern: string;
    branchPattern: string;
    forbidden: string[];
    issuesSection: string;
    linkPolicy: string;
  };
};
```

`src/brief/assemble.ts`:

```ts
import type { ShipkitConfig } from "../config/schema.js";
import type { IssueFacts } from "../jira/types.js";
import type { RepoState } from "../vcs/types.js";
import type { Brief } from "./types.js";

export type { Brief };

export type AssembleInput = {
  repo: RepoState;
  target: { branch: string; reason: string };
  config: ShipkitConfig;
  issue?: IssueFacts;
};

const STORY_LEVEL = new Set(["Story", "Bug"]);

export function assembleBrief({ repo, target, config, issue }: AssembleInput): Brief {
  const brief: Brief = {
    change: {
      branch: repo.branch,
      files: repo.changedFiles,
      diffstat: repo.diffstat,
      commits: repo.commits,
    },
    target,
    template: {
      sections: config.pr.sections.map((section) => ({
        name: section.name,
        required: section.required,
        minItems: section.minItems,
        hint: section.hint,
      })),
    },
    rules: {
      titlePattern: config.pr.titlePattern,
      branchPattern: config.branch.pattern,
      forbidden: config.pr.forbidden,
      issuesSection: config.jira.section,
      linkPolicy: config.jira.linkPolicy,
    },
  };

  if (issue !== undefined) {
    const citeParent =
      config.jira.linkPolicy === "story" &&
      !STORY_LEVEL.has(issue.type) &&
      issue.parent !== undefined;
    brief.ticket = {
      key: issue.key,
      type: issue.type,
      summary: issue.summary,
      cite: citeParent && issue.parent !== undefined ? issue.parent.key : issue.key,
      parent: issue.parent,
    };
  }

  return brief;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/brief/assemble.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/brief tests/brief
git commit -m "feat(brief): assemble the agent brief"
```

---

### Task 6: The `brief` command, and `check` gains the new facts

**Files:**
- Modify: `src/cli.ts`
- Test: `tests/cli.brief.test.ts`

**Interfaces:**
- Consumes: `readRepoState` (Task 1), `defaultBranch`/`baseCandidates` (Task 2), `fetchIssue` (Task 3), `validate` (Task 4), `assembleBrief` (Task 5), `loadConfig`/`ConfigError` (Plan 1).
- Produces:
  - `shipkit brief [--base <branch>] [--config <path>]` — prints the brief as JSON on stdout, exit 0.
  - When `--base` is absent and stdin is **not** a TTY, exit 2 listing the valid targets rather than guessing.
  - `shipkit check` gains `--branch <name>` and `--issue <key>`; when given, they feed `branch-pattern` and `issue-level`.
  - The ticket key is taken from `--issue`, or extracted from the branch name with `config.jira.keyPattern` when the branch contains one.

- [ ] **Step 1: Write the failing test**

`tests/cli.brief.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const CONFIG = "tests/fixtures/valid.shipkit.yml";

function run(args: string[], env: Record<string, string> = {}): {
  status: number; stdout: string; stderr: string;
} {
  try {
    const stdout = execFileSync("node", ["dist/cli.js", ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    return { status: failure.status, stdout: failure.stdout, stderr: failure.stderr };
  }
}

describe("shipkit brief", () => {
  it("exits 2 and lists targets when no base is given and stdin is not a terminal", () => {
    const result = run(["brief", "--config", CONFIG]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--base");
  });
});

describe("shipkit check with branch and issue", () => {
  it("reports branch-pattern for a non-conforming branch", () => {
    const result = run([
      "check", "--title", "[ABC-1] fix(x): y",
      "--body-file", "tests/fixtures/complete-body.md",
      "--config", CONFIG,
      "--branch", "not-a-valid-branch-name",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("branch-pattern");
  });

  it("accepts a conforming branch", () => {
    const result = run([
      "check", "--title", "[ABC-1] fix(x): y",
      "--body-file", "tests/fixtures/complete-body.md",
      "--config", CONFIG,
      "--branch", "bugfix/squadb/1-ok",
    ]);
    expect(result.status).toBe(0);
  });
});
```

Also create `tests/fixtures/complete-body.md`:

```markdown
## Summary

A complete body used by the CLI tests.

## Screenshots / Screen Recordings

Nothing to show — logic only.

## What to Test

- one
- two
- three

## Issues Addressed

- [ABC-1](https://jira.example.com/browse/ABC-1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run tests/cli.brief.test.ts`
Expected: FAIL — `brief` is an unknown command, and `check` rejects `--branch` as an unknown option.

- [ ] **Step 3: Write the implementation**

In `src/cli.ts`, add these imports:

```ts
import { assembleBrief } from "./brief/assemble.js";
import { fetchIssue, JiraError } from "./jira/client.js";
import type { IssueFacts } from "./jira/types.js";
import { readRepoState } from "./vcs/git.js";
import { baseCandidates } from "./vcs/github.js";
import { VcsError } from "./vcs/types.js";
```

Add this helper above the commands:

```ts
function ticketFromBranch(branch: string, keyPattern: string): string | undefined {
  const match = new RegExp(keyPattern).exec(branch);
  return match?.[0];
}

async function resolveIssue(
  key: string | undefined,
  config: { jira: { baseUrl: string } },
): Promise<IssueFacts | undefined> {
  if (key === undefined) return undefined;
  const token = process.env.SHIPKIT_JIRA_TOKEN;
  if (token === undefined || token.length === 0) return undefined;
  return fetchIssue(config.jira.baseUrl, key, token);
}
```

Add `--branch` and `--issue` options to the existing `check` command, and inside its action resolve the issue and pass both to `validate`:

```ts
  .option("--branch <name>", "branch name to validate")
  .option("--issue <key>", "issue key cited by this change")
```

In the `check` action, after loading the config:

```ts
      const issue = await resolveIssue(options.issue, config);
      const result = validate({
        title: options.title,
        body,
        config,
        branch: options.branch,
        issues: issue === undefined ? undefined : [issue],
      });
```

Make that action `async`, and add the `brief` command:

```ts
program
  .command("brief")
  .description("Emit the JSON brief an agent fills in")
  .option("--base <branch>", "target branch for the pull request")
  .option("--config <path>", "path to .shipkit.yml", ".shipkit.yml")
  .action(async (options: { base?: string; config: string }) => {
    try {
      const config = loadConfig(options.config);

      let base = options.base;
      let reason = "given with --base";
      if (base === undefined) {
        if (!process.stdin.isTTY) {
          const candidates = baseCandidates();
          console.error(
            `--base is required when stdin is not a terminal. Valid targets: ${candidates.join(", ")}`,
          );
          process.exit(2);
        }
        base = baseCandidates()[0];
        reason = "repository default branch";
      }

      const repo = readRepoState(base);
      const key = ticketFromBranch(repo.branch, config.jira.keyPattern);
      const issue = await resolveIssue(key, config);
      const brief = assembleBrief({ repo, target: { branch: base, reason }, config, issue });
      console.log(JSON.stringify(brief, null, 2));
      process.exit(0);
    } catch (error) {
      if (error instanceof ConfigError || error instanceof VcsError || error instanceof JiraError) {
        console.error(error.message);
        process.exit(2);
      }
      throw error;
    }
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && npx vitest run tests/cli.brief.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run check`
Expected: PASS, no type errors. All Plan 1 tests still pass.

- [ ] **Step 6: Verify the brief against this very repository**

Run:

```bash
node dist/cli.js brief --base main --config docs/examples/example-app.shipkit.yml | head -40
```

Expected: valid JSON with `change`, `target`, `template`, and `rules` keys. `ticket` is absent, because this repository's branch names carry no DCP key and no Jira token is set. Record the actual output in your report.

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts tests/cli.brief.test.ts tests/fixtures/complete-body.md
git commit -m "feat(cli): add the brief command and wire the new rules into check"
```

---

## Done when

- `npm test` passes from a clean checkout, and `npm run check` reports no type errors.
- `shipkit brief --base main` emits valid JSON against this repository.
- `shipkit check --branch <bad>` reports `branch-pattern`; a conforming branch does not.
- No command in this slice writes to the repository or the forge.

## Next plan

**Plan 3 — `submit`, pre-flight, `init` and `branch`:** the mutating half. Pre-flight adds `findPullRequest` and `PullRequestState` to the `vcs` adapter, to warn that a push will dismiss N approvals, that a blocking label is present, or that the branch's base disagrees with the pull request's. `init` reconstructs a config from the forge and from merged pull-request bodies, the way `docs/examples/example-app.shipkit.yml` was reconstructed by hand.
