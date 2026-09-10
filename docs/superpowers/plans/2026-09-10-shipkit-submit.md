# shipkit `submit` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the agent's filled-in answer, refuse it unless it complies, warn about the mistakes that are expensive to undo, and then commit, push and open the pull request.

**Architecture:** Every mutation goes through a runner seam, so the tests assert the exact `git` and `gh` argument arrays without a single command executing. Pre-flight is a pure function over facts the adapters gather, in the same shape as the validation gate. The command is a thin sequence: validate, gather, warn, act.

**Tech Stack:** Node 25, TypeScript, `commander`, `zod`, `yaml`, `vitest`. External binaries: `git`, `gh`.

**Spec:** `docs/superpowers/specs/2026-09-10-shipkit-design.md`
**Merged plans:** `docs/superpowers/plans/2026-09-10-shipkit-check.md`, `docs/superpowers/plans/2026-09-10-shipkit-brief.md`
**Reference examples:** `docs/examples/example-app-pr-bodies.md`, `docs/examples/example-app.shipkit.yml`

## Global Constraints

- ESM only. Relative imports inside `src/` carry the `.js` extension.
- TypeScript `strict: true`. No `any` in committed code.
- Exit codes: `0` clean, `1` findings, `2` usage or configuration error.
- Findings print one per line as `<rule>: <message>`. Warnings print one per line as `<check>: <message>`.
- `validate()` and `preflight()` are pure and synchronous — facts are passed in, never fetched inside.
- Shell out with `execFileSync` and an explicit argument array, never a shell string. Every `git` invocation taking a user-supplied revision passes `--end-of-options` before it.
- The Jira token comes from `SHIPKIT_JIRA_TOKEN` and must never be logged, written, or sent to the forge.
- **No test in this plan may execute `git` or `gh` against a real repository or remote.** Mutating functions take a runner; tests inject fakes and assert argv.
- Never call `process.exit` after writing to stdout or stderr — set `process.exitCode` and return, or output truncates when piped.

## Scope

Delivered: `shipkit submit`, and the pre-flight checks it runs first.

Deferred to the next plan: `init` and `branch`. `init` infers a config from the forge and from merged pull-request bodies; that is a distinct subsystem from acting on a branch, and it shares only the `gh` adapter with this one.

## The five pre-flight checks

Each exists because the failure it catches happened while this tool was being designed. The check ids are part of the output contract.

| id | Catches |
|---|---|
| `approvals-dismissed` | A push that will invalidate approvals already given. Four were lost to a redundant merge commit; one more to a base change. |
| `foreign-commits` | The branch carrying commits that cite a different ticket — the shape a `develop` merge takes when the branch is then retargeted at a release. |
| `base-mismatch` | The branch's chosen base disagreeing with the base of the pull request that already exists for it. |
| `blocking-label` | A label on the existing pull request that the merge gate treats as blocking. |
| `issue-unverified` | A ticket key was derived from the branch but could not be checked against Jira, so `issue-level` never ran. Without this, the last gate before a pull request fails open exactly when the token is missing. |

## File Structure

| File | Responsibility |
|---|---|
| `src/vcs/github.ts` | Gains `findPullRequest`; existing exports unchanged |
| `src/vcs/types.ts` | Gains `PullRequestState` |
| `src/vcs/mutate.ts` | The only file that changes the repository or the forge |
| `src/preflight/types.ts` | `Warning`, `PreflightInput`, `PreflightResult` |
| `src/preflight/checks.ts` | The pure `preflight` function |
| `src/submit/response.ts` | Load and schema-check the agent's answer; render the body |
| `src/cli.ts` | Adds the `submit` command |
| `tests/**` | One test file per module |

---

### Task 1: Read the pull request for a branch

**Files:**
- Modify: `src/vcs/types.ts`
- Modify: `src/vcs/github.ts`
- Test: `tests/vcs/github.test.ts`

**Interfaces:**
- Consumes: `VcsError`, `GhRunner` — both already exported.
- Produces:
  - `type PullRequestState = { number: number; baseRefName: string; labels: string[]; approvals: string[] }`
  - `function findPullRequest(branch: string, run?: GhRunner): PullRequestState | null`
  - `approvals` holds the logins whose **latest** review is `APPROVED`. Returns `null` when the branch has no open pull request. Throws `VcsError` on a `gh` failure or a payload of the wrong shape, exactly as the existing functions do.

- [ ] **Step 1: Write the failing test**

Append to `tests/vcs/github.test.ts` at top level:

```ts
describe("findPullRequest", () => {
  it("returns null when the branch has no open pull request", () => {
    expect(findPullRequest("feature/x", () => "[]")).toBeNull();
  });

  it("reports number, base, labels and approving logins", () => {
    const run = (args: string[]): string => {
      if (args.includes("list")) {
        return JSON.stringify([{ number: 881, baseRefName: "release/3.76.0" }]);
      }
      return JSON.stringify({
        labels: [{ name: "in test" }],
        latestReviews: [
          { author: { login: "alice" }, state: "APPROVED" },
          { author: { login: "bob" }, state: "CHANGES_REQUESTED" },
        ],
      });
    };
    expect(findPullRequest("feature/x", run)).toEqual({
      number: 881,
      baseRefName: "release/3.76.0",
      labels: ["in test"],
      approvals: ["alice"],
    });
  });

  it("sends the exact arguments for both calls", () => {
    const seen: string[][] = [];
    const run = (args: string[]): string => {
      seen.push(args);
      return args.includes("list")
        ? JSON.stringify([{ number: 7, baseRefName: "develop" }])
        : JSON.stringify({ labels: [], latestReviews: [] });
    };
    findPullRequest("feature/x", run);
    expect(seen).toEqual([
      ["pr", "list", "--head", "feature/x", "--state", "open", "--json", "number,baseRefName"],
      ["pr", "view", "7", "--json", "labels,latestReviews"],
    ]);
  });

  it("throws VcsError when the list payload is not an array", () => {
    expect(() => findPullRequest("feature/x", () => '{"message":"rate limited"}')).toThrow(VcsError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vcs/github.test.ts`
Expected: FAIL — `findPullRequest` is not exported.

- [ ] **Step 3: Write the implementation**

Add to `src/vcs/types.ts`:

```ts
export type PullRequestState = {
  number: number;
  baseRefName: string;
  labels: string[];
  approvals: string[];
};
```

Add to `src/vcs/github.ts` — reuse the file's existing `call` helper and its shape guards:

```ts
export function findPullRequest(
  branch: string,
  run: GhRunner = defaultRunner,
): PullRequestState | null {
  const list = call<unknown>(run, [
    "pr", "list", "--head", branch, "--state", "open", "--json", "number,baseRefName",
  ]);
  if (!Array.isArray(list)) {
    throw new VcsError("gh pr list did not return an array");
  }
  if (list.length === 0) return null;

  const head = list[0] as { number?: unknown; baseRefName?: unknown };
  if (typeof head.number !== "number" || typeof head.baseRefName !== "string") {
    throw new VcsError("gh pr list returned an entry without number or baseRefName");
  }

  const detail = call<unknown>(run, [
    "pr", "view", String(head.number), "--json", "labels,latestReviews",
  ]);
  if (typeof detail !== "object" || detail === null) {
    throw new VcsError("gh pr view did not return an object");
  }
  const record = detail as { labels?: unknown; latestReviews?: unknown };
  const labels = Array.isArray(record.labels) ? record.labels : [];
  const reviews = Array.isArray(record.latestReviews) ? record.latestReviews : [];

  return {
    number: head.number,
    baseRefName: head.baseRefName,
    labels: labels
      .map((l) => (l as { name?: unknown }).name)
      .filter((n): n is string => typeof n === "string"),
    approvals: reviews
      .filter((r) => (r as { state?: unknown }).state === "APPROVED")
      .map((r) => (r as { author?: { login?: unknown } }).author?.login)
      .filter((n): n is string => typeof n === "string"),
  };
}
```

Import `PullRequestState` as a type at the top of `github.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/vcs/github.test.ts`
Expected: PASS — the existing tests plus 4 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/vcs/github.ts src/vcs/types.ts tests/vcs/github.test.ts
git commit -m "feat(vcs): read the pull request for a branch"
```

---

### Task 2: The pre-flight checks

**Files:**
- Create: `src/preflight/types.ts`
- Create: `src/preflight/checks.ts`
- Test: `tests/preflight/checks.test.ts`

**Interfaces:**
- Consumes: `PullRequestState` (Task 1), `ShipkitConfig`.
- Produces:
  - `type Warning = { check: string; message: string }`
  - `type PreflightInput = { branch: string; base: string; commits: string[]; ticketKey?: string; issueVerified: boolean; pullRequest: PullRequestState | null; config: ShipkitConfig }`
  - `type PreflightResult = { warnings: Warning[] }`
  - `function preflight(input: PreflightInput): PreflightResult`
  - Check ids exactly: `approvals-dismissed`, `foreign-commits`, `base-mismatch`, `blocking-label`, `issue-unverified`.
  - `issue-unverified` fires when `ticketKey` is present but `issueVerified` is false. With no `ticketKey` it is silent: there was nothing to verify.
  - `foreign-commits` reports commit subjects citing a key that matches `config.jira.keyPattern` and differs from `ticketKey`. With no `ticketKey`, the check is silent — there is nothing to compare against.
  - `blocking-label` uses `config.pr.blockingLabels`, a new config field added in this task, defaulting to `[]`. Comparison is case-insensitive.

- [ ] **Step 1: Write the failing test**

`tests/preflight/checks.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { preflight } from "../../src/preflight/checks.js";

const config = loadConfig("tests/fixtures/valid.shipkit.yml");
const base = {
  branch: "bugfix/squadb/31087-invoice",
  base: "develop",
  commits: ["fix(invoice): default citizenship"],
  ticketKey: "ABC-31087",
  issueVerified: true,
  pullRequest: null,
  config,
};
const ids = (r: { warnings: { check: string }[] }) => r.warnings.map((w) => w.check);

describe("preflight", () => {
  it("is silent for a clean branch with no pull request", () => {
    expect(preflight(base).warnings).toEqual([]);
  });

  it("warns that a push will dismiss existing approvals", () => {
    const result = preflight({
      ...base,
      pullRequest: { number: 1, baseRefName: "develop", labels: [], approvals: ["alice", "bob"] },
    });
    const finding = result.warnings.find((w) => w.check === "approvals-dismissed");
    expect(finding?.message).toContain("2");
  });

  it("stays silent when the pull request has no approvals", () => {
    const result = preflight({
      ...base,
      pullRequest: { number: 1, baseRefName: "develop", labels: [], approvals: [] },
    });
    expect(ids(result)).not.toContain("approvals-dismissed");
  });

  it("warns about commits citing another ticket", () => {
    const result = preflight({
      ...base,
      commits: ["fix(invoice): default citizenship", "[ABC-27975] fix(split-passenger): popup"],
    });
    const finding = result.warnings.find((w) => w.check === "foreign-commits");
    expect(finding?.message).toContain("ABC-27975");
  });

  it("does not treat the branch's own ticket as foreign", () => {
    const result = preflight({
      ...base,
      commits: ["[ABC-31087] fix(invoice): default citizenship"],
    });
    expect(ids(result)).not.toContain("foreign-commits");
  });

  it("is silent about foreign commits when no ticket is known", () => {
    const result = preflight({
      ...base,
      ticketKey: undefined,
      commits: ["[ABC-27975] fix(split-passenger): popup"],
    });
    expect(ids(result)).not.toContain("foreign-commits");
  });

  it("warns when the chosen base differs from the open pull request's", () => {
    const result = preflight({
      ...base,
      pullRequest: { number: 1, baseRefName: "release/3.76.0", labels: [], approvals: [] },
    });
    const finding = result.warnings.find((w) => w.check === "base-mismatch");
    expect(finding?.message).toContain("release/3.76.0");
    expect(finding?.message).toContain("develop");
  });

  it("warns about a blocking label, case-insensitively", () => {
    const withLabels = loadConfig("tests/fixtures/blocking-labels.shipkit.yml");
    const result = preflight({
      ...base,
      config: withLabels,
      pullRequest: { number: 1, baseRefName: "develop", labels: ["In Test"], approvals: [] },
    });
    expect(ids(result)).toContain("blocking-label");
  });

  it("warns when a ticket key could not be verified against Jira", () => {
    const result = preflight({ ...base, issueVerified: false });
    const finding = result.warnings.find((w) => w.check === "issue-unverified");
    expect(finding?.message).toContain("ABC-31087");
  });

  it("is silent about verification when there is no ticket key", () => {
    const result = preflight({ ...base, ticketKey: undefined, issueVerified: false });
    expect(ids(result)).not.toContain("issue-unverified");
  });

  it("ignores labels that are not configured as blocking", () => {
    const withLabels = loadConfig("tests/fixtures/blocking-labels.shipkit.yml");
    const result = preflight({
      ...base,
      config: withLabels,
      pullRequest: { number: 1, baseRefName: "develop", labels: ["needs-design"], approvals: [] },
    });
    expect(ids(result)).not.toContain("blocking-label");
  });
});
```

Create `tests/fixtures/blocking-labels.shipkit.yml` by copying `tests/fixtures/valid.shipkit.yml` and adding, under `pr:`:

```yaml
  blockingLabels: ["in test", "in progress", "blocked", "waiting"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/preflight/checks.test.ts`
Expected: FAIL — cannot resolve `../../src/preflight/checks.js`.

- [ ] **Step 3: Write the implementation**

Add to `src/config/schema.ts`, inside the `pr` object, after `forbidden`:

```ts
    blockingLabels: z.array(z.string()).default([]),
```

`src/preflight/types.ts`:

```ts
import type { ShipkitConfig } from "../config/schema.js";
import type { PullRequestState } from "../vcs/types.js";

export type Warning = {
  check: string;
  message: string;
};

export type PreflightInput = {
  branch: string;
  base: string;
  commits: string[];
  ticketKey?: string;
  /** False when a key was derived but Jira could not be consulted — see `issue-unverified`. */
  issueVerified: boolean;
  pullRequest: PullRequestState | null;
  config: ShipkitConfig;
};

export type PreflightResult = {
  warnings: Warning[];
};
```

`src/preflight/checks.ts`:

```ts
import type { PreflightInput, PreflightResult, Warning } from "./types.js";

export type { PreflightInput, PreflightResult, Warning };

function foreignKeys(commits: string[], keyPattern: string, ticketKey: string): string[] {
  const pattern = new RegExp(keyPattern, "g");
  const found = new Set<string>();
  for (const subject of commits) {
    for (const match of subject.matchAll(pattern)) {
      if (match[0] !== ticketKey) found.add(match[0]);
    }
  }
  return [...found];
}

export function preflight(input: PreflightInput): PreflightResult {
  const { branch, base, commits, ticketKey, pullRequest, config } = input;
  const warnings: Warning[] = [];

  if (pullRequest !== null && pullRequest.approvals.length > 0) {
    warnings.push({
      check: "approvals-dismissed",
      message:
        `Pushing will dismiss ${pullRequest.approvals.length} existing approval(s) on ` +
        `#${pullRequest.number}: ${pullRequest.approvals.join(", ")}`,
    });
  }

  if (ticketKey !== undefined) {
    const foreign = foreignKeys(commits, config.jira.keyPattern, ticketKey);
    if (foreign.length > 0) {
      warnings.push({
        check: "foreign-commits",
        message:
          `Branch "${branch}" carries commits citing ${foreign.join(", ")}, not ${ticketKey}. ` +
          `They will appear in this pull request.`,
      });
    }
  }

  if (pullRequest !== null && pullRequest.baseRefName !== base) {
    warnings.push({
      check: "base-mismatch",
      message:
        `Pull request #${pullRequest.number} targets ${pullRequest.baseRefName}, ` +
        `but this run targets ${base}`,
    });
  }

  if (pullRequest !== null) {
    const blocking = new Set(config.pr.blockingLabels.map((l) => l.toLowerCase()));
    const present = pullRequest.labels.filter((l) => blocking.has(l.toLowerCase()));
    if (present.length > 0) {
      warnings.push({
        check: "blocking-label",
        message: `Label(s) ${present.join(", ")} will block the merge gate`,
      });
    }
  }

  if (ticketKey !== undefined && !input.issueVerified) {
    warnings.push({
      check: "issue-unverified",
      message:
        `${ticketKey} could not be checked against Jira, so the issue-level rule did not run. ` +
        `Set SHIPKIT_JIRA_TOKEN to verify the cited key is at Story or Bug level.`,
    });
  }

  return { warnings };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/preflight/checks.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/preflight src/config/schema.ts tests/preflight tests/fixtures/blocking-labels.shipkit.yml
git commit -m "feat(preflight): warn about the mistakes that are expensive to undo"
```

---

### Task 3: Load the agent's answer and render the body

**Files:**
- Create: `src/submit/response.ts`
- Test: `tests/submit/response.test.ts`

**Interfaces:**
- Consumes: `ShipkitConfig`.
- Produces:
  - `class ResponseError extends Error`
  - `type SubmitResponse = { title: string; commitMessage: string; sections: Record<string, string> }`
  - `function loadResponse(path: string): SubmitResponse` — throws `ResponseError` for an unreadable file, unparseable JSON, or a payload failing the schema.
  - `function renderBody(sections: Record<string, string>, config: ShipkitConfig): string` — emits the sections in the config's order as `## <name>` followed by the content, separated by `---` lines, matching the house skeleton. A section the response omits is emitted with empty content, so the validation gate reports it rather than the renderer hiding it.

- [ ] **Step 1: Write the failing test**

`tests/submit/response.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { loadResponse, renderBody, ResponseError } from "../../src/submit/response.js";

const config = loadConfig("tests/fixtures/valid.shipkit.yml");

function fileWith(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "shipkit-resp-")), "response.json");
  writeFileSync(path, content, "utf8");
  return path;
}

const valid = {
  title: "[ABC-1] fix(x): y",
  commitMessage: "fix(x): y\n\nBody of the commit.",
  sections: { Summary: "It was broken.", "What to Test": "- a\n- b\n- c" },
};

describe("loadResponse", () => {
  it("reads a well-formed response", () => {
    expect(loadResponse(fileWith(JSON.stringify(valid)))).toEqual(valid);
  });

  it("throws for a missing file", () => {
    expect(() => loadResponse("tests/fixtures/nope.json")).toThrow(ResponseError);
  });

  it("throws for unparseable JSON", () => {
    expect(() => loadResponse(fileWith("{"))).toThrow(ResponseError);
  });

  it("throws when a required field is absent", () => {
    expect(() => loadResponse(fileWith(JSON.stringify({ title: "t" })))).toThrow(ResponseError);
  });

  it("throws when sections is not a map of strings", () => {
    const bad = { ...valid, sections: { Summary: 42 } };
    expect(() => loadResponse(fileWith(JSON.stringify(bad)))).toThrow(ResponseError);
  });
});

describe("renderBody", () => {
  it("emits sections in the config's order, not the response's", () => {
    const body = renderBody({ "What to Test": "- a", Summary: "s" }, config);
    expect(body.indexOf("## Summary")).toBeLessThan(body.indexOf("## What to Test"));
  });

  it("emits an empty section rather than dropping it", () => {
    const body = renderBody({ Summary: "s" }, config);
    expect(body).toContain("## What to Test");
  });

  it("separates sections with a rule", () => {
    expect(renderBody({ Summary: "s" }, config)).toContain("\n---\n");
  });

  it("round-trips through the body parser", async () => {
    const { parseBody } = await import("../../src/validate/body.js");
    const parsed = parseBody(renderBody({ Summary: "s", "What to Test": "- a" }, config));
    expect(parsed.sections.Summary).toBe("s");
    expect(parsed.sections["What to Test"]).toBe("- a");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/submit/response.test.ts`
Expected: FAIL — cannot resolve `../../src/submit/response.js`.

- [ ] **Step 3: Write the implementation**

`src/submit/response.ts`:

```ts
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ShipkitConfig } from "../config/schema.js";

export class ResponseError extends Error {}

const responseSchema = z.object({
  title: z.string().min(1),
  commitMessage: z.string().min(1),
  sections: z.record(z.string(), z.string()),
});

export type SubmitResponse = z.infer<typeof responseSchema>;

export function loadResponse(path: string): SubmitResponse {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new ResponseError(`Cannot read response at ${path}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ResponseError(`Cannot parse JSON at ${path}: ${detail}`);
  }

  const result = responseSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new ResponseError(`Invalid response at ${path}: ${detail}`);
  }
  return result.data;
}

export function renderBody(
  sections: Record<string, string>,
  config: ShipkitConfig,
): string {
  return config.pr.sections
    .map((section) => `## ${section.name}\n\n${(sections[section.name] ?? "").trim()}\n`)
    .join("\n---\n\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/submit/response.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/submit tests/submit
git commit -m "feat(submit): load the agent's answer and render the body"
```

---

### Task 4: The mutation adapter

**Files:**
- Create: `src/vcs/mutate.ts`
- Test: `tests/vcs/mutate.test.ts`

**Interfaces:**
- Consumes: `VcsError`, `GhRunner`.
- Produces:
  - `type GitRunner = (args: string[]) => string`
  - `function commitAll(message: string, run?: GitRunner): void` — stages everything, then commits with the message as a single `-m` argument, never interpolated into a shell.
  - `function pushBranch(branch: string, run?: GitRunner): void`
  - `function createPullRequest(input: { title: string; body: string; base: string; head: string }, run?: GhRunner): string` — returns the URL `gh` prints, trimmed.
  - All three throw `VcsError` on failure. This is the only module in the project permitted to change the repository or the forge.

- [ ] **Step 1: Write the failing test**

`tests/vcs/mutate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { commitAll, createPullRequest, pushBranch } from "../../src/vcs/mutate.js";
import { VcsError } from "../../src/vcs/types.js";

describe("commitAll", () => {
  it("stages everything then commits with the message as one argument", () => {
    const seen: string[][] = [];
    commitAll("fix(x): y\n\nBody.", (args) => {
      seen.push(args);
      return "";
    });
    expect(seen).toEqual([
      ["add", "--all"],
      ["commit", "-m", "fix(x): y\n\nBody."],
    ]);
  });

  it("throws VcsError when git fails", () => {
    expect(() => commitAll("m", () => { throw new Error("nothing to commit"); })).toThrow(VcsError);
  });
});

describe("pushBranch", () => {
  it("pushes the named branch to origin and sets upstream", () => {
    const seen: string[][] = [];
    pushBranch("feature/x", (args) => {
      seen.push(args);
      return "";
    });
    expect(seen).toEqual([["push", "--set-upstream", "origin", "feature/x"]]);
  });

  it("never passes --force", () => {
    const seen: string[][] = [];
    pushBranch("feature/x", (args) => {
      seen.push(args);
      return "";
    });
    expect(seen.flat()).not.toContain("--force");
    expect(seen.flat()).not.toContain("-f");
  });

  it("throws VcsError when the push is rejected", () => {
    expect(() => pushBranch("x", () => { throw new Error("rejected"); })).toThrow(VcsError);
  });
});

describe("createPullRequest", () => {
  it("sends title, body, base and head, and returns the URL", () => {
    const seen: string[][] = [];
    const url = createPullRequest(
      { title: "T", body: "B", base: "develop", head: "feature/x" },
      (args) => {
        seen.push(args);
        return "https://example.com/pr/1\n";
      },
    );
    expect(seen).toEqual([
      ["pr", "create", "--title", "T", "--body", "B", "--base", "develop", "--head", "feature/x"],
    ]);
    expect(url).toBe("https://example.com/pr/1");
  });

  it("throws VcsError when gh fails", () => {
    expect(() =>
      createPullRequest({ title: "T", body: "B", base: "d", head: "h" }, () => {
        throw new Error("not authenticated");
      }),
    ).toThrow(VcsError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vcs/mutate.test.ts`
Expected: FAIL — cannot resolve `../../src/vcs/mutate.js`.

- [ ] **Step 3: Write the implementation**

`src/vcs/mutate.ts`:

```ts
import { execFileSync } from "node:child_process";
import { VcsError } from "./types.js";
import type { GhRunner } from "./github.js";

export type GitRunner = (args: string[]) => string;

function runner(binary: string): (args: string[]) => string {
  return (args) => {
    try {
      return execFileSync(binary, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const detail =
        (error as { stderr?: string }).stderr ??
        (error instanceof Error ? error.message : String(error));
      throw new VcsError(`${binary} ${args.join(" ")} failed: ${String(detail).trim()}`);
    }
  };
}

const defaultGit: GitRunner = runner("git");
const defaultGh: GhRunner = runner("gh");

function guard(run: (args: string[]) => string, args: string[], binary: string): string {
  try {
    return run(args);
  } catch (error) {
    if (error instanceof VcsError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new VcsError(`${binary} ${args.join(" ")} failed: ${detail}`);
  }
}

export function commitAll(message: string, run: GitRunner = defaultGit): void {
  guard(run, ["add", "--all"], "git");
  guard(run, ["commit", "-m", message], "git");
}

export function pushBranch(branch: string, run: GitRunner = defaultGit): void {
  guard(run, ["push", "--set-upstream", "origin", branch], "git");
}

export function createPullRequest(
  input: { title: string; body: string; base: string; head: string },
  run: GhRunner = defaultGh,
): string {
  const out = guard(
    run,
    [
      "pr", "create",
      "--title", input.title,
      "--body", input.body,
      "--base", input.base,
      "--head", input.head,
    ],
    "gh",
  );
  return out.trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/vcs/mutate.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/vcs/mutate.ts tests/vcs/mutate.test.ts
git commit -m "feat(vcs): commit, push and open a pull request"
```

---

### Task 5: The `submit` command

**Files:**
- Modify: `src/cli.ts`
- Test: `tests/cli.submit.test.ts`

**Interfaces:**
- Consumes: `loadConfig`/`ConfigError`, `validate`, `loadResponse`/`renderBody`/`ResponseError` (Task 3), `preflight` (Task 2), `findPullRequest` (Task 1), `commitAll`/`pushBranch`/`createPullRequest` (Task 4), `currentBranch`/`readRepoState`, `isValidBase`, `ticketFromBranch`.
- Produces: `shipkit submit --input <path> --base <branch> [--config <path>] [--yes]`.

The sequence, and its exits:

1. `--base` fails `isValidBase` → exit 2, nothing else runs.
2. Config or response fails to load → exit 2.
3. `validate` reports findings → print them, exit 1. **Nothing is committed, pushed or opened.**
4. `preflight` reports warnings → print them. Without `--yes`, exit 2 and change nothing. With `--yes`, continue.
5. Commit, push, create the pull request, print the URL, exit 0.

The confirmation is deliberately not an interactive prompt: an agent runs this unattended, and a prompt it cannot answer is a hang. `--yes` is the explicit acknowledgement.

- [ ] **Step 1: Write the failing test**

`tests/cli.submit.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CONFIG = "tests/fixtures/valid.shipkit.yml";

function responseFile(over: Record<string, unknown> = {}): string {
  const body = {
    title: "[ABC-1] fix(x): y",
    commitMessage: "fix(x): y",
    sections: {
      Summary: "It was broken; now it is not.",
      "Screenshots / Screen Recordings": "Nothing to show — logic only.",
      "What to Test": "- one\n- two\n- three",
      "Issues Addressed": "- [ABC-1](https://jira.example.com/browse/ABC-1)",
    },
    ...over,
  };
  const path = join(mkdtempSync(join(tmpdir(), "shipkit-sub-")), "r.json");
  writeFileSync(path, JSON.stringify(body), "utf8");
  return path;
}

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", ["dist/cli.js", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const f = error as { status: number; stdout: string; stderr: string };
    return { status: f.status, stdout: f.stdout, stderr: f.stderr };
  }
}

describe("shipkit submit", () => {
  it("exits 2 for an option-shaped base without running anything", () => {
    const r = run(["submit", "--input", responseFile(), "--base", "--output=/tmp/x", "--config", CONFIG]);
    expect(r.status).toBe(2);
  });

  it("exits 2 when the response file is missing", () => {
    const r = run(["submit", "--input", "tests/fixtures/nope.json", "--base", "develop", "--config", CONFIG]);
    expect(r.status).toBe(2);
  });

  it("exits 1 and names the rule when the answer does not comply", () => {
    const bad = responseFile({ title: "nope" });
    const r = run(["submit", "--input", bad, "--base", "develop", "--config", CONFIG]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("title-pattern");
  });

  it("does not push when validation fails", () => {
    const bad = responseFile({ title: "nope" });
    const r = run(["submit", "--input", bad, "--base", "develop", "--config", CONFIG]);
    expect(r.stderr).not.toContain("https://");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run tests/cli.submit.test.ts`
Expected: FAIL — `submit` is an unknown command, so every case exits 2 with commander's usage error and the third assertion on `title-pattern` fails.

- [ ] **Step 3: Write the implementation**

Add these imports to `src/cli.ts`:

```ts
import { preflight } from "./preflight/checks.js";
import { loadResponse, renderBody, ResponseError } from "./submit/response.js";
import { commitAll, createPullRequest, pushBranch } from "./vcs/mutate.js";
import { findPullRequest } from "./vcs/github.js";
```

Add the command:

```ts
program
  .command("submit")
  .description("Validate the agent's answer, warn, then commit, push and open the pull request")
  .requiredOption("--input <path>", "file holding the agent's answer")
  .requiredOption("--base <branch>", "target branch for the pull request")
  .option("--config <path>", "path to .shipkit.yml", ".shipkit.yml")
  .option("--yes", "proceed despite pre-flight warnings", false)
  .action(async (options: {
    input: string; base: string; config: string; yes: boolean;
  }) => {
    try {
      if (!isValidBase(options.base)) {
        console.error(`Refusing to use ${JSON.stringify(options.base)} as a base branch`);
        process.exitCode = 2;
        return;
      }

      const config = loadConfig(options.config);
      const response = loadResponse(options.input);
      const body = renderBody(response.sections, config);
      const branch = currentBranch();
      const ticketKey = ticketFromBranch(branch, config.jira.keyPattern);
      const issue = await resolveIssue(ticketKey, config);

      const result = validate({
        title: response.title,
        body,
        config,
        branch,
        issues: issue === undefined ? undefined : [issue],
      });
      if (!result.ok) {
        for (const finding of result.findings) {
          console.error(`${finding.rule}: ${finding.message}`);
        }
        process.exitCode = 1;
        return;
      }

      const repo = readRepoState(options.base);
      const warnings = preflight({
        branch,
        base: options.base,
        commits: repo.commits,
        ticketKey,
        issueVerified: issue !== undefined,
        pullRequest: findPullRequest(branch),
        config,
      }).warnings;

      if (warnings.length > 0) {
        for (const warning of warnings) {
          console.error(`${warning.check}: ${warning.message}`);
        }
        if (!options.yes) {
          console.error("Refusing to proceed. Re-run with --yes to accept these.");
          process.exitCode = 2;
          return;
        }
      }

      commitAll(response.commitMessage);
      pushBranch(branch);
      const url = createPullRequest({
        title: response.title,
        body,
        base: options.base,
        head: branch,
      });
      console.log(url);
      process.exitCode = 0;
    } catch (error) {
      if (
        error instanceof ConfigError ||
        error instanceof ResponseError ||
        error instanceof VcsError ||
        error instanceof JiraError
      ) {
        console.error(error.message);
        process.exitCode = 2;
        return;
      }
      throw error;
    }
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && npx vitest run tests/cli.submit.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Run the full suite**

Run: `rm -rf dist && npm test && npm run check`
Expected: PASS, no type errors. Every test from the merged plans still passes.

- [ ] **Step 6: Verify nothing was pushed**

Run:

```bash
git status --porcelain && git log --oneline -3
```

Expected: the working tree is clean and the log shows only this task's own commits. The suite never reaches step 5 of the sequence, because every case fails earlier — confirm no stray commit was created by a test.

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts tests/cli.submit.test.ts
git commit -m "feat(cli): add the submit command"
```

---

## Done when

- `npm test` passes from a clean checkout and `npm run check` reports no type errors.
- `submit` exits 1 on findings and 2 on warnings without `--yes`, having changed nothing in either case.
- No test executes `git` or `gh` against a real repository or remote.
- `git status` is clean after the suite runs.

## Next plan

**`init` and `branch`:** `init` reconstructs a `.shipkit.yml` the way `docs/examples/example-app.shipkit.yml` was reconstructed by hand — reading the branch pattern from the repository ruleset, the required approvals from branch protection, the blocking labels from the merge-gate workflow, and the template's boilerplate from the bodies of merged pull requests. `branch` suggests a name that satisfies the pattern.
