# shipkit over MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve shipkit's brief, preview and apply as MCP tools over stdio, so one registration per agent per machine replaces a block of prose copied into every repository.

**Architecture:** The MCP layer is a transport and holds no rules. `runSubmit` changes from "returns an exit code, reads a response file" to "returns a structured result, takes a response object"; the CLI keeps reading the file and maps the result to an exit code, and the MCP handlers map the same result to tool content. Preview and apply become two modes of the one function so they cannot disagree.

**Tech Stack:** Node 25, TypeScript strict ESM, commander, zod, vitest, `@modelcontextprotocol/sdk` 1.30.0.

**Spec:** `docs/superpowers/specs/2026-09-11-shipkit-mcp-design.md`

## Global Constraints

- Node 25 + TypeScript strict, ESM — every local import carries a `.js` extension though the sources are `.ts`.
- `console` belongs to `src/cli.ts` alone. Nothing else under `src/` may write to it. The MCP server especially must never write to stdout: stdout **is** the protocol channel, and a stray `console.log` corrupts the stream.
- Typed errors (`ConfigError`, `ResponseError`, `VcsError`, `JiraError`) are the only errors that cross a module boundary. No `process.exit` from library code.
- `validate` and `preflight` stay pure functions over plain data. Only `vcs` and `jira` touch the outside world.
- No test may execute a `git` or `gh` mutation **against this repository**, and no test may call `gh` at all. A test may drive real `git` inside a scratch repository built under `mkdtempSync` and addressed by `cwd` — several already do, and that is the pattern to follow.
- **Never run `shipkit submit`, `shipkit_apply`, or the MCP server against this repository.** It holds real work.
- Touch only this repository. Never `acme/example-app` or any pull request.
- The baseline is 201 passing tests and a clean `npm run check`. Both must hold at the end of every task.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/vcs/github.ts` | gains `cwd` on every exported function | 1 |
| `src/vcs/mutate.ts` | gains `cwd` on every exported function | 1 |
| `src/submit/run.ts` | takes a response object, returns a structured result | 2, 3 |
| `src/cli.ts` | loads the response file, maps the result to an exit code, adds `shipkit mcp` | 2, 3, 6 |
| `src/mcp/result.ts` | shapes a `SubmitResult`/`Brief` into MCP tool content | 4 |
| `src/mcp/tools.ts` | the three tool schemas and their handlers | 5 |
| `src/mcp/server.ts` | constructs the server and serves it over stdio | 6 |

| `tests/submit/run.e2e.test.ts` | drives the real git adapters through one whole sequence | 7 |

Tasks 1–3 are worth doing on their own merits: `cwd` is a live correctness bug, and the structured result is what lets the CLI report more than an exit code. Tasks 4–6 are the transport. Task 7 is the first time the real adapters run together in one sequence, and it depends on Tasks 1–3 rather than on the MCP layer — run it last regardless, so a failure is read against finished code.

---

### Task 1: Thread `cwd` through the gh and git-mutating adapters

`src/vcs/git.ts` already takes `cwd` everywhere. `src/vcs/github.ts` and `src/vcs/mutate.ts` do not — they build their default runner with `execRunner("gh")` / `execRunner("git")` and no directory, so every call inherits `process.cwd()`. For a CLI the user ran after `cd` that is correct. For a server the agent spawned it is not, and it is already wrong today for a CLI invoked through a wrapper that does not change directory.

`execRunner(binary, cwd?)` in `src/vcs/exec.ts` already accepts `cwd`. Nothing there changes.

**Files:**
- Modify: `src/vcs/github.ts`
- Modify: `src/vcs/mutate.ts`
- Modify: `src/cli.ts` (call sites)
- Modify: `src/submit/run.ts` (dep wiring only — the `SubmitDeps` signatures are unchanged; `cli.ts` closes over the repo directory)
- Test: `tests/vcs/github.test.ts`, `tests/vcs/mutate.test.ts`

**Interfaces:**
- Consumes: `execRunner(binary: string, cwd?: string)` from `src/vcs/exec.js`.
- Produces:
  - `defaultBranch(cwd?: string, run?: GhRunner): string`
  - `baseCandidates(cwd?: string, run?: GhRunner): string[]`
  - `findPullRequest(branch: string, cwd?: string, run?: GhRunner): PullRequestState | null`
  - `commitAll(message: string, exclude: string[], cwd?: string, run?: GitRunner): void`
  - `pushBranch(branch: string, cwd?: string, run?: GitRunner): void`
  - `createPullRequest(input: {title,body,base,head}, cwd?: string, run?: GhRunner): string`
  - In every case `cwd` defaults to `process.cwd()` and `run` defaults to a runner built from that `cwd`. TypeScript permits a later parameter's default to refer to an earlier parameter, which is what makes the injected-runner seam survive.

- [ ] **Step 1: Write the failing test**

Add to `tests/vcs/mutate.test.ts`:

```ts
describe("cwd", () => {
  it("builds the default git runner against the directory it was given", () => {
    // Asserting the *default* runner picks up cwd needs the child-process boundary, which
    // this file deliberately never crosses. What is assertable here is that an explicitly
    // injected runner still wins over the cwd argument, so the seam every other test in
    // this file relies on is not quietly broken by the new parameter.
    const seen: string[][] = [];
    commitAll("m", [], "/some/repo", (args) => {
      seen.push(args);
      return "";
    });
    expect(seen).toEqual([
      ["add", "--all"],
      ["commit", "-m", "m"],
    ]);
  });

  it("accepts a cwd for pushBranch without disturbing the argv", () => {
    const seen: string[][] = [];
    pushBranch("feature/x", "/some/repo", (args) => {
      seen.push(args);
      return "";
    });
    expect(seen).toEqual([["push", "--set-upstream", "origin", "--end-of-options", "feature/x"]]);
  });

  it("accepts a cwd for createPullRequest without disturbing the argv", () => {
    const seen: string[][] = [];
    const url = createPullRequest(
      { title: "T", body: "B", base: "develop", head: "feature/x" },
      "/some/repo",
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
});
```

Create `tests/vcs/mutate.cwd.test.ts` — this one *does* cross the child-process boundary, by mocking it, which is the only way to prove `cwd` actually reaches `execFileSync`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

const { commitAll, pushBranch } = await import("../../src/vcs/mutate.js");
const { findPullRequest } = await import("../../src/vcs/github.js");

beforeEach(() => {
  execFileSyncMock.mockReset();
  execFileSyncMock.mockImplementation(() => "");
});

function directories(): (string | undefined)[] {
  return execFileSyncMock.mock.calls.map(
    ([, , options]) => (options as { cwd?: string } | undefined)?.cwd,
  );
}

describe("cwd reaches the child process", () => {
  it("commitAll runs git in the directory it was given", () => {
    commitAll("m", [], "/some/repo");
    expect(directories()).toEqual(["/some/repo", "/some/repo"]);
  });

  it("pushBranch runs git in the directory it was given", () => {
    pushBranch("feature/x", "/some/repo");
    expect(directories()).toEqual(["/some/repo"]);
  });

  it("findPullRequest runs gh in the directory it was given", () => {
    execFileSyncMock.mockImplementation(() => "[]");
    findPullRequest("feature/x", "/some/repo");
    expect(directories()).toEqual(["/some/repo"]);
  });

  // Without this, a default of `process.cwd()` captured at module load would pass every
  // test above while still ignoring the argument in the one case that matters.
  it("uses different directories on different calls", () => {
    pushBranch("a", "/repo/one");
    pushBranch("b", "/repo/two");
    expect(directories()).toEqual(["/repo/one", "/repo/two"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/vcs/mutate.cwd.test.ts`
Expected: FAIL — `commitAll` takes three parameters today, so `"/some/repo"` is passed where the runner belongs and `execFileSync` is never reached with a `cwd`.

- [ ] **Step 3: Add the parameter in `src/vcs/mutate.ts`**

Delete the two module-level constants `defaultGit` and `defaultGh`; a runner built at module load cannot see a per-call directory. Then:

```ts
export function commitAll(
  message: string,
  exclude: string[],
  cwd: string = process.cwd(),
  run: GitRunner = execRunner("git", cwd),
): void {
```

```ts
export function pushBranch(
  branch: string,
  cwd: string = process.cwd(),
  run: GitRunner = execRunner("git", cwd),
): void {
```

```ts
export function createPullRequest(
  input: { title: string; body: string; base: string; head: string },
  cwd: string = process.cwd(),
  run: GhRunner = execRunner("gh", cwd),
): string {
```

Bodies are unchanged.

- [ ] **Step 4: Add the parameter in `src/vcs/github.ts`**

Delete the module-level `defaultRunner`, then:

```ts
export function defaultBranch(
  cwd: string = process.cwd(),
  run: GhRunner = execRunner("gh", cwd),
): string {
```

```ts
export function baseCandidates(
  cwd: string = process.cwd(),
  run: GhRunner = execRunner("gh", cwd),
): string[] {
```

```ts
export function findPullRequest(
  branch: string,
  cwd: string = process.cwd(),
  run: GhRunner = execRunner("gh", cwd),
): PullRequestState | null {
```

`baseCandidates` calls `defaultBranch(run)` today; it becomes `defaultBranch(cwd, run)`.

- [ ] **Step 5: Update the existing test call sites**

Every existing call in `tests/vcs/github.test.ts` and `tests/vcs/mutate.test.ts` passes the runner where `cwd` now sits. Add the directory argument to each: `defaultBranch(run)` becomes `defaultBranch("/repo", run)`, `commitAll("m", [], run)` becomes `commitAll("m", [], "/repo", run)`, and so on. Do not change what any of them assert.

- [ ] **Step 6: Update `src/cli.ts`**

`baseCandidates()` in the `brief` action and every `realSubmitDeps` member that reaches `github.ts` or `mutate.ts` must pass the directory the command is operating on. For the CLI that is `process.cwd()`, so pass it explicitly rather than relying on the default — an explicit value is what Task 5 will replace with the tool's `repo` argument:

```ts
const cwd = process.cwd();
// ...
findPullRequest: (branch) => findPullRequest(branch, cwd),
commitAll: (message, exclude) => commitAll(message, exclude, cwd),
pushBranch: (branch) => pushBranch(branch, cwd),
createPullRequest: (input) => createPullRequest(input, cwd),
```

`SubmitDeps` itself does not change: its members still take no `cwd`, and `cli.ts` closes over one.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run` then `npm run check`
Expected: PASS, 209 tests, no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/vcs tests/vcs src/cli.ts
git commit -m "fix(vcs): let every adapter run git and gh in a given directory"
```

---

### Task 2: `runSubmit` takes a response object and returns a structured result

Two shape changes, no behaviour change. Today `runSubmit` reads the response file itself and returns `0 | 1 | 2`, so the only thing a caller learns is how badly it went. MCP needs the findings, the warnings and the rendered body as data. The CLI needs exactly what it prints today.

Reading the file moves out to `src/cli.ts`, which is where `--input` belongs. `responsePath` stays as an optional field because the staging exclusion needs it — and when MCP passes none, that whole apparatus is skipped rather than fed a value it has to special-case.

**Files:**
- Modify: `src/submit/run.ts`
- Modify: `src/cli.ts`
- Test: `tests/submit/run.test.ts`

**Interfaces:**
- Consumes: `SubmitResponse` from `src/submit/response.js`, `Finding` from `src/validate/types.js`, `Warning` from `src/preflight/types.js`.
- Produces:

```ts
export type SubmitOptions = {
  base: string;
  config: string;
  response: SubmitResponse;
  /** Where the response was read from. Omitted when it never came from a file. */
  responsePath?: string;
  yes: boolean;
};

export type SubmitResult = {
  code: 0 | 1 | 2;
  findings: Finding[];
  warnings: Warning[];
  /** The rendered body, once there is one. Absent when the run failed before rendering. */
  body?: string;
  /** Set when a pull request was opened or updated. */
  url?: string;
  /** True when `url` names a pull request that already existed. */
  updated?: boolean;
  /** A refusal or failure explained in one line. Absent on success. */
  message?: string;
  committed: boolean;
  pushed: boolean;
};

export async function runSubmit(options: SubmitOptions, deps: SubmitDeps): Promise<SubmitResult>;
```

`SubmitDeps` loses its `loadResponse` member. Everything else is unchanged.

- [ ] **Step 1: Write the failing test**

Add to `tests/submit/run.test.ts`:

```ts
describe("runSubmit result shape", () => {
  it("returns the findings as data, not only an exit code", async () => {
    const { deps } = makeDeps({});

    const result = await runSubmit(
      { ...OPTIONS, response: { ...VALID_RESPONSE, title: "nope" } },
      deps,
    );

    expect(result.code).toBe(1);
    expect(result.findings.map((f) => f.rule)).toContain("title-pattern");
    expect(result.warnings).toEqual([]);
    expect(result.committed).toBe(false);
  });

  it("returns the warnings as data when it refuses for want of --yes", async () => {
    const { deps } = makeDeps({
      readUntrackedFiles: () => [".env.local"],
    });

    const result = await runSubmit({ ...OPTIONS, yes: false }, deps);

    expect(result.code).toBe(2);
    expect(result.warnings.map((w) => w.check)).toContain("untracked-files");
    expect(result.committed).toBe(false);
  });

  // The body is what will actually be posted. A caller that cannot see it has to trust
  // that its sections were assembled the way it imagined.
  it("returns the rendered body alongside the findings", async () => {
    const { deps } = makeDeps({});

    const result = await runSubmit(
      { ...OPTIONS, response: { ...VALID_RESPONSE, title: "nope" } },
      deps,
    );

    expect(result.body).toContain("## Summary");
  });

  it("returns the url and marks whether the pull request already existed", async () => {
    const { deps } = makeDeps({});

    const result = await runSubmit(OPTIONS, deps);

    expect(result.code).toBe(0);
    expect(result.url).toBe("https://github.com/x/y/pull/1");
    expect(result.updated).toBe(false);
  });

  it("marks an updated pull request as updated", async () => {
    const { deps } = makeDeps({
      findPullRequest: () => ({
        number: 7,
        url: "https://github.com/x/y/pull/7",
        baseRefName: "develop",
        labels: [],
        approvals: [],
      }),
    });

    const result = await runSubmit(OPTIONS, deps);

    expect(result.code).toBe(0);
    expect(result.url).toBe("https://github.com/x/y/pull/7");
    expect(result.updated).toBe(true);
  });

  // With no path there is no file to keep out of the commit, and the realpath machinery
  // must not run at all — not run and produce an empty answer, but never be reached.
  it("excludes nothing and consults no path when the response came from no file", async () => {
    const { deps, calls } = makeDeps({});

    const result = await runSubmit({ ...OPTIONS, responsePath: undefined }, deps);

    expect(result.code).toBe(0);
    expect(calls.find((c) => c.fn === "commitAll")?.args[1]).toEqual([]);
    expect(calls.some((c) => c.fn === "realpath")).toBe(false);
    expect(calls.some((c) => c.fn === "readRepoRoot")).toBe(false);
  });
});
```

`OPTIONS` at the top of the file changes from `{ input: "irrelevant.json", base, config, yes }` to:

```ts
const OPTIONS = {
  base: "develop",
  config: "tests/fixtures/valid.shipkit.yml",
  response: VALID_RESPONSE,
  responsePath: "/repo/scratch/response.json",
  yes: true,
};
```

Every existing test in the file that overrode `input` now overrides `responsePath`, and every one that overrode `loadResponse` now overrides `response` in the options. Convert them; do not delete them.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/submit/run.test.ts`
Expected: FAIL — `runSubmit` returns a number, so `result.code` is `undefined`.

- [ ] **Step 3: Change the signature and the returns in `src/submit/run.ts`**

Remove `loadResponse` from `SubmitDeps`. Replace `const response = deps.loadResponse(options.input)` with `const response = options.response`.

Every `return` becomes a `SubmitResult`. The `deps.err` / `deps.out` calls stay exactly where they are — the CLI still prints through them, and removing them would silently change what the command shows. Add the data alongside:

```ts
  if (!isValidBase(options.base)) {
    const message = `Refusing to use ${JSON.stringify(options.base)} as a base branch`;
    deps.err(message);
    return { code: 2, findings: [], warnings: [], message, committed: false, pushed: false };
  }
```

```ts
    if (!result.ok) {
      for (const finding of result.findings) {
        deps.err(`${finding.rule}: ${finding.message}`);
      }
      return {
        code: 1,
        findings: result.findings,
        warnings: [],
        body,
        committed: false,
        pushed: false,
      };
    }
```

The exclusion block becomes conditional on the path being present:

```ts
    let relativeToRoot: string | undefined;
    if (options.responsePath !== undefined) {
      try {
        const repoRoot = deps.realpath(deps.readRepoRoot());
        relativeToRoot = relative(repoRoot, deps.realpath(resolve(options.responsePath)))
          .split(sep)
          .join("/");
      } catch {
        throw new ResponseError(
          `Cannot locate the response file at ${options.responsePath} — it was readable a moment ago`,
        );
      }
    }
    const responseInRepo =
      relativeToRoot !== undefined &&
      relativeToRoot.length > 0 &&
      !relativeToRoot.startsWith("..") &&
      !isAbsolute(relativeToRoot);
    const exclude = responseInRepo ? [relativeToRoot as string] : [];
    const untrackedFiles = deps
      .readUntrackedFiles()
      .filter((file) => !responseInRepo || file !== relativeToRoot);
```

The warning refusal:

```ts
    if (warnings.length > 0) {
      for (const warning of warnings) {
        deps.err(`${warning.check}: ${warning.message}`);
      }
      if (!options.yes) {
        const message = "Refusing to proceed. Re-run with --yes to accept these.";
        deps.err(message);
        return { code: 2, findings: [], warnings, body, message, committed: false, pushed: false };
      }
    }
```

The two success returns:

```ts
    if (existingPr !== null) {
      deps.out(existingPr.url);
      deps.err("Pushed to the existing pull request; it was updated, not opened.");
      return {
        code: 0, findings: [], warnings, body,
        url: existingPr.url, updated: true, committed: true, pushed: true,
      };
    }

    const url = deps.createPullRequest({ title: response.title, body, base: options.base, head: branch });
    deps.out(url);
    return {
      code: 0, findings: [], warnings, body,
      url, updated: false, committed: true, pushed: true,
    };
```

And the catch:

```ts
      return { code: 2, findings: [], warnings: [], message: error.message, committed, pushed };
```

- [ ] **Step 4: Update `src/cli.ts`**

The `submit` action reads the file, then maps:

```ts
      const response = loadResponse(options.input);
      const result = await runSubmit(
        {
          base: options.base,
          config: options.config,
          response,
          responsePath: options.input,
          yes: options.yes,
        },
        realSubmitDeps,
      );
      process.exitCode = result.code;
```

`loadResponse` must be called inside the existing `try`, so a `ResponseError` still becomes exit 2 through the same catch. Remove `loadResponse` from `realSubmitDeps`.

- [ ] **Step 5: Run the tests**

Run: `rm -rf dist && npm test` then `npm run check`
Expected: PASS, no type errors. `tests/cli.submit.test.ts` must pass unchanged — the four cases it drives through the real CLI still exit 2, 2, 1, 1.

- [ ] **Step 6: Commit**

```bash
git add src/submit/run.ts src/cli.ts tests/submit/run.test.ts
git commit -m "refactor(submit): return a structured result and take the response as data"
```

---

### Task 3: Preview mode and the acknowledgement gate

The sequence gains a mode. `preview` stops after pre-flight and reports; `apply` continues. One function, one flag, so the two cannot drift into disagreeing about what is wrong with a given answer.

The gate changes shape at the same time. A boolean does not survive contact with an agent: `yes: true` is one more field to fill in, and a model that has decided to proceed will fill it in. Echoing the warning ids costs a caller nothing it should not already have done, proves it received them, and closes again if the situation changed between the two calls.

The CLI keeps its boolean, because a person who typed `--yes` did watch the warnings scroll past. It maps to the literal `"all"`.

**Files:**
- Modify: `src/submit/run.ts`
- Modify: `src/cli.ts`
- Test: `tests/submit/run.test.ts`

**Interfaces:**
- Produces:

```ts
export type Acknowledgement = "all" | string[];

export type SubmitOptions = {
  base: string;
  config: string;
  response: SubmitResponse;
  responsePath?: string;
  mode: "preview" | "apply";
  /** "all" is the CLI's --yes. An array names the check ids the caller has seen. */
  acknowledge: Acknowledgement;
};
```

`yes` is gone. `SubmitResult` is unchanged.

Result codes by situation:

| Situation | `mode` | `code` |
|---|---|---|
| Validation findings | either | 1 |
| Warnings, not all acknowledged | `apply` | 2 |
| Warnings, all acknowledged | `apply` | continues |
| Any outcome after validation passes | `preview` | 0 |

`preview` returns 0 with the warnings attached even when there are warnings: it is reporting, not refusing. Only a validation finding makes a preview non-zero, because that is the answer being wrong rather than the situation being risky.

- [ ] **Step 1: Write the failing test**

```ts
describe("preview mode", () => {
  it("stops after pre-flight and mutates nothing", async () => {
    const { deps, calls } = makeDeps({});

    const result = await runSubmit({ ...OPTIONS, mode: "preview" }, deps);

    expect(result.code).toBe(0);
    expect(result.body).toContain("## Summary");
    expect(calls.some((c) => ["commitAll", "pushBranch", "createPullRequest"].includes(c.fn))).toBe(false);
  });

  it("reports warnings without refusing, because it is not deciding anything", async () => {
    const { deps } = makeDeps({ readUntrackedFiles: () => [".env.local"] });

    const result = await runSubmit({ ...OPTIONS, mode: "preview", acknowledge: [] }, deps);

    expect(result.code).toBe(0);
    expect(result.warnings.map((w) => w.check)).toContain("untracked-files");
  });

  it("still returns 1 for a validation finding", async () => {
    const { deps } = makeDeps({});

    const result = await runSubmit(
      { ...OPTIONS, mode: "preview", response: { ...VALID_RESPONSE, title: "nope" } },
      deps,
    );

    expect(result.code).toBe(1);
  });

  // A preview that disagrees with what apply will do is worse than no preview.
  it("agrees with apply about findings and warnings for the same input", async () => {
    const overrides = { readUntrackedFiles: () => [".env.local"] };
    const previewed = await runSubmit(
      { ...OPTIONS, mode: "preview", acknowledge: [] },
      makeDeps(overrides).deps,
    );
    const applied = await runSubmit(
      { ...OPTIONS, mode: "apply", acknowledge: [] },
      makeDeps(overrides).deps,
    );

    expect(previewed.findings).toEqual(applied.findings);
    expect(previewed.warnings).toEqual(applied.warnings);
  });
});

describe("the acknowledgement gate", () => {
  it("refuses when a warning id was not acknowledged", async () => {
    const { deps, calls } = makeDeps({ readUntrackedFiles: () => [".env.local"] });

    const result = await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: [] }, deps);

    expect(result.code).toBe(2);
    expect(calls.some((c) => c.fn === "commitAll")).toBe(false);
  });

  it("proceeds when every warning id was acknowledged", async () => {
    const { deps, calls } = makeDeps({ readUntrackedFiles: () => [".env.local"] });

    const result = await runSubmit(
      { ...OPTIONS, mode: "apply", acknowledge: ["untracked-files"] },
      deps,
    );

    expect(result.code).toBe(0);
    expect(calls.some((c) => c.fn === "commitAll")).toBe(true);
  });

  // The gate is the whole point of the split: acknowledging one warning must not carry a
  // caller past a different one it never saw.
  it("refuses when one of two warnings was acknowledged", async () => {
    const { deps, calls } = makeDeps({
      readUntrackedFiles: () => [".env.local"],
      findPullRequest: () => ({
        number: 7,
        url: "https://github.com/x/y/pull/7",
        baseRefName: "release/3.76.0",
        labels: [],
        approvals: [],
      }),
    });

    const result = await runSubmit(
      { ...OPTIONS, mode: "apply", acknowledge: ["untracked-files"] },
      deps,
    );

    expect(result.code).toBe(2);
    expect(result.warnings.map((w) => w.check)).toContain("base-mismatch");
    expect(calls.some((c) => c.fn === "commitAll")).toBe(false);
  });

  // Acknowledging an id that is not among the current warnings must not count for anything.
  it("ignores an acknowledgement that names a warning that is not present", async () => {
    const { deps, calls } = makeDeps({ readUntrackedFiles: () => [".env.local"] });

    const result = await runSubmit(
      { ...OPTIONS, mode: "apply", acknowledge: ["approvals-dismissed"] },
      deps,
    );

    expect(result.code).toBe(2);
    expect(calls.some((c) => c.fn === "commitAll")).toBe(false);
  });

  // The property a boolean cannot have. Acknowledging what was true a moment ago must not
  // carry a caller past a situation that has changed since — a review landing or a label
  // being added between the two calls has to close the gate again.
  it("refuses when the situation changed after the ids were acknowledged", async () => {
    const first = makeDeps({ readUntrackedFiles: () => [".env.local"] });
    const previewed = await runSubmit({ ...OPTIONS, mode: "preview", acknowledge: [] }, first.deps);
    const acknowledge = previewed.warnings.map((w) => w.check);
    expect(acknowledge).toEqual(["untracked-files"]);

    // Between the two calls a blocking label appears on the open pull request.
    const second = makeDeps({
      readUntrackedFiles: () => [".env.local"],
      findPullRequest: () => ({
        number: 7,
        url: "https://github.com/x/y/pull/7",
        baseRefName: "develop",
        labels: ["in test"],
        approvals: [],
      }),
      loadConfig: () => loadConfig("tests/fixtures/blocking-labels.shipkit.yml"),
    });

    const result = await runSubmit({ ...OPTIONS, mode: "apply", acknowledge }, second.deps);

    expect(result.code).toBe(2);
    expect(result.warnings.map((w) => w.check)).toContain("blocking-label");
    expect(second.calls.some((c) => c.fn === "commitAll")).toBe(false);
  });

  it("accepts \"all\" as the command line's --yes", async () => {
    const { deps, calls } = makeDeps({ readUntrackedFiles: () => [".env.local"] });

    const result = await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: "all" }, deps);

    expect(result.code).toBe(0);
    expect(calls.some((c) => c.fn === "commitAll")).toBe(true);
  });
});
```

`OPTIONS` gains `mode: "apply"` and replaces `yes: true` with `acknowledge: "all"`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/submit/run.test.ts`
Expected: FAIL — `mode` and `acknowledge` are not read, so preview mutates and the gate lets everything through.

- [ ] **Step 3: Implement in `src/submit/run.ts`**

Replace the warning block:

```ts
    if (warnings.length > 0) {
      for (const warning of warnings) {
        deps.err(`${warning.check}: ${warning.message}`);
      }
    }

    if (options.mode === "preview") {
      return { code: 0, findings: [], warnings, body, committed: false, pushed: false };
    }

    // Echoing the ids, rather than setting a flag, is what makes this a gate. A caller must
    // have received the warnings to name them, and the set is checked against what pre-flight
    // produces now — so if a review landed or a label was added between the two calls, the
    // ids no longer cover the situation and it closes again.
    const unacknowledged =
      options.acknowledge === "all"
        ? []
        : warnings.filter((warning) => !options.acknowledge.includes(warning.check));

    if (unacknowledged.length > 0) {
      const message =
        `Refusing to proceed. Unacknowledged: ${unacknowledged.map((w) => w.check).join(", ")}`;
      deps.err(message);
      return { code: 2, findings: [], warnings, body, message, committed: false, pushed: false };
    }
```

- [ ] **Step 4: Update `src/cli.ts`**

```ts
          mode: "apply",
          acknowledge: options.yes ? "all" : [],
```

The `--yes` flag and its help text are unchanged.

- [ ] **Step 5: Run the tests**

Run: `rm -rf dist && npm test` then `npm run check`
Expected: PASS. `tests/cli.submit.test.ts` unchanged and still passing.

- [ ] **Step 6: Commit**

```bash
git add src/submit/run.ts src/cli.ts tests/submit/run.test.ts
git commit -m "feat(submit): add preview mode and gate apply on acknowledged warnings"
```

---

### Task 4: Shape results into MCP tool content

A pure module, no SDK import, no I/O. It turns a `SubmitResult` or a `Brief` into the text an agent reads and the structured data it acts on.

A validation failure is an answer to the question the agent asked, not a malfunction. It is returned as content, never thrown — an agent that receives a protocol fault learns nothing it can act on.

**Files:**
- Create: `src/mcp/result.ts`
- Test: `tests/mcp/result.test.ts`

**Interfaces:**
- Consumes: `SubmitResult` from `src/submit/run.js`, `Brief` from `src/brief/types.js`.
- Produces:

```ts
export type ToolContent = {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError: boolean;
};

export function briefContent(brief: Brief): ToolContent;
export function previewContent(result: SubmitResult): ToolContent;
export function applyContent(result: SubmitResult): ToolContent;
export function failureContent(message: string): ToolContent;
```

- [ ] **Step 1: Write the failing test**

`tests/mcp/result.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyContent, briefContent, failureContent, previewContent } from "../../src/mcp/result.js";
import type { SubmitResult } from "../../src/submit/run.js";
import type { Brief } from "../../src/brief/types.js";

const BRIEF: Brief = {
  change: { branch: "bugfix/x/1-y", files: ["a.ts"], diffstat: "1 file", commits: ["fix: y"] },
  target: { branch: "develop", reason: "given" },
  template: { sections: [{ name: "Summary", required: true }] },
  rules: {
    titlePattern: "^x", branchPattern: "^y", keyPattern: "DCP-\\d+",
    forbidden: ["TBD"], issuesSection: "Issues Addressed", linkPolicy: "story",
  },
};

const OK: SubmitResult = {
  code: 0, findings: [], warnings: [], body: "## Summary\n\ns\n",
  url: "https://example.com/pr/1", updated: false, committed: true, pushed: true,
};

describe("briefContent", () => {
  it("carries the brief as structured data, not only as prose", () => {
    expect(briefContent(BRIEF).structuredContent).toEqual(BRIEF as unknown as Record<string, unknown>);
  });

  it("is not an error", () => {
    expect(briefContent(BRIEF).isError).toBe(false);
  });
});

describe("previewContent", () => {
  it("returns the body so the caller can see what would be posted", () => {
    const shaped = previewContent({ ...OK, url: undefined, committed: false, pushed: false });
    expect(shaped.structuredContent.body).toBe("## Summary\n\ns\n");
  });

  it("names every warning id, because those ids are what apply will ask for", () => {
    const shaped = previewContent({
      code: 0, findings: [],
      warnings: [
        { check: "untracked-files", message: "two files" },
        { check: "base-mismatch", message: "targets develop" },
      ],
      body: "b", committed: false, pushed: false,
    });
    expect(shaped.structuredContent.warnings).toEqual(["untracked-files", "base-mismatch"]);
    expect(shaped.content[0].text).toContain("untracked-files");
    expect(shaped.content[0].text).toContain("base-mismatch");
  });

  // A preview reports; it never refuses. Only a wrong answer makes it an error.
  it("is not an error when there are warnings", () => {
    const shaped = previewContent({
      code: 0, findings: [], warnings: [{ check: "untracked-files", message: "m" }],
      body: "b", committed: false, pushed: false,
    });
    expect(shaped.isError).toBe(false);
  });

  it("is an error when the answer does not validate", () => {
    const shaped = previewContent({
      code: 1, findings: [{ rule: "title-pattern", message: "bad" }], warnings: [],
      body: "b", committed: false, pushed: false,
    });
    expect(shaped.isError).toBe(true);
    expect(shaped.content[0].text).toContain("title-pattern");
  });
});

describe("applyContent", () => {
  it("returns the url and whether the pull request already existed", () => {
    const shaped = applyContent(OK);
    expect(shaped.isError).toBe(false);
    expect(shaped.structuredContent.url).toBe("https://example.com/pr/1");
    expect(shaped.structuredContent.updated).toBe(false);
  });

  // The ids are the actionable part: they are exactly what has to come back in acknowledge.
  it("tells a refused caller which ids to acknowledge", () => {
    const shaped = applyContent({
      code: 2, findings: [],
      warnings: [{ check: "untracked-files", message: "m" }],
      body: "b", message: "Refusing to proceed. Unacknowledged: untracked-files",
      committed: false, pushed: false,
    });
    expect(shaped.isError).toBe(true);
    expect(shaped.structuredContent.warnings).toEqual(["untracked-files"]);
    expect(shaped.content[0].text).toContain("acknowledge");
  });

  // Half-done is the state a caller most needs told, and the one it is least likely to guess.
  it("says what was left behind when the sequence failed part way", () => {
    const shaped = applyContent({
      code: 2, findings: [], warnings: [], body: "b",
      message: "git push failed: rejected", committed: true, pushed: false,
    });
    expect(shaped.isError).toBe(true);
    expect(shaped.structuredContent.committed).toBe(true);
    expect(shaped.structuredContent.pushed).toBe(false);
    expect(shaped.content[0].text).toContain("commit");
  });
});

describe("failureContent", () => {
  it("reports a message as content rather than as a thrown fault", () => {
    const shaped = failureContent("Cannot read .shipkit.yml");
    expect(shaped.isError).toBe(true);
    expect(shaped.content[0].text).toContain("Cannot read .shipkit.yml");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mcp/result.test.ts`
Expected: FAIL — cannot resolve `../../src/mcp/result.js`.

- [ ] **Step 3: Write `src/mcp/result.ts`**

```ts
import type { Brief } from "../brief/types.js";
import type { SubmitResult } from "../submit/run.js";

export type ToolContent = {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError: boolean;
};

function text(lines: string[], structured: Record<string, unknown>, isError: boolean): ToolContent {
  return {
    content: [{ type: "text", text: lines.filter(Boolean).join("\n") }],
    structuredContent: structured,
    isError,
  };
}

export function briefContent(brief: Brief): ToolContent {
  return text(
    [
      `Target: ${brief.target.branch} (${brief.target.reason})`,
      `Sections to fill: ${brief.template.sections.map((s) => s.name).join(", ")}`,
      `Title must match: ${brief.rules.titlePattern}`,
    ],
    brief as unknown as Record<string, unknown>,
    false,
  );
}

function warningIds(result: SubmitResult): string[] {
  return result.warnings.map((warning) => warning.check);
}

function findingLines(result: SubmitResult): string[] {
  return result.findings.map((finding) => `${finding.rule}: ${finding.message}`);
}

function warningLines(result: SubmitResult): string[] {
  return result.warnings.map((warning) => `${warning.check}: ${warning.message}`);
}

export function previewContent(result: SubmitResult): ToolContent {
  const structured = {
    findings: findingLines(result),
    warnings: warningIds(result),
    body: result.body ?? "",
  };

  if (result.code === 1) {
    return text(
      ["The answer does not comply. Nothing was changed.", ...findingLines(result)],
      structured,
      true,
    );
  }

  return text(
    [
      result.warnings.length === 0
        ? "Ready to apply. No warnings."
        : "Ready to apply, with warnings. Pass these ids to shipkit_apply as acknowledge:",
      ...warningLines(result),
    ],
    structured,
    false,
  );
}

export function applyContent(result: SubmitResult): ToolContent {
  const structured: Record<string, unknown> = {
    findings: findingLines(result),
    warnings: warningIds(result),
    committed: result.committed,
    pushed: result.pushed,
  };
  if (result.body !== undefined) structured.body = result.body;
  if (result.url !== undefined) structured.url = result.url;
  if (result.updated !== undefined) structured.updated = result.updated;

  if (result.code === 0) {
    return text(
      [result.updated === true ? `Updated ${result.url}` : `Opened ${result.url}`],
      structured,
      false,
    );
  }

  const lines = [result.message ?? "Refused.", ...findingLines(result), ...warningLines(result)];

  if (result.warnings.length > 0 && result.findings.length === 0) {
    lines.push(
      `Call again with acknowledge: [${warningIds(result).map((id) => `"${id}"`).join(", ")}] to proceed.`,
    );
  }

  // Half-done is the state a caller is least likely to guess and most needs told.
  if (result.committed) {
    lines.push(
      result.pushed
        ? "A commit was created and pushed; no pull request was opened."
        : "A commit was created locally and has not been pushed.",
    );
  }

  return text(lines, structured, true);
}

export function failureContent(message: string): ToolContent {
  return text([message], { message }, true);
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/mcp/result.test.ts`
Expected: PASS — 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/result.ts tests/mcp/result.test.ts
git commit -m "feat(mcp): shape results into tool content"
```

---

### Task 5: The three tool handlers

Handlers, not a server. They take validated arguments and a dependency object, call the core, and return `ToolContent`. No SDK import here either — that keeps them testable with plain calls and keeps the SDK confined to one file.

**Files:**
- Create: `src/mcp/tools.ts`
- Test: `tests/mcp/tools.test.ts`

**Interfaces:**
- Consumes: `runSubmit`/`SubmitDeps`/`SubmitOptions` from `src/submit/run.js`, `assembleBrief` from `src/brief/assemble.js`, the shapers from `src/mcp/result.js`, `loadConfig` from `src/config/load.js`, `readRepoState`/`currentBranch` from `src/vcs/git.js`.
- Produces:

```ts
export type ToolDeps = {
  /** Builds the submit dependency object bound to one repository directory. */
  submitDeps: (repo: string) => SubmitDeps;
  loadConfig: (path: string) => ShipkitConfig;
  readRepoState: (base: string, cwd: string) => RepoState;
  runSubmit: (options: SubmitOptions, deps: SubmitDeps) => Promise<SubmitResult>;
};

export type BriefArgs = { repo: string; base: string; config?: string };
export type SubmitArgs = {
  repo: string; base: string; config?: string;
  title: string; commitMessage: string; sections: Record<string, string>;
  acknowledge?: string[];
};

export function configPath(args: { repo: string; config?: string }): string;
export async function handleBrief(args: BriefArgs, deps: ToolDeps): Promise<ToolContent>;
export async function handlePreview(args: SubmitArgs, deps: ToolDeps): Promise<ToolContent>;
export async function handleApply(args: SubmitArgs, deps: ToolDeps): Promise<ToolContent>;
```

- [ ] **Step 1: Write the failing test**

`tests/mcp/tools.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { configPath, handleApply, handleBrief, handlePreview } from "../../src/mcp/tools.js";
import type { ToolDeps } from "../../src/mcp/tools.js";
import { loadConfig } from "../../src/config/load.js";
import type { SubmitOptions, SubmitResult, SubmitDeps } from "../../src/submit/run.js";

const CONFIG = loadConfig("tests/fixtures/valid.shipkit.yml");

const ARGS = {
  repo: "/repo",
  base: "develop",
  title: "[ABC-1] fix(x): y",
  commitMessage: "fix(x): y",
  sections: { Summary: "s" },
};

function makeDeps(over: Partial<ToolDeps> = {}) {
  const seen: SubmitOptions[] = [];
  const repos: string[] = [];
  const deps: ToolDeps = {
    submitDeps: (repo: string) => {
      repos.push(repo);
      return {} as SubmitDeps;
    },
    loadConfig: () => CONFIG,
    readRepoState: () => ({ branch: "bugfix/x/1-y", changedFiles: [], diffstat: "", commits: [] }),
    runSubmit: async (options: SubmitOptions) => {
      seen.push(options);
      return {
        code: 0, findings: [], warnings: [], body: "## Summary\n\ns\n",
        url: "https://example.com/pr/1", updated: false, committed: true, pushed: true,
      } satisfies SubmitResult;
    },
    ...over,
  };
  return { deps, seen, repos };
}

describe("configPath", () => {
  it("defaults to .shipkit.yml at the repository root", () => {
    expect(configPath({ repo: "/repo" })).toBe("/repo/.shipkit.yml");
  });

  it("uses an explicit config as given", () => {
    expect(configPath({ repo: "/repo", config: "/elsewhere/x.yml" })).toBe("/elsewhere/x.yml");
  });
});

describe("handleBrief", () => {
  it("reads the repository the caller named, not the process directory", async () => {
    const { deps, repos } = makeDeps();
    let seenCwd = "";
    deps.readRepoState = (_base: string, cwd: string) => {
      seenCwd = cwd;
      return { branch: "bugfix/x/1-y", changedFiles: [], diffstat: "", commits: [] };
    };

    await handleBrief({ repo: "/repo", base: "develop" }, deps);

    expect(seenCwd).toBe("/repo");
  });

  it("returns the brief as structured content", async () => {
    const { deps } = makeDeps();
    const shaped = await handleBrief({ repo: "/repo", base: "develop" }, deps);
    expect(shaped.isError).toBe(false);
    expect(shaped.structuredContent).toHaveProperty("template");
  });

  it("reports a bad config as content rather than throwing", async () => {
    const { deps } = makeDeps({
      loadConfig: () => {
        throw new Error("boom");
      },
    });
    await expect(handleBrief({ repo: "/repo", base: "develop" }, deps)).resolves.toMatchObject({
      isError: true,
    });
  });
});

describe("handlePreview", () => {
  it("runs in preview mode and passes no response path", async () => {
    const { deps, seen } = makeDeps();

    await handlePreview(ARGS, deps);

    expect(seen[0].mode).toBe("preview");
    expect(seen[0].responsePath).toBeUndefined();
  });

  it("binds the submit dependencies to the repository the caller named", async () => {
    const { deps, repos } = makeDeps();
    await handlePreview(ARGS, deps);
    expect(repos).toEqual(["/repo"]);
  });

  // Preview must never be able to act, whatever it is handed.
  it("ignores an acknowledge argument", async () => {
    const { deps, seen } = makeDeps();
    await handlePreview({ ...ARGS, acknowledge: ["untracked-files"] }, deps);
    expect(seen[0].mode).toBe("preview");
  });
});

describe("handleApply", () => {
  it("runs in apply mode and forwards the acknowledged ids", async () => {
    const { deps, seen } = makeDeps();

    await handleApply({ ...ARGS, acknowledge: ["untracked-files"] }, deps);

    expect(seen[0].mode).toBe("apply");
    expect(seen[0].acknowledge).toEqual(["untracked-files"]);
  });

  // A missing acknowledge must mean "nothing acknowledged", never "everything".
  it("treats a missing acknowledge as an empty list, not as all", async () => {
    const { deps, seen } = makeDeps();

    await handleApply(ARGS, deps);

    expect(seen[0].acknowledge).toEqual([]);
  });

  it("reports a thrown adapter failure as content rather than throwing", async () => {
    const { deps } = makeDeps({
      runSubmit: () => Promise.reject(new Error("gh exploded")),
    });
    await expect(handleApply(ARGS, deps)).resolves.toMatchObject({ isError: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mcp/tools.test.ts`
Expected: FAIL — cannot resolve `../../src/mcp/tools.js`.

- [ ] **Step 3: Write `src/mcp/tools.ts`**

```ts
import { join } from "node:path";
import { assembleBrief } from "../brief/assemble.js";
import type { ShipkitConfig } from "../config/schema.js";
import { briefContent, failureContent, applyContent, previewContent } from "./result.js";
import type { ToolContent } from "./result.js";
import type { SubmitDeps, SubmitOptions, SubmitResult } from "../submit/run.js";
import type { RepoState } from "../vcs/types.js";

export type ToolDeps = {
  submitDeps: (repo: string) => SubmitDeps;
  loadConfig: (path: string) => ShipkitConfig;
  readRepoState: (base: string, cwd: string) => RepoState;
  runSubmit: (options: SubmitOptions, deps: SubmitDeps) => Promise<SubmitResult>;
};

export type BriefArgs = { repo: string; base: string; config?: string };

export type SubmitArgs = {
  repo: string;
  base: string;
  config?: string;
  title: string;
  commitMessage: string;
  sections: Record<string, string>;
  acknowledge?: string[];
};

export function configPath(args: { repo: string; config?: string }): string {
  return args.config ?? join(args.repo, ".shipkit.yml");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function handleBrief(args: BriefArgs, deps: ToolDeps): Promise<ToolContent> {
  try {
    const config = deps.loadConfig(configPath(args));
    const repo = deps.readRepoState(args.base, args.repo);
    return briefContent(
      assembleBrief({
        repo,
        target: { branch: args.base, reason: "given by the caller" },
        config,
      }),
    );
  } catch (error) {
    return failureContent(describe(error));
  }
}

async function run(
  args: SubmitArgs,
  deps: ToolDeps,
  mode: "preview" | "apply",
): Promise<SubmitResult> {
  return deps.runSubmit(
    {
      base: args.base,
      config: configPath(args),
      response: {
        title: args.title,
        commitMessage: args.commitMessage,
        sections: args.sections,
      },
      // No file, so nothing to keep out of the commit — the whole staging-exclusion
      // apparatus the CLI needs is skipped rather than handed a value to special-case.
      responsePath: undefined,
      mode,
      // A missing acknowledge means nothing was acknowledged. Defaulting it to "all" would
      // turn the gate into a formality the caller never has to notice.
      acknowledge: mode === "apply" ? (args.acknowledge ?? []) : [],
    },
    deps.submitDeps(args.repo),
  );
}

export async function handlePreview(args: SubmitArgs, deps: ToolDeps): Promise<ToolContent> {
  try {
    return previewContent(await run(args, deps, "preview"));
  } catch (error) {
    return failureContent(describe(error));
  }
}

export async function handleApply(args: SubmitArgs, deps: ToolDeps): Promise<ToolContent> {
  try {
    return applyContent(await run(args, deps, "apply"));
  } catch (error) {
    return failureContent(describe(error));
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/mcp/tools.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts tests/mcp/tools.test.ts
git commit -m "feat(mcp): the brief, preview and apply handlers"
```

---

### Task 6: The server and the `shipkit mcp` subcommand

The only file that imports the SDK. It registers three tools with zod schemas, wires the real adapters bound to the `repo` argument, and serves over stdio.

**Files:**
- Modify: `package.json` (add `@modelcontextprotocol/sdk`)
- Create: `src/mcp/server.ts`
- Modify: `src/cli.ts` (add the `mcp` subcommand)
- Test: `tests/mcp/server.test.ts`

**Interfaces:**
- Consumes: the handlers and `ToolDeps` from `src/mcp/tools.js`.
- Produces:
  - `export function createServer(deps: ToolDeps): McpServer`
  - `export function realToolDeps(): ToolDeps`
  - `export async function serveStdio(): Promise<void>`

- [ ] **Step 1: Add the dependency**

```bash
npm install @modelcontextprotocol/sdk@1.30.0
```

- [ ] **Step 2: Write the failing test**

`tests/mcp/server.test.ts`. This drives the server in memory — no subprocess, no stdio, no git:

```ts
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/mcp/server.js";
import type { ToolDeps } from "../../src/mcp/tools.js";
import { loadConfig } from "../../src/config/load.js";
import type { SubmitDeps, SubmitOptions, SubmitResult } from "../../src/submit/run.js";

const CONFIG = loadConfig("tests/fixtures/valid.shipkit.yml");

function fakeDeps(seen: SubmitOptions[]): ToolDeps {
  return {
    submitDeps: () => ({}) as SubmitDeps,
    loadConfig: () => CONFIG,
    readRepoState: () => ({ branch: "bugfix/x/1-y", changedFiles: [], diffstat: "", commits: [] }),
    runSubmit: async (options: SubmitOptions) => {
      seen.push(options);
      return {
        code: 0, findings: [], warnings: [], body: "## Summary\n\ns\n",
        url: "https://example.com/pr/1", updated: false, committed: true, pushed: true,
      } satisfies SubmitResult;
    },
  };
}

async function connect(seen: SubmitOptions[]) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(fakeDeps(seen));
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("the MCP server", () => {
  it("offers exactly the three tools", async () => {
    const client = await connect([]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "shipkit_apply",
      "shipkit_brief",
      "shipkit_preview",
    ]);
  });

  // The description is the only thing that tells an agent when to reach for the tool. A
  // registered tool nobody knows to call is the problem this whole design exists to fix.
  it("describes every tool", async () => {
    const client = await connect([]);
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.description ?? "").not.toBe("");
    }
  });

  // The spec said a missing base should come back naming the plausible targets. It is a
  // required schema field instead, and the description carries the instruction: the choice
  // depends on release timing, so it belongs to the human, and handing an agent a list to
  // pick from invites it to pick. A schema error plus "ask" is the honest shape.
  it("tells the caller to ask which branch to target rather than choosing one", async () => {
    const client = await connect([]);
    const { tools } = await client.listTools();
    const brief = tools.find((t) => t.name === "shipkit_brief");
    expect(brief?.description ?? "").toContain("Ask");
  });

  it("requires repo and base on every tool", async () => {
    const client = await connect([]);
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.inputSchema.required).toContain("repo");
      expect(tool.inputSchema.required).toContain("base");
    }
  });

  it("routes a preview call through to the core in preview mode", async () => {
    const seen: SubmitOptions[] = [];
    const client = await connect(seen);

    await client.callTool({
      name: "shipkit_preview",
      arguments: {
        repo: "/repo", base: "develop",
        title: "[ABC-1] fix(x): y", commitMessage: "fix(x): y",
        sections: { Summary: "s" },
      },
    });

    expect(seen[0].mode).toBe("preview");
  });

  it("rejects a call that omits a required argument", async () => {
    const client = await connect([]);
    const result = await client.callTool({
      name: "shipkit_preview",
      arguments: { repo: "/repo" },
    });
    expect(result.isError).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/mcp/server.test.ts`
Expected: FAIL — cannot resolve `../../src/mcp/server.js`.

- [ ] **Step 4: Write `src/mcp/server.ts`**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { z } from "zod";
import { loadConfig } from "../config/load.js";
import { resolveIssue } from "../cli-support.js";
import { renderBody } from "../submit/response.js";
import { runSubmit } from "../submit/run.js";
import type { SubmitDeps } from "../submit/run.js";
import {
  currentBranch,
  readRepoRoot,
  readRepoState,
  readUntrackedFiles,
} from "../vcs/git.js";
import { findPullRequest } from "../vcs/github.js";
import { commitAll, createPullRequest, pushBranch } from "../vcs/mutate.js";
import { handleApply, handleBrief, handlePreview } from "./tools.js";
import type { ToolDeps } from "./tools.js";

const repoAndBase = {
  repo: z.string().describe("Absolute path to the repository to act on"),
  base: z.string().describe("Branch the pull request targets, e.g. develop"),
  config: z.string().optional().describe("Path to .shipkit.yml; defaults to <repo>/.shipkit.yml"),
};

const answer = {
  title: z.string().describe("Pull-request title, matching the brief's titlePattern"),
  commitMessage: z.string().describe("Commit message: subject, then an optional body"),
  sections: z
    .record(z.string(), z.string())
    .describe("One entry per section named in the brief, spelled exactly"),
};

export function realToolDeps(): ToolDeps {
  return {
    loadConfig,
    readRepoState: (base, cwd) => readRepoState(base, cwd),
    runSubmit,
    submitDeps: (repo: string): SubmitDeps => ({
      loadConfig,
      renderBody,
      currentBranch: () => currentBranch(repo),
      resolveIssue,
      readRepoState: (base) => readRepoState(base, repo),
      findPullRequest: (branch) => findPullRequest(branch, repo),
      readUntrackedFiles: () => readUntrackedFiles(repo),
      readRepoRoot: () => readRepoRoot(repo),
      realpath: (path) => realpathSync(path),
      commitAll: (message, exclude) => commitAll(message, exclude, repo),
      pushBranch: (branch) => pushBranch(branch, repo),
      createPullRequest: (input) => createPullRequest(input, repo),
      // stdout is the protocol channel. Anything written to it corrupts the stream, so the
      // sequence's output is discarded here and returned as tool content instead.
      out: () => undefined,
      err: () => undefined,
    }),
  };
}

export function createServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: "shipkit", version: "0.1.0" });

  server.registerTool(
    "shipkit_brief",
    {
      description:
        "Read this repository's pull-request conventions and the facts about the current " +
        "change before writing a pull request. Returns the sections to fill, a hint for " +
        "each, and the rules the answer must satisfy. Changes nothing. Ask the human which " +
        "branch to target before calling this; release timing decides it and the repository " +
        "does not record it, so it is not yours to infer.",
      inputSchema: repoAndBase,
    },
    async (args) => handleBrief(args, deps),
  );

  server.registerTool(
    "shipkit_preview",
    {
      description:
        "Check a drafted pull-request title, commit message and sections against this " +
        "repository's conventions. Returns what is wrong, what is risky, and the body " +
        "that would be posted. Changes nothing. Run this before shipkit_apply.",
      inputSchema: { ...repoAndBase, ...answer },
    },
    async (args) => handlePreview(args, deps),
  );

  server.registerTool(
    "shipkit_apply",
    {
      description:
        "Commit, push, and open or update the pull request. Refuses if the answer does " +
        "not comply. If pre-flight warns, it refuses until every warning id it reports is " +
        "passed back in acknowledge — get those ids from shipkit_preview and show them to " +
        "the human before acknowledging.",
      inputSchema: {
        ...repoAndBase,
        ...answer,
        acknowledge: z
          .array(z.string())
          .optional()
          .describe("Check ids of the pre-flight warnings you have seen and accepted"),
      },
    },
    async (args) => handleApply(args, deps),
  );

  return server;
}

export async function serveStdio(): Promise<void> {
  await createServer(realToolDeps()).connect(new StdioServerTransport());
}
```

- [ ] **Step 5: Add the subcommand to `src/cli.ts`**

```ts
program
  .command("mcp")
  .description("Serve the shipkit tools to an agent over stdio")
  .action(async () => {
    const { serveStdio } = await import("./mcp/server.js");
    await serveStdio();
  });
```

The dynamic import keeps the SDK off the startup path of every other command.

- [ ] **Step 6: Run the tests**

Run: `rm -rf dist && npm test` then `npm run check`
Expected: PASS, no type errors.

- [ ] **Step 7: Confirm the subcommand is registered without running the server**

Run: `node dist/cli.js --help`
Expected: `mcp` appears in the command list.

Do **not** run `node dist/cli.js mcp`. It blocks on stdin waiting for a protocol client, and the tools it serves act on a repository.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/mcp/server.ts src/cli.ts tests/mcp/server.test.ts
git commit -m "feat(mcp): serve the tools over stdio behind shipkit mcp"
```

---

---

### Task 7: One end-to-end run against a real repository

Every test so far fakes the adapters. Nothing has ever driven `commitAll`, `pushBranch`,
`readUntrackedFiles` and `readRepoRoot` together, for real, in one sequence — so nothing
proves the pieces agree about paths, directories and ordering outside the fixtures that
were written to suit them.

This test builds a scratch repository with a local bare remote, runs the real git
adapters through `runSubmit`, and fakes only the two that reach `gh`. `git push` to a
local bare repository is a genuine push; `gh pr create` cannot be faked with a directory,
so it is injected.

**Files:**
- Test: `tests/submit/run.e2e.test.ts`

**Interfaces:**
- Consumes: `runSubmit` and `SubmitDeps` from `src/submit/run.js`, the real adapters from `src/vcs/git.js` and `src/vcs/mutate.js`, `loadConfig`, `renderBody`, `resolveIssue`.

- [ ] **Step 1: Write the failing test**

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { resolveIssue } from "../../src/cli-support.js";
import { renderBody } from "../../src/submit/response.js";
import { runSubmit, type SubmitDeps } from "../../src/submit/run.js";
import {
  currentBranch,
  readRepoRoot,
  readRepoState,
  readUntrackedFiles,
} from "../../src/vcs/git.js";
import { commitAll, createPullRequest, pushBranch } from "../../src/vcs/mutate.js";

const CONFIG = resolve("tests/fixtures/valid.shipkit.yml");

const RESPONSE = {
  title: "[ABC-1] fix(x): y",
  commitMessage: "fix(x): y",
  sections: {
    Summary: "It was broken; now it is not.",
    "Screenshots / Screen Recordings": "Nothing to show - logic only.",
    "What to Test": "- one\n- two\n- three",
    "Issues Addressed": "- [ABC-1](https://jira.example.com/browse/ABC-1)",
  },
};

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

/** A scratch repository on a branch the fixture's branch.pattern accepts, with a local
 *  bare remote so `git push` is a real push rather than a mock. */
function scratch(): { repo: string; remote: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "shipkit-e2e-")));
  const remote = join(root, "remote.git");
  const repo = join(root, "work");

  execFileSync("git", ["init", "--bare", "-b", "develop", remote], { stdio: "pipe" });
  execFileSync("git", ["init", "-b", "develop", repo], { stdio: "pipe" });
  git(["config", "user.email", "t@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  git(["remote", "add", "origin", remote], repo);

  writeFileSync(join(repo, "app.ts"), "export const a = 1;\n", "utf8");
  git(["add", "--all"], repo);
  git(["commit", "-m", "init"], repo);
  git(["push", "--set-upstream", "origin", "develop"], repo);

  git(["checkout", "-b", "bugfix/squadb/1-invoice"], repo);
  writeFileSync(join(repo, "app.ts"), "export const a = 2;\n", "utf8");

  return { repo, remote };
}

function realDeps(repo: string, opened: { input?: unknown }): SubmitDeps {
  return {
    loadConfig,
    renderBody,
    currentBranch: () => currentBranch(repo),
    resolveIssue,
    readRepoState: (base) => readRepoState(base, repo),
    // gh cannot be pointed at a local bare repository, so the two adapters that reach it
    // are the only fakes here. Everything else is the real thing.
    findPullRequest: () => null,
    readUntrackedFiles: () => readUntrackedFiles(repo),
    readRepoRoot: () => readRepoRoot(repo),
    realpath: (path) => realpathSync(path),
    commitAll: (message, exclude) => commitAll(message, exclude, repo),
    pushBranch: (branch) => pushBranch(branch, repo),
    createPullRequest: (input) => {
      opened.input = input;
      return "https://example.com/pr/1";
    },
    out: () => undefined,
    err: () => undefined,
  };
}

describe("runSubmit end to end", () => {
  it("commits the work, keeps the response file out, and really pushes", async () => {
    const { repo } = scratch();
    // The response file sits in the repository, as it does in a real run.
    const responsePath = join(repo, "response.json");
    writeFileSync(responsePath, JSON.stringify(RESPONSE), "utf8");
    // And so does something the author never meant to commit.
    writeFileSync(join(repo, ".env.local"), "SECRET=1\n", "utf8");

    const opened: { input?: unknown } = {};
    const result = await runSubmit(
      {
        base: "develop",
        config: CONFIG,
        response: RESPONSE,
        responsePath,
        mode: "apply",
        acknowledge: "all",
      },
      realDeps(repo, opened),
    );

    expect(result.code).toBe(0);
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);

    const committed = execFileSync(
      "git",
      ["show", "--name-only", "--format=", "HEAD"],
      { cwd: repo, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(committed).toEqual([".env.local", "app.ts"]);
    expect(committed).not.toContain("response.json");

    // The push reached the remote, not just the local ref.
    const remoteBranches = execFileSync(
      "git",
      ["ls-remote", "--heads", "origin", "bugfix/squadb/1-invoice"],
      { cwd: repo, encoding: "utf8" },
    );
    expect(remoteBranches).toContain("bugfix/squadb/1-invoice");

    // And the body that reached the forge is the one the config describes.
    expect((opened.input as { body: string }).body).toContain("## What to Test");
  });

  it("previews the same repository without leaving a trace", async () => {
    const { repo } = scratch();
    const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });

    const opened: { input?: unknown } = {};
    const result = await runSubmit(
      { base: "develop", config: CONFIG, response: RESPONSE, mode: "preview", acknowledge: [] },
      realDeps(repo, opened),
    );

    expect(result.code).toBe(0);
    expect(result.body).toContain("## Summary");
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" })).toBe(before);
    expect(opened.input).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/submit/run.e2e.test.ts`
Expected: FAIL before Tasks 1–3 land; after them it should pass, so run it once and read the failure carefully — if it fails for a reason other than a missing symbol, that is a real disagreement between the adapters and is what this task exists to surface.

- [ ] **Step 3: Fix whatever it surfaces**

Do not adjust the test's expectations to match what the code does. `.env.local` being committed is the documented behaviour: staging sweeps in untracked files and pre-flight warns about them, which `acknowledge: "all"` accepted. `response.json` staying out is the exclusion working. If either disagrees, the code is wrong, not the test.

- [ ] **Step 4: Confirm this repository was untouched**

Run: `git status --porcelain` and `git log --oneline -1`
Expected: clean, and the last commit is yours. Every commit and push the test performed happened inside a temporary directory.

- [ ] **Step 5: Commit**

```bash
git add tests/submit/run.e2e.test.ts
git commit -m "test(submit): drive the real adapters through one end-to-end run"
```

## Done when

- `npm test` passes from a clean checkout and `npm run check` reports no type errors.
- `shipkit_preview` changes nothing, whatever it is passed.
- `shipkit_apply` refuses on any validation finding, and on any warning whose id is not in `acknowledge`.
- Every adapter runs `git` and `gh` in the directory it was given, and the MCP handlers give it the caller's `repo`.
- No test starts a stdio server and no test calls `gh`. The one test that mutates with `git` does so inside a temporary directory, against a local bare remote.
- `git status` is clean after the suite runs.

## Next

- **`commitPattern`.** `commitMessage` is validated only as a non-empty string, so the base design's first goal has nothing behind it. Independent of MCP and small: a config field and a rule.
- **`init`.** MCP carries the tool everywhere but not the rules; `.shipkit.yml` still has to reach each repository.
- **Homebrew.** A tap, and a formula that either depends on node or ships a compiled binary. Worth doing once the tools have been used against a real repository.
- **Registration, verified.** The exact `claude mcp add` and `~/.codex/config.toml` syntax, checked against the installed versions rather than written from memory, folded into `docs/integration/`.
