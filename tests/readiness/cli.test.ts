import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Brief } from "../../src/brief/types.js";

const CLI = resolve("dist/cli.js");

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

/**
 * The child's environment is pinned, not inherited wholesale. `submit` resolves the issue
 * key the body cites, and the token for that comes either from `SHIPKIT_JIRA_TOKEN` or from
 * the approval surface's socket — so on a developer's own machine, with the menu-bar app
 * running and a token saved, this suite would make a live call to a corporate Jira host.
 * Unsetting the variable is not enough; the socket has to be pointed at nothing too.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.SHIPKIT_JIRA_TOKEN;
  env.SHIPKIT_APPROVAL_SOCKET = "/nonexistent/shipkit-tests.sock";
  return env;
}

function run(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [CLI, ...args], {
      encoding: "utf8",
      cwd,
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    return { status: failure.status, stdout: failure.stdout, stderr: failure.stderr };
  }
}

const CONFIG = `pr:
  titlePattern: '^\\[DCP-\\d+\\] (feat|fix|chore|ref|docs)(\\([a-z0-9-]+\\))?: .+'
  forbidden: ["TBD", "TODO"]
  sections:
    - name: Summary
      required: true
    - name: What to Test
      required: true
      minItems: 3
    - name: Issues Addressed
      required: true
      minItems: 1
readiness: ./readiness.yml
branch:
  pattern: '^(feature|bugfix|livebug)/[a-z0-9]+/[0-9]+-[a-z0-9]+(-[a-z0-9]+)*$'
jira:
  baseUrl: https://jira.example.com
  keyPattern: 'DCP-\\d+'
  linkPolicy: story
`;

const RULES = `version: 1
rules:
  - id: design-tokens
    ask: "Do the colours use the right semantic token?"
    appliesTo: ["**/*.swift"]
    severity: warn
  - id: all-entry-paths
    ask: "Does the new check hold on every entry path?"
    severity: warn
  - id: asset-catalog
    ask: "Is the tinted asset marked as a template?"
    appliesTo: ["**/*.xcassets/**"]
    severity: advise
`;

/**
 * The deployment this feature was designed around, built for real: the rules and the config
 * live in a shared conventions directory, and the product repository reaches them through a
 * symbolic link named `.shipkit.yml`. Resolved against the link rather than its target,
 * `readiness: ./readiness.yml` points at a file that does not exist and every run refuses.
 *
 * No remote is configured, deliberately: nothing here can reach a forge. That also bounds
 * what this file can show — every readiness verdict below is a refusal, which lands before
 * the forge is consulted at all. The run that gets *through* the gate needs a pull-request
 * reader, so it lives in tests/readiness/e2e.test.ts against a local bare remote and a
 * faked forge, rather than being asserted here against an error from `gh`.
 */
function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "shipkit-readiness-cli-")));
  tempDirs.push(root);
  const conventions = join(root, "conventions");
  const repo = join(root, "product");
  mkdirSync(conventions);
  mkdirSync(repo);
  writeFileSync(join(conventions, "shipkit.yml"), CONFIG, "utf8");
  writeFileSync(join(conventions, "readiness.yml"), RULES, "utf8");

  git(["init", "-q", "-b", "develop"], repo);
  git(["config", "user.email", "t@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  writeFileSync(join(repo, "README.md"), "base\n", "utf8");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "base"], repo);
  git(["checkout", "-q", "-b", "bugfix/squadb/1-invoice"], repo);
  symlinkSync(join(conventions, "shipkit.yml"), join(repo, ".shipkit.yml"));
  return repo;
}

function response(repo: string, readiness: unknown[]): string {
  const path = join(repo, "shipkit-response.json");
  writeFileSync(
    path,
    JSON.stringify({
      title: "[ABC-1] fix(x): y",
      commitMessage: "fix(x): y",
      sections: {
        Summary: "It was broken; now it is not.",
        "What to Test": "- one\n- two\n- three",
        "Issues Addressed": "- [ABC-1](https://jira.example.com/browse/ABC-1)",
      },
      readiness,
    }),
    "utf8",
  );
  return path;
}

function commitCount(repo: string): number {
  return execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: repo, encoding: "utf8" })
    .trim()
    .split("\n")
    .map(Number)[0] as number;
}

describe("the CLI with a symlinked rules file", () => {
  it("briefs only the rules the uncommitted change touches", () => {
    const repo = scratch();
    // Uncommitted and untracked, which is the state an agent leaves: `commitAll` stages
    // after the gate, so a filter that could not see this would ask about nothing.
    writeFileSync(join(repo, "View.swift"), "import SwiftUI\n", "utf8");

    const result = run(["brief", "--base", "develop", "--config", ".shipkit.yml"], repo);

    expect(result.status).toBe(0);
    const brief = JSON.parse(result.stdout) as Brief;
    expect(brief.readiness?.map((item) => item.id)).toEqual(["design-tokens", "all-entry-paths"]);
  });

  it("refuses a missing answer, naming readiness-unanswered, and commits nothing", () => {
    const repo = scratch();
    writeFileSync(join(repo, "View.swift"), "import SwiftUI\n", "utf8");
    const before = commitCount(repo);

    const result = run(
      ["submit", "--input", response(repo, [{ id: "design-tokens", status: "pass" }]),
       "--base", "develop", "--config", ".shipkit.yml", "--yes"],
      repo,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("readiness-unanswered");
    expect(result.stderr).toContain("all-entry-paths");
    expect(commitCount(repo)).toBe(before);
  });

  it("refuses n/a without a note", () => {
    const repo = scratch();
    writeFileSync(join(repo, "View.swift"), "import SwiftUI\n", "utf8");

    const result = run(
      ["submit", "--input", response(repo, [
        { id: "design-tokens", status: "n/a" },
        { id: "all-entry-paths", status: "pass" },
      ]), "--base", "develop", "--config", ".shipkit.yml", "--yes"],
      repo,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("readiness-note-required");
    expect(result.stderr).toContain("design-tokens");
  });

  it("refuses an id no rule has", () => {
    const repo = scratch();
    writeFileSync(join(repo, "View.swift"), "import SwiftUI\n", "utf8");

    const result = run(
      ["submit", "--input", response(repo, [
        { id: "design-token", status: "pass" },
        { id: "all-entry-paths", status: "pass" },
      ]), "--base", "develop", "--config", ".shipkit.yml", "--yes"],
      repo,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("readiness-unknown-rule");
  });

  it("refuses a run whose rules file has gone missing, rather than asking nothing", () => {
    const repo = scratch();
    rmSync(join(repo, "..", "conventions", "readiness.yml"));
    writeFileSync(join(repo, "View.swift"), "import SwiftUI\n", "utf8");

    const result = run(["brief", "--base", "develop", "--config", ".shipkit.yml"], repo);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Cannot read readiness rules at");
  });
});
