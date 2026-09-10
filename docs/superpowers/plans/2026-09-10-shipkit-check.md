# shipkit `check` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working `shipkit check` that validates a pull-request title and body against a repository's `.shipkit.yml` and exits non-zero on any violation.

**Architecture:** A Node CLI in TypeScript. Configuration is parsed and schema-checked once, a PR body is parsed from Markdown into named sections, and a pure `validate()` function turns (title, body, config) into a list of findings. Nothing in this slice touches the network or a git repository, so every rule is unit-testable with plain strings.

**Tech Stack:** Node 25, TypeScript, `commander` (CLI), `yaml` (config parsing), `zod` (config schema), `vitest` (tests).

**Spec:** `docs/superpowers/specs/2026-09-10-shipkit-design.md`
**Reference examples:** `docs/examples/example-app-pr-bodies.md`

## Global Constraints

- Package name: `shipkit`. Binary name: `shipkit`.
- ESM only (`"type": "module"`). No CommonJS build.
- TypeScript `strict: true`. No `any` in committed code.
- No network access anywhere in this plan. `vcs` and `jira` adapters arrive in plan 2.
- The Jira **link-level** rule (`linkPolicy: story`) is out of scope here — it needs the Jira API. This slice validates only that a key of the configured shape is present.
- Section names in config and in a PR body are compared case-sensitively and trimmed.
- Exit codes: `0` clean, `1` findings, `2` usage or configuration error.

## Scope

Delivered by this plan: `shipkit check --title <string> --body-file <path>`.

Deferred: `init`, `branch`, `brief`, `submit`, pre-flight, and every adapter.

Two rules the spec lists under the validation gate are deliberately absent here,
because both need something this slice cannot reach:

- **Branch name matches the pattern** — needs the current branch, so it waits for the
  `vcs` adapter in plan 2. `branch.pattern` is still parsed and typed by the config
  loader in Task 2, so the schema does not change when the rule lands.
- **Jira key resolves to Story or Bug level** — needs the issue type from the Jira API.
  Task 4 checks only that a key of the configured shape is present.

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts` | Project scaffold and build |
| `src/cli.ts` | Argument parsing, exit codes, output rendering |
| `src/config/schema.ts` | The `.shipkit.yml` shape as a zod schema, plus defaults |
| `src/config/load.ts` | Read and parse a config file into a typed object |
| `src/validate/types.ts` | `Finding`, `ValidationResult` |
| `src/validate/body.ts` | Markdown body → named sections |
| `src/validate/rules.ts` | The validation gate |
| `tests/**` | One test file per source module |
| `tests/fixtures/**` | A valid config and PR bodies drawn from the worked examples |

---

### Task 1: Project scaffold and a runnable binary

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/cli.ts`
- Test: `tests/cli.smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a `shipkit` binary entry at `dist/cli.js`; `npm test` runs vitest; `npm run build` runs `tsc`.

- [ ] **Step 1: Write the failing test**

`tests/cli.smoke.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("cli", () => {
  it("prints its version", () => {
    const out = execFileSync("node", ["dist/cli.js", "--version"], {
      encoding: "utf8",
    });
    expect(out.trim()).toBe("0.1.0");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli.smoke.test.ts`
Expected: FAIL — vitest is not installed yet, so the command errors before the assertion. That is the expected starting point.

- [ ] **Step 3: Create the scaffold**

`package.json`:

```json
{
  "name": "shipkit",
  "version": "0.1.0",
  "description": "Holds AI coding agents to a team's pull-request conventions",
  "type": "module",
  "bin": { "shipkit": "dist/cli.js" },
  "files": ["dist"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "check": "tsc --noEmit"
  },
  "dependencies": {
    "commander": "^12.1.0",
    "yaml": "^2.5.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.7.4",
    "typescript": "^5.6.2",
    "vitest": "^2.1.1"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "declaration": false,
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"] },
});
```

`.gitignore`:

```
node_modules/
dist/
```

`src/cli.ts`:

```ts
#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();
program.name("shipkit").version("0.1.0");
program.parse();
```

- [ ] **Step 4: Install and build**

Run: `npm install && npm run build`
Expected: `dist/cli.js` exists.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/cli.smoke.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src/cli.ts tests/cli.smoke.test.ts
git commit -m "feat: scaffold the shipkit CLI"
```

---

### Task 2: Config schema and loader

**Files:**
- Create: `src/config/schema.ts`
- Create: `src/config/load.ts`
- Create: `tests/fixtures/valid.shipkit.yml`
- Test: `tests/config/load.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type Section = { name: string; required: boolean; minItems?: number; hint?: string }`
  - `type ShipkitConfig = { pr: { titlePattern: string; sections: Section[]; forbidden: string[] }; branch: { pattern: string }; jira: { baseUrl: string; keyPattern: string; linkPolicy: "story" | "any" } }`
  - `function loadConfig(path: string): ShipkitConfig` — throws `ConfigError` on unreadable, unparseable, or schema-invalid input.
  - `class ConfigError extends Error`

- [ ] **Step 1: Write the failing test**

`tests/fixtures/valid.shipkit.yml`:

```yaml
pr:
  titlePattern: '^\[DCP-\d+\] (feat|fix|chore|ref|docs)(\([a-z0-9-]+\))?: .+'
  forbidden: ["TBD", "TODO", "<!--"]
  sections:
    - name: Summary
      required: true
      hint: "5-6 lines: what was wrong and what changed"
    - name: Screenshots / Screen Recordings
      required: true
      hint: "Before/after, or say why there is nothing to show"
    - name: What to Test
      required: true
      minItems: 3
      hint: "The checks a QA engineer needs, plus obvious regressions"
    - name: Issues Addressed
      required: true
      minItems: 1
      hint: "Link at Story/Bug level"
    - name: Analysis JIRA Issue
      required: false
branch:
  pattern: '^(feature|bugfix|livebug)/[a-z0-9]+/[0-9]+-[a-z0-9]+(-[a-z0-9]+)*$'
jira:
  baseUrl: https://jira.example.com
  keyPattern: 'DCP-\d+'
  linkPolicy: story
```

`tests/config/load.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config/load.js";

const FIXTURE = "tests/fixtures/valid.shipkit.yml";

describe("loadConfig", () => {
  it("reads sections in file order", () => {
    const config = loadConfig(FIXTURE);
    expect(config.pr.sections.map((s) => s.name)).toEqual([
      "Summary",
      "Screenshots / Screen Recordings",
      "What to Test",
      "Issues Addressed",
      "Analysis JIRA Issue",
    ]);
  });

  it("keeps per-section settings", () => {
    const config = loadConfig(FIXTURE);
    const whatToTest = config.pr.sections.find((s) => s.name === "What to Test");
    expect(whatToTest?.minItems).toBe(3);
    expect(config.pr.sections.find((s) => s.name === "Analysis JIRA Issue")?.required).toBe(false);
  });

  it("throws when the file is missing", () => {
    expect(() => loadConfig("tests/fixtures/nope.yml")).toThrow(ConfigError);
  });

  it("throws when a required key is absent", () => {
    expect(() => loadConfig("tests/fixtures/invalid.shipkit.yml")).toThrow(ConfigError);
  });
});
```

Also create `tests/fixtures/invalid.shipkit.yml` containing only:

```yaml
pr:
  sections: []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config/load.test.ts`
Expected: FAIL — cannot resolve `../../src/config/load.js`.

- [ ] **Step 3: Write the implementation**

`src/config/schema.ts`:

```ts
import { z } from "zod";

export const sectionSchema = z.object({
  name: z.string().min(1),
  required: z.boolean(),
  minItems: z.number().int().positive().optional(),
  hint: z.string().optional(),
});

export const configSchema = z.object({
  pr: z.object({
    titlePattern: z.string().min(1),
    forbidden: z.array(z.string()).default([]),
    sections: z.array(sectionSchema).min(1),
  }),
  branch: z.object({ pattern: z.string().min(1) }),
  jira: z.object({
    baseUrl: z.string().url(),
    keyPattern: z.string().min(1),
    linkPolicy: z.enum(["story", "any"]).default("story"),
  }),
});

export type Section = z.infer<typeof sectionSchema>;
export type ShipkitConfig = z.infer<typeof configSchema>;
```

`src/config/load.ts`:

```ts
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { configSchema, type ShipkitConfig } from "./schema.js";

export class ConfigError extends Error {}

export function loadConfig(path: string): ShipkitConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`Cannot read config at ${path}`);
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    throw new ConfigError(`Cannot parse YAML at ${path}: ${(error as Error).message}`);
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid config at ${path}: ${detail}`);
  }
  return result.data;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config/load.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/config tests/config tests/fixtures
git commit -m "feat(config): load and schema-check .shipkit.yml"
```

---

### Task 3: Parse a PR body into sections

**Files:**
- Create: `src/validate/body.ts`
- Test: `tests/validate/body.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ParsedBody = { sections: Record<string, string>; order: string[] }`
  - `function parseBody(markdown: string): ParsedBody` — keys are `##` heading texts, trimmed; values are the content up to the next `##` heading, trimmed, with `---` separator lines removed.

- [ ] **Step 1: Write the failing test**

`tests/validate/body.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseBody } from "../../src/validate/body.js";

describe("parseBody", () => {
  it("splits on level-two headings and preserves order", () => {
    const parsed = parseBody("## Summary\n\nfirst\n\n---\n\n## What to Test\n\n- a\n");
    expect(parsed.order).toEqual(["Summary", "What to Test"]);
    expect(parsed.sections.Summary).toBe("first");
    expect(parsed.sections["What to Test"]).toBe("- a");
  });

  it("drops separator lines but keeps inner dashes", () => {
    const parsed = parseBody("## Summary\n\n---\n\nkept - inline\n");
    expect(parsed.sections.Summary).toBe("kept - inline");
  });

  it("ignores level-three headings", () => {
    const parsed = parseBody("## Summary\n\n### Detail\n\ntext\n");
    expect(parsed.order).toEqual(["Summary"]);
    expect(parsed.sections.Summary).toContain("### Detail");
  });

  it("returns empty content for a heading with nothing under it", () => {
    const parsed = parseBody("## Summary\n\n## What to Test\n\n- a\n");
    expect(parsed.sections.Summary).toBe("");
  });

  it("returns nothing for an empty body", () => {
    expect(parseBody("")).toEqual({ sections: {}, order: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/validate/body.test.ts`
Expected: FAIL — cannot resolve `../../src/validate/body.js`.

- [ ] **Step 3: Write the implementation**

`src/validate/body.ts`:

```ts
export type ParsedBody = {
  sections: Record<string, string>;
  order: string[];
};

const HEADING = /^##[^#]\s*(.+?)\s*$/;
const SEPARATOR = /^-{3,}$/;

export function parseBody(markdown: string): ParsedBody {
  const sections: Record<string, string> = {};
  const order: string[] = [];
  let current: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (current === null) return;
    sections[current] = buffer.join("\n").trim();
    buffer = [];
  };

  for (const line of markdown.split("\n")) {
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      current = heading[1];
      order.push(current);
      continue;
    }
    if (current !== null && !SEPARATOR.test(line.trim())) {
      buffer.push(line);
    }
  }
  flush();

  return { sections, order };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/validate/body.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/validate/body.ts tests/validate/body.test.ts
git commit -m "feat(validate): parse a PR body into named sections"
```

---

### Task 4: The validation gate

**Files:**
- Create: `src/validate/types.ts`
- Create: `src/validate/rules.ts`
- Test: `tests/validate/rules.test.ts`

**Interfaces:**
- Consumes: `ShipkitConfig`, `Section` from Task 2; `parseBody`, `ParsedBody` from Task 3.
- Produces:
  - `type Finding = { rule: string; message: string; section?: string }`
  - `type ValidationResult = { ok: boolean; findings: Finding[] }`
  - `function validate(input: { title: string; body: string; config: ShipkitConfig }): ValidationResult`
  - Rule identifiers, used verbatim in output and tests: `title-pattern`, `section-missing`, `section-empty`, `section-min-items`, `forbidden-text`, `issue-key-missing`.

- [ ] **Step 1: Write the failing test**

`tests/validate/rules.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { validate } from "../../src/validate/rules.js";

const config = loadConfig("tests/fixtures/valid.shipkit.yml");
const TITLE = "[ABC-31087] fix(invoice): default citizenship from passenger info";

const goodBody = [
  "## Summary",
  "",
  "Add Invoice always defaulted citizenship to Turkish.",
  "",
  "---",
  "",
  "## Screenshots / Screen Recordings",
  "",
  "| Before | After |",
  "",
  "---",
  "",
  "## What to Test",
  "",
  "- Passenger with a national ID sees Turkish.",
  "- Passenger without one sees Foreign.",
  "- Switching invoice type keeps the derived default.",
  "",
  "---",
  "",
  "## Issues Addressed",
  "",
  "- [ABC-31086](https://jira.example.com/browse/ABC-31086)",
].join("\n");

const rules = (result: { findings: { rule: string }[] }) =>
  result.findings.map((f) => f.rule);

describe("validate", () => {
  it("accepts a well-formed PR", () => {
    const result = validate({ title: TITLE, body: goodBody, config });
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rejects a title that does not match the pattern", () => {
    const result = validate({ title: "fix invoice", body: goodBody, config });
    expect(rules(result)).toContain("title-pattern");
  });

  it("reports a missing required section", () => {
    const body = goodBody.replace(/## What to Test[\s\S]*?(?=## Issues Addressed)/, "");
    const result = validate({ title: TITLE, body, config });
    expect(rules(result)).toContain("section-missing");
  });

  it("does not report a missing optional section", () => {
    const result = validate({ title: TITLE, body: goodBody, config });
    expect(rules(result)).not.toContain("section-missing");
  });

  it("reports a required section left empty", () => {
    const body = goodBody.replace(
      "Add Invoice always defaulted citizenship to Turkish.",
      "",
    );
    const result = validate({ title: TITLE, body, config });
    expect(rules(result)).toContain("section-empty");
  });

  it("reports too few items in What to Test", () => {
    const body = goodBody
      .replace("- Passenger without one sees Foreign.\n", "")
      .replace("- Switching invoice type keeps the derived default.\n", "");
    const result = validate({ title: TITLE, body, config });
    expect(rules(result)).toContain("section-min-items");
  });

  it("reports leftover template placeholders", () => {
    const body = goodBody.replace(
      "| Before | After |",
      "<!-- drag the screenshot here -->",
    );
    const result = validate({ title: TITLE, body, config });
    expect(rules(result)).toContain("forbidden-text");
  });

  it("reports Issues Addressed without an issue key", () => {
    const body = goodBody.replace(
      "- [ABC-31086](https://jira.example.com/browse/ABC-31086)",
      "- none",
    );
    const result = validate({ title: TITLE, body, config });
    expect(rules(result)).toContain("issue-key-missing");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/validate/rules.test.ts`
Expected: FAIL — cannot resolve `../../src/validate/rules.js`.

- [ ] **Step 3: Write the implementation**

`src/validate/types.ts`:

```ts
export type Finding = {
  rule: string;
  message: string;
  section?: string;
};

export type ValidationResult = {
  ok: boolean;
  findings: Finding[];
};
```

`src/validate/rules.ts`:

```ts
import type { Section, ShipkitConfig } from "../config/schema.js";
import { parseBody } from "./body.js";
import type { Finding, ValidationResult } from "./types.js";

export type ValidateInput = {
  title: string;
  body: string;
  config: ShipkitConfig;
};

const ISSUES_SECTION = "Issues Addressed";

function countItems(content: string): number {
  return content
    .split("\n")
    .filter((line) => /^\s*[-*]\s+\S/.test(line)).length;
}

export function validate({ title, body, config }: ValidateInput): ValidationResult {
  const findings: Finding[] = [];
  const parsed = parseBody(body);

  if (!new RegExp(config.pr.titlePattern).test(title)) {
    findings.push({
      rule: "title-pattern",
      message: `Title does not match ${config.pr.titlePattern}`,
    });
  }

  for (const term of config.pr.forbidden) {
    if (body.includes(term)) {
      findings.push({
        rule: "forbidden-text",
        message: `Body still contains ${JSON.stringify(term)}`,
      });
    }
  }

  for (const section of config.pr.sections) {
    findings.push(...checkSection(section, parsed.sections[section.name]));
  }

  const issues = parsed.sections[ISSUES_SECTION];
  if (issues && !new RegExp(config.jira.keyPattern).test(issues)) {
    findings.push({
      rule: "issue-key-missing",
      message: `${ISSUES_SECTION} has no key matching ${config.jira.keyPattern}`,
      section: ISSUES_SECTION,
    });
  }

  return { ok: findings.length === 0, findings };
}

function checkSection(section: Section, content: string | undefined): Finding[] {
  if (content === undefined) {
    return section.required
      ? [{
          rule: "section-missing",
          message: `Required section "${section.name}" is absent`,
          section: section.name,
        }]
      : [];
  }

  if (section.required && content.length === 0) {
    return [{
      rule: "section-empty",
      message: `Required section "${section.name}" is empty`,
      section: section.name,
    }];
  }

  if (section.minItems !== undefined && countItems(content) < section.minItems) {
    return [{
      rule: "section-min-items",
      message: `"${section.name}" needs at least ${section.minItems} items`,
      section: section.name,
    }];
  }

  return [];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/validate/rules.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/validate/rules.ts src/validate/types.ts tests/validate/rules.test.ts
git commit -m "feat(validate): enforce the PR body gate"
```

---

### Task 5: Wire up `shipkit check`

**Files:**
- Modify: `src/cli.ts`
- Test: `tests/cli.check.test.ts`

**Interfaces:**
- Consumes: `loadConfig` and `ConfigError` from Task 2; `validate` from Task 4.
- Produces: the command `shipkit check --title <string> --body-file <path> [--config <path>]`, defaulting `--config` to `.shipkit.yml`. Exit `0` when clean, `1` when there are findings, `2` on a configuration or usage error. Findings print one per line as `<rule>: <message>`.

- [ ] **Step 1: Write the failing test**

`tests/cli.check.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CONFIG = "tests/fixtures/valid.shipkit.yml";
const TITLE = "[ABC-31087] fix(invoice): default citizenship from passenger info";

function bodyFile(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "shipkit-")), "body.md");
  writeFileSync(path, content, "utf8");
  return path;
}

function run(args: string[]): { status: number; output: string } {
  try {
    const output = execFileSync("node", ["dist/cli.js", ...args], { encoding: "utf8" });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    return { status: failure.status, output: `${failure.stdout}${failure.stderr}` };
  }
}

const goodBody = [
  "## Summary",
  "",
  "Add Invoice always defaulted citizenship to Turkish.",
  "",
  "## Screenshots / Screen Recordings",
  "",
  "| Before | After |",
  "",
  "## What to Test",
  "",
  "- one",
  "- two",
  "- three",
  "",
  "## Issues Addressed",
  "",
  "- [ABC-31086](https://jira.example.com/browse/ABC-31086)",
].join("\n");

describe("shipkit check", () => {
  it("exits 0 on a compliant PR", () => {
    const result = run(["check", "--title", TITLE, "--body-file", bodyFile(goodBody), "--config", CONFIG]);
    expect(result.status).toBe(0);
  });

  it("exits 1 and names the rule on a bad title", () => {
    const result = run(["check", "--title", "nope", "--body-file", bodyFile(goodBody), "--config", CONFIG]);
    expect(result.status).toBe(1);
    expect(result.output).toContain("title-pattern");
  });

  it("exits 2 when the config is missing", () => {
    const result = run(["check", "--title", TITLE, "--body-file", bodyFile(goodBody), "--config", "nope.yml"]);
    expect(result.status).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run tests/cli.check.test.ts`
Expected: FAIL — `check` is not a known command, so every case exits non-zero with commander's usage error.

- [ ] **Step 3: Write the implementation**

Replace `src/cli.ts` with:

```ts
#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { ConfigError, loadConfig } from "./config/load.js";
import { validate } from "./validate/rules.js";

const program = new Command();
program.name("shipkit").version("0.1.0");

program
  .command("check")
  .description("Validate a pull-request title and body against .shipkit.yml")
  .requiredOption("--title <title>", "pull-request title")
  .requiredOption("--body-file <path>", "file holding the pull-request body")
  .option("--config <path>", "path to .shipkit.yml", ".shipkit.yml")
  .action((options: { title: string; bodyFile: string; config: string }) => {
    let body: string;
    try {
      body = readFileSync(options.bodyFile, "utf8");
    } catch {
      console.error(`Cannot read body file at ${options.bodyFile}`);
      process.exit(2);
    }

    try {
      const config = loadConfig(options.config);
      const result = validate({ title: options.title, body, config });
      if (result.ok) {
        console.log("ok");
        process.exit(0);
      }
      for (const finding of result.findings) {
        console.error(`${finding.rule}: ${finding.message}`);
      }
      process.exit(1);
    } catch (error) {
      if (error instanceof ConfigError) {
        console.error(error.message);
        process.exit(2);
      }
      throw error;
    }
  });

program.parse();
```

- [ ] **Step 4: Run the full suite**

Run: `npm run build && npm test`
Expected: PASS — all files, 21 tests.

- [ ] **Step 5: Verify against a real example**

Run:

```bash
sed -n '/^# Example 1/,/^# Example 2/p' docs/examples/example-app-pr-bodies.md \
  | sed -n '/^## Summary/,$p' > /tmp/example1.md
node dist/cli.js check \
  --title "[ABC-31087] fix(invoice): default citizenship from passenger info" \
  --body-file /tmp/example1.md \
  --config tests/fixtures/valid.shipkit.yml
```

Expected: prints `ok` and exits 0. The calibrated example is the acceptance test for the rules — if it fails, the rules are wrong, not the example.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts tests/cli.check.test.ts
git commit -m "feat(cli): add the check command"
```

---

## Done when

- `npm test` passes.
- `shipkit check` returns 0 for all three worked examples in `docs/examples/example-app-pr-bodies.md` and 1 for a body with a section removed.
- `npm run check` reports no type errors.

## Next plans

- **Plan 2 — `brief` and `submit`:** the `vcs` and `jira` adapters, brief assembly, the pre-flight checks, and PR creation. Adds the `linkPolicy` level rule deferred here.
- **Plan 3 — `init` and `branch`:** read rules from rulesets and branch protection, seed the body template, suggest compliant branch names.
