# shipkit init Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `shipkit init` writes a reviewable `.shipkit.yml` for a repository that has none, filling in what it can prove from the forge and proposing the rest.

**Architecture:** A new pure `src/infer/` module turns recorded forge payloads and merged pull-request bodies into config fragments, each tagged with where it came from. A thin `src/init/run.ts` gathers those inputs through injected adapters, renders commented YAML, and refuses to overwrite. Every inference is a pure function over plain data; only the gather step touches `gh`.

**Tech Stack:** Node 25, TypeScript strict ESM (local imports carry `.js`), zod, yaml, vitest, commander.

**Spec:** `docs/superpowers/specs/2026-09-10-shipkit-design.md` — the "### `shipkit init`" and "### Why the template cannot be inferred" sections.

## Global Constraints

- Touch only this repository. Never another repo, never a pull request, never a push.
- **No test may invoke `gh`, `git push`, or any network call.** Inference is pure functions over fixtures; the gather step is injected.
- Do not call `gh` against `git.example.com` during development. That server hosts `example-app`, which is out of bounds. Fixtures are hand-authored from the published GitHub REST schema — see "A limitation to be honest about" below.
- Never run `shipkit submit`, `node dist/cli.js mcp`, or any MCP tool against this repository.
- `npm test` must stay green (400 passing before this plan) and `npm run check` clean.
- Local imports end in `.js`. Match the surrounding code's comment density and naming.
- `init` never writes over an existing `.shipkit.yml` without `--force`.

## A limitation to be honest about

The forge payload fixtures are written from GitHub's published REST schema, not captured from a live server. So the tests prove the parsers handle *that* shape; they cannot prove the shape is right. Two consequences bind the implementation:

- Every parser must **tolerate a payload it does not recognise** — missing keys, nulls, unexpected types — by returning "could not determine" rather than throwing.
- When a parser cannot determine a field, `init` reports what it actually received, so the first run against a real server diagnoses itself instead of producing a stack trace.

## Provenance is part of the output

Every field `init` writes carries one of three labels, and the rendered YAML says which:

| Label | Meaning |
|---|---|
| `read` | Taken from an authoritative source. The ruleset says the branch pattern is this. |
| `observed` | Derived from what merged pull requests actually contain. True of the past, not necessarily intended. |
| `proposed` | shipkit's suggestion. The team decides. |

The spec's argument is that inference encodes the current average, and the team's intent is to pick a baseline deliberately. Labelling is how both fit in one file: the team edits `proposed` and `observed` rows knowing which is which.

## File Structure

| File | Responsibility |
|---|---|
| `src/infer/types.ts` | `Provenance`, `Inferred<T>`, `InitSources`, `InitDraft` |
| `src/infer/bodies.ts` | Boilerplate lines and section skeleton, from merged PR bodies |
| `src/infer/jira.ts` | Jira base URL and key pattern, from links in those bodies |
| `src/infer/forge.ts` | Branch pattern from a ruleset payload; blocking labels from a workflow file |
| `src/infer/render.ts` | `InitDraft` → commented YAML |
| `src/init/run.ts` | Orchestration: gather → infer → render → write, with provenance reporting |
| `src/cli.ts` | Wire the `init` command |

---

### Task 1: Inference types and the body reader

**Files:**
- Create: `src/infer/types.ts`, `src/infer/bodies.ts`
- Test: `tests/infer/bodies.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Provenance = "read" | "observed" | "proposed";
  export type Inferred<T> = { value: T; provenance: Provenance; why: string };
  export type SectionSkeleton = { name: string; required: boolean; minItems?: number };
  export function boilerplateLines(bodies: string[], atLeast: number): Inferred<string[]>;
  export function sectionSkeleton(bodies: string[]): Inferred<SectionSkeleton[]>;
  ```

`boilerplateLines` is the highest-value inference in this plan: 56 of 78 merged pull requests in the motivating repository left the template's instruction text unanswered, and those lines are detectable precisely *because* they recur verbatim. A line that appears, identically and non-empty, in at least `atLeast` bodies is template text nobody edited.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { boilerplateLines, sectionSkeleton } from "../../src/infer/bodies.js";

const TEMPLATE_LINE = "Please link only parent Development-level Jira issues such as Story or Task.";

describe("boilerplateLines", () => {
  it("finds the instruction text that recurs verbatim across bodies", () => {
    const bodies = [
      `## Summary\nFixed the invoice bug.\n\n## Issues Addressed\n${TEMPLATE_LINE}`,
      `## Summary\nChanged the seat map.\n\n## Issues Addressed\n${TEMPLATE_LINE}`,
      `## Summary\nSomething else.\n\n## Issues Addressed\n${TEMPLATE_LINE}`,
    ];
    expect(boilerplateLines(bodies, 3).value).toContain(TEMPLATE_LINE);
  });

  it("does not mistake a heading for boilerplate", () => {
    const bodies = ["## Summary\na", "## Summary\nb", "## Summary\nc"];
    expect(boilerplateLines(bodies, 3).value).not.toContain("## Summary");
  });

  it("does not mistake prose that happens to repeat twice for a template", () => {
    const bodies = ["## Summary\nBumped the version.", "## Summary\nBumped the version.", "## Summary\nreal work"];
    expect(boilerplateLines(bodies, 3).value).not.toContain("Bumped the version.");
  });

  it("ignores blank lines and list bullets, which recur everywhere", () => {
    const bodies = ["## A\n\n- \n", "## A\n\n- \n", "## A\n\n- \n"];
    expect(boilerplateLines(bodies, 3).value).toEqual([]);
  });

  it("is observed, not read — it describes the past", () => {
    expect(boilerplateLines(["## A\nx"], 1).provenance).toBe("observed");
  });
});

describe("sectionSkeleton", () => {
  it("keeps the headings most bodies share, in the order they appear", () => {
    const bodies = [
      "## Summary\na\n## What to Test\nb\n## Issues Addressed\nc",
      "## Summary\na\n## What to Test\nb\n## Issues Addressed\nc",
      "## Summary\na\n## Issues Addressed\nc",
    ];
    expect(sectionSkeleton(bodies).value.map((s) => s.name)).toEqual([
      "Summary",
      "What to Test",
      "Issues Addressed",
    ]);
  });

  it("marks a heading that only a minority carry as not required", () => {
    const bodies = [
      "## Summary\na\n## Analysis JIRA Issue\nx",
      "## Summary\na",
      "## Summary\na",
      "## Summary\na",
    ];
    const analysis = sectionSkeleton(bodies).value.find((s) => s.name === "Analysis JIRA Issue");
    expect(analysis?.required).toBe(false);
  });

  it("returns nothing rather than guessing when there are no bodies", () => {
    expect(sectionSkeleton([]).value).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/infer/bodies.test.ts`
Expected: FAIL — cannot resolve `../../src/infer/bodies.js`.

- [ ] **Step 3: Implement**

Write `src/infer/types.ts` with the three types above. Then `src/infer/bodies.ts`:

- Split each body on `\n`, trim each line, drop empties, drop lines that are only a bullet marker or punctuation, and drop headings (`#`-prefixed) — a heading recurring is structure, not unanswered boilerplate.
- Count how many *distinct bodies* each surviving line appears in (not total occurrences — one body repeating a line ten times is not evidence).
- Keep lines meeting `atLeast`, longest first so the most specific reads first in the config.
- `sectionSkeleton`: collect `##` headings per body, keep those appearing in more than half, order by median first-appearance across bodies, set `required` true when a heading appears in at least 80% of bodies and false otherwise.

Both return `provenance: "observed"` with a `why` naming the count, e.g. `"appears verbatim in 51 of 78 bodies"`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/infer/bodies.test.ts` — expected PASS.

- [ ] **Step 5: Confirm the tests discriminate**

Change the distinct-body count to a total-occurrence count and confirm the "prose that repeats twice" test fails; restore and confirm it passes. Verify the restore with `git diff --quiet`, not by eye.

- [ ] **Step 6: Commit**

```bash
git add src/infer/types.ts src/infer/bodies.ts tests/infer/bodies.test.ts
git commit -m "feat(init): find the template text nobody filled in"
```

---

### Task 2: Jira inference

**Files:**
- Create: `src/infer/jira.ts`
- Test: `tests/infer/jira.test.ts`

**Interfaces:**
- Consumes: `Inferred<T>` from `src/infer/types.ts` (Task 1). If Task 1 has not landed, declare the type locally and the integrator will reconcile — do not block.
- Produces:
  ```ts
  export type JiraGuess = { baseUrl?: string; keyPattern?: string };
  export function inferJira(bodies: string[]): Inferred<JiraGuess>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { inferJira } from "../../src/infer/jira.js";

describe("inferJira", () => {
  it("reads the base URL and key shape from links in the bodies", () => {
    const got = inferJira([
      "## Issues Addressed\nhttps://jira.example.com/browse/ABC-31086",
      "## Issues Addressed\nhttps://jira.example.com/browse/ABC-31444",
    ]);
    expect(got.value.baseUrl).toBe("https://jira.example.com");
    expect(got.value.keyPattern).toBe("DCP-\\d+");
  });

  it("picks the host that most bodies agree on, not the first seen", () => {
    const got = inferJira([
      "https://stray.example.com/jira/browse/AAA-1",
      "https://jira.example.com/browse/ABC-1",
      "https://jira.example.com/browse/ABC-2",
      "https://jira.example.com/browse/ABC-3",
    ]);
    expect(got.value.baseUrl).toBe("https://jira.example.com");
  });

  it("covers every project prefix it saw, not only the commonest", () => {
    const got = inferJira([
      "https://x.example.com/jira/browse/ABC-1",
      "https://x.example.com/jira/browse/ABC-2",
      "https://x.example.com/jira/browse/OPS-9",
    ]);
    expect(new RegExp(got.value.keyPattern as string).test("OPS-9")).toBe(true);
    expect(new RegExp(got.value.keyPattern as string).test("ABC-1")).toBe(true);
  });

  it("produces a pattern that is a valid regular expression", () => {
    const got = inferJira(["https://x.example.com/jira/browse/A.B-1"]);
    expect(() => new RegExp(got.value.keyPattern as string)).not.toThrow();
  });

  it("says nothing rather than guessing when no link is present", () => {
    const got = inferJira(["## Summary\nno links here"]);
    expect(got.value.baseUrl).toBeUndefined();
    expect(got.value.keyPattern).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/infer/jira.test.ts` — expected FAIL, module missing.

- [ ] **Step 3: Implement**

Match Jira browse links with `/browse/<KEY>-<number>`, tally by origin+path-prefix, and take the most common. Derive the key pattern from the distinct project prefixes seen: one prefix gives `PREFIX-\d+`; several give `(A|B|C)-\d+`. **Escape every prefix** before putting it in the pattern — the fourth test exists because a prefix containing a regex metacharacter would otherwise produce a pattern that is either invalid or matches the wrong thing. Return `provenance: "observed"`.

- [ ] **Step 4: Run the tests** — expected PASS.

- [ ] **Step 5: Confirm the tests discriminate**

Remove the escaping and confirm the `A.B-1` test fails; restore, verify with `git diff --quiet`.

- [ ] **Step 6: Commit**

```bash
git add src/infer/jira.ts tests/infer/jira.test.ts
git commit -m "feat(init): read the Jira host and key shape from merged bodies"
```

---

### Task 3: Forge payload parsers

**Files:**
- Create: `src/infer/forge.ts`, `tests/fixtures/forge/ruleset.json`, `tests/fixtures/forge/merge-gate.yml`
- Test: `tests/infer/forge.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function branchPatternFromRulesets(payload: unknown): Inferred<string> | undefined;
  export function blockingLabelsFromWorkflow(yamlText: string): Inferred<string[]> | undefined;
  ```

Both return `undefined` when they cannot determine the value. **Neither may throw on any input** — see "A limitation to be honest about". `payload: unknown` is deliberate: these parse data from a server this code has never spoken to.

- [ ] **Step 1: Write the fixtures**

`tests/fixtures/forge/ruleset.json` — a GitHub rulesets array carrying a `branch_name_pattern` rule:

```json
[
  {
    "id": 12,
    "name": "branch naming",
    "target": "branch",
    "enforcement": "active",
    "rules": [
      {
        "type": "branch_name_pattern",
        "parameters": {
          "operator": "regex",
          "pattern": "^(feature|bugfix|livebug)/[a-z0-9]+/[0-9]+-[a-z0-9-]+$",
          "negate": false
        }
      }
    ]
  }
]
```

`tests/fixtures/forge/merge-gate.yml` — a workflow that fails when a label is present:

```yaml
name: merge gate
on: [pull_request]
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - name: block on in test
        if: contains(github.event.pull_request.labels.*.name, 'in test')
        run: exit 1
      - name: block on do not merge
        if: contains(github.event.pull_request.labels.*.name, 'do not merge')
        run: exit 1
```

Head both fixtures with a comment saying they are written from GitHub's published schema, not captured from a live server.

- [ ] **Step 2: Write the failing test**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { blockingLabelsFromWorkflow, branchPatternFromRulesets } from "../../src/infer/forge.js";

const ruleset = JSON.parse(readFileSync("tests/fixtures/forge/ruleset.json", "utf8"));
const workflow = readFileSync("tests/fixtures/forge/merge-gate.yml", "utf8");

describe("branchPatternFromRulesets", () => {
  it("takes the pattern from an active branch_name_pattern rule", () => {
    const got = branchPatternFromRulesets(ruleset);
    expect(got?.value).toBe("^(feature|bugfix|livebug)/[a-z0-9]+/[0-9]+-[a-z0-9-]+$");
    expect(got?.provenance).toBe("read");
  });

  it("ignores a rule that is not being enforced", () => {
    const disabled = [{ ...ruleset[0], enforcement: "disabled" }];
    expect(branchPatternFromRulesets(disabled)).toBeUndefined();
  });

  it("ignores a negated rule, which forbids rather than requires", () => {
    const negated = [
      { ...ruleset[0], rules: [{ type: "branch_name_pattern", parameters: { operator: "regex", pattern: "x", negate: true } }] },
    ];
    expect(branchPatternFromRulesets(negated)).toBeUndefined();
  });

  it("ignores a non-regex operator rather than treating it as one", () => {
    const starts = [
      { ...ruleset[0], rules: [{ type: "branch_name_pattern", parameters: { operator: "starts_with", pattern: "feature/" } }] },
    ];
    expect(branchPatternFromRulesets(starts)).toBeUndefined();
  });

  it("refuses a pattern that is not a valid regular expression", () => {
    const broken = [
      { ...ruleset[0], rules: [{ type: "branch_name_pattern", parameters: { operator: "regex", pattern: "([", negate: false } }] },
    ];
    expect(branchPatternFromRulesets(broken)).toBeUndefined();
  });

  it.each([null, undefined, 42, "nope", {}, [], [{}], [{ rules: null }]])(
    "returns undefined rather than throwing on %s",
    (payload) => {
      expect(() => branchPatternFromRulesets(payload)).not.toThrow();
      expect(branchPatternFromRulesets(payload)).toBeUndefined();
    },
  );
});

describe("blockingLabelsFromWorkflow", () => {
  it("finds every label the gate blocks on", () => {
    const got = blockingLabelsFromWorkflow(workflow);
    expect(got?.value).toEqual(["do not merge", "in test"]);
    expect(got?.provenance).toBe("read");
  });

  it("returns undefined rather than throwing on text that is not YAML", () => {
    expect(() => blockingLabelsFromWorkflow(":::not yaml:::")).not.toThrow();
  });

  it("returns undefined when no label gate is present", () => {
    expect(blockingLabelsFromWorkflow("name: x\non: [push]\njobs: {}\n")).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run tests/infer/forge.test.ts` — expected FAIL, module missing.

- [ ] **Step 4: Implement**

Walk the payload defensively — check `Array.isArray`, check each `rules` is an array, check `typeof parameters?.pattern === "string"` — and validate the pattern compiles with `new RegExp` before accepting it. Accept only `enforcement === "active"`, `operator === "regex"`, and a falsy `negate`.

For the workflow, parse with `yaml` inside a `try`/`catch`, then find `contains(github.event.pull_request.labels.*.name, '<label>')` occurrences in every `if:` string. Return the labels **sorted**, so the output does not depend on step order. Return `undefined` for an empty result rather than an empty array — "no gate found" and "a gate that blocks nothing" are different, and only the first is true here.

- [ ] **Step 5: Run the tests** — expected PASS.

- [ ] **Step 6: Confirm the tests discriminate**

Drop the `new RegExp` validation and confirm the `([` test fails; drop the `enforcement` check and confirm the disabled test fails. One at a time, restoring between, each restore verified with `git diff --quiet`.

- [ ] **Step 7: Commit**

```bash
git add src/infer/forge.ts tests/infer/forge.test.ts tests/fixtures/forge
git commit -m "feat(init): parse the ruleset and the merge gate, tolerating any shape"
```

---

### Task 4: Render the draft as commented YAML

**Files:**
- Create: `src/infer/render.ts`
- Test: `tests/infer/render.test.ts`

**Interfaces:**
- Consumes: `Inferred<T>` and the section/Jira types from Tasks 1-3.
- Produces:
  ```ts
  export type InitDraft = {
    titlePattern: Inferred<string>;
    branchPattern: Inferred<string>;
    forbidden: Inferred<string[]>;
    blockingLabels: Inferred<string[]>;
    sections: Inferred<SectionSkeleton[]>;
    jira: Inferred<JiraGuess>;
  };
  export function renderConfig(draft: InitDraft): string;
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { configSchema } from "../../src/config/schema.js";
import { renderConfig, type InitDraft } from "../../src/infer/render.js";

const draft: InitDraft = {
  titlePattern: { value: "^(feat|fix): .+", provenance: "proposed", why: "conventional commits" },
  branchPattern: { value: "^feature/.+$", provenance: "read", why: "from the ruleset" },
  forbidden: { value: ["TBD", "<!--"], provenance: "observed", why: "in 51 of 78 bodies" },
  blockingLabels: { value: ["in test"], provenance: "read", why: "from the merge gate" },
  sections: {
    value: [{ name: "Summary", required: true }, { name: "What to Test", required: true, minItems: 3 }],
    provenance: "observed",
    why: "in most bodies",
  },
  jira: {
    value: { baseUrl: "https://x.example.com/jira", keyPattern: "DCP-\\d+" },
    provenance: "observed",
    why: "from links",
  },
};

describe("renderConfig", () => {
  it("produces YAML the real config loader accepts", () => {
    expect(() => configSchema.parse(parse(renderConfig(draft)))).not.toThrow();
  });

  it("says where every value came from, so a reader knows what to edit", () => {
    const yml = renderConfig(draft);
    expect(yml).toContain("from the ruleset");
    expect(yml).toContain("in 51 of 78 bodies");
    expect(yml).toContain("conventional commits");
  });

  it("round-trips a pattern containing backslashes without mangling it", () => {
    const parsed = configSchema.parse(parse(renderConfig(draft)));
    expect(parsed.jira.keyPattern).toBe("DCP-\\d+");
    expect(new RegExp(parsed.jira.keyPattern).test("ABC-7")).toBe(true);
  });

  it("defaults approval to echo, never opting a team into human silently", () => {
    expect(configSchema.parse(parse(renderConfig(draft))).pr.approval).toBe("echo");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/infer/render.test.ts` — expected FAIL, module missing.

- [ ] **Step 3: Implement**

Build the config object, serialise with the `yaml` package, then inject a `# ` comment line above each field carrying its provenance and `why`. Do **not** hand-roll YAML string escaping — the third test exists because `DCP-\d+` written naively comes back as `DCP-d+`. Let the `yaml` package quote, and place comments through its comment API or by inserting lines above already-serialised keys.

The first test is the one that matters: it feeds the output straight back through the real `configSchema`, so a rendering that does not load is a failing test rather than a discovery on someone's first run.

- [ ] **Step 4: Run the tests** — expected PASS.

- [ ] **Step 5: Confirm the tests discriminate**

Replace the `yaml` serialisation of `jira.keyPattern` with a bare interpolation and confirm the backslash test fails. Restore, verify with `git diff --quiet`.

- [ ] **Step 6: Commit**

```bash
git add src/infer/render.ts tests/infer/render.test.ts
git commit -m "feat(init): render a config that says where each value came from"
```

---

### Task 5: The command

**Files:**
- Create: `src/init/run.ts`
- Modify: `src/cli.ts`
- Test: `tests/init/run.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  ```ts
  export type InitSources = {
    rulesets: () => unknown;
    mergeGateWorkflow: () => string | undefined;
    mergedBodies: (limit: number) => string[];
  };
  export type InitDeps = {
    sources: InitSources;
    exists: (path: string) => boolean;
    write: (path: string, text: string) => void;
    out: (line: string) => void;
    err: (line: string) => void;
  };
  export type InitResult = { code: number; wrote: boolean; unresolved: string[] };
  export function runInit(options: { config: string; force: boolean; limit: number }, deps: InitDeps): InitResult;
  ```

Each source is a thunk that may throw — no remote, `gh` not installed, no permission. `runInit` calls each inside a `try`/`catch` and carries on with what it has. A repository with no forge access must still get a usable starter file; that is the common bootstrap case, not an error.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { configSchema } from "../../src/config/schema.js";
import { runInit, type InitDeps } from "../../src/init/run.js";

function deps(over: Partial<InitDeps> = {}) {
  const written: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const base: InitDeps = {
    sources: {
      rulesets: () => [],
      mergeGateWorkflow: () => undefined,
      mergedBodies: () => ["## Summary\nreal work\n## Issues Addressed\nhttps://x.example.com/jira/browse/ABC-1"],
    },
    exists: () => false,
    write: (_p, text) => void written.push(text),
    out: (line) => void out.push(line),
    err: (line) => void err.push(line),
    ...over,
  };
  return { deps: base, written, out, err };
}

const OPTIONS = { config: ".shipkit.yml", force: false, limit: 50 };

describe("runInit", () => {
  it("writes a config the loader accepts, even with no forge access at all", () => {
    const { deps: d, written } = deps({
      sources: {
        rulesets: () => { throw new Error("no remote"); },
        mergeGateWorkflow: () => { throw new Error("no remote"); },
        mergedBodies: () => { throw new Error("no remote"); },
      },
    });
    const result = runInit(OPTIONS, d);
    expect(result.code).toBe(0);
    expect(result.wrote).toBe(true);
    expect(() => configSchema.parse(parse(written[0]))).not.toThrow();
  });

  it("names what it could not determine, rather than quietly inventing it", () => {
    const { deps: d } = deps({
      sources: {
        rulesets: () => { throw new Error("no remote"); },
        mergeGateWorkflow: () => undefined,
        mergedBodies: () => [],
      },
    });
    expect(runInit(OPTIONS, d).unresolved).toContain("branch.pattern");
  });

  it("refuses to overwrite an existing config", () => {
    const { deps: d, written } = deps({ exists: () => true });
    const result = runInit(OPTIONS, d);
    expect(result.code).toBe(2);
    expect(result.wrote).toBe(false);
    expect(written).toHaveLength(0);
  });

  it("overwrites when told to explicitly", () => {
    const { deps: d, written } = deps({ exists: () => true });
    expect(runInit({ ...OPTIONS, force: true }, d).wrote).toBe(true);
    expect(written).toHaveLength(1);
  });

  it("reports what it actually received when a payload makes no sense", () => {
    const { deps: d, err } = deps({ sources: { rulesets: () => ({ nope: true }), mergeGateWorkflow: () => undefined, mergedBodies: () => [] } });
    runInit(OPTIONS, d);
    expect(err.join("\n")).toMatch(/ruleset/i);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/init/run.test.ts` — expected FAIL, module missing.

- [ ] **Step 3: Implement `runInit`**

Gather each source in its own `try`/`catch`. Build the `InitDraft`, substituting a `proposed` default whenever a source failed or a parser returned `undefined`:

- `branch.pattern` — no safe default exists, and a wrong one rejects every branch. Use a permissive `^.+$` and list `branch.pattern` in `unresolved`.
- `pr.titlePattern` — propose `^(feat|fix|chore|refactor|docs|test)(\([a-z0-9-]+\))?: .+`, the conventional-commits shape, with `provenance: "proposed"`.
- `pr.sections` — when no bodies were readable, propose the four-section skeleton from the spec's worked example (Summary, Screenshots / Screen Recordings, What to Test with `minItems: 3`, Issues Addressed).
- `jira` — when no link was found, leave the placeholder host `https://jira.example.com` and `[A-Z]+-\d+`, and list `jira.baseUrl` in `unresolved`. The config schema requires a URL, so the file must still load.

Write via `deps.write`, then print a provenance summary through `deps.out`: one line per field saying `read`, `observed` or `proposed`, and a closing line naming everything in `unresolved` as needing a human. Return code 0 when written, 2 when refused.

- [ ] **Step 4: Run the tests** — expected PASS.

- [ ] **Step 5: Wire the CLI**

Add to `src/cli.ts`, following the existing commands' shape:

```ts
program
  .command("init")
  .description("Write a starter .shipkit.yml, reading what the forge can prove")
  .option("--config <path>", "path to write", ".shipkit.yml")
  .option("--force", "overwrite an existing config", false)
  .option("--limit <n>", "how many merged pull requests to read", "50")
  .action((options) => { /* build real InitSources over gh, call runInit, set process.exitCode */ });
```

The real `InitSources` shells out through the existing `GhRunner` seam in `src/vcs/github.ts` — reuse it, do not add a second way to call `gh`. Read rulesets from `gh api repos/{owner}/{repo}/rulesets`, the merge-gate workflow by listing `.github/workflows` and taking files whose content mentions `pull_request.labels`, and merged bodies from `gh pr list --state merged --json body --limit <n>`.

- [ ] **Step 6: Prove the command runs**

Run `node dist/cli.js init --config /tmp/probe.shipkit.yml` from a directory with no git remote, after `npm run build`. It must exit 0, write a file, and name its unresolved fields. Then confirm the file loads:

```bash
node dist/cli.js check --config /tmp/probe.shipkit.yml --title "fix(x): y" --body-file /dev/null 2>&1 | head
```

This must report missing sections rather than a config error — a config `init` writes that `check` cannot load is the one failure this whole task exists to avoid. Record the actual output in your report, and delete the probe file.

- [ ] **Step 7: Full verification and commit**

Run `npm test` and `npm run check`. Then:

```bash
git add src/init/run.ts src/cli.ts tests/init/run.test.ts
git commit -m "feat(init): write a reviewable config, with or without a forge"
```

---

## Done when

- `shipkit init` writes a `.shipkit.yml` that `configSchema` parses and `shipkit check` loads, on a repository with a forge and on one with none.
- Every field in the output says whether it was read, observed, or proposed.
- Anything that could not be determined is named on stderr, not silently invented.
- An existing config is never overwritten without `--force`.
- No test invokes `gh` or the network; `npm test` and `npm run check` are green.

## Next

- **`shipkit branch`**, the other unbuilt command from the original design: suggest a branch name that satisfies `branch.pattern`. Wants `init` first, because it needs a pattern to satisfy.
- **Capturing real forge payloads.** The fixtures here are written from the published schema. The first run against a real server is the real test, and its output should be folded back in as a fixture.
