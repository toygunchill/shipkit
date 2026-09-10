import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const CONFIG = resolve("tests/fixtures/valid.shipkit.yml");
const CLI = resolve("dist/cli.js");
const TITLE = "[ABC-31087] fix(invoice): default citizenship from passenger info";

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function bodyFile(content: string): string {
  const path = join(tempDir("shipkit-"), "body.md");
  writeFileSync(path, content, "utf8");
  return path;
}

type RunResult = { status: number; stdout: string; stderr: string };

function run(args: string[], options: { cwd?: string; env?: Record<string, string | undefined> } = {}): RunResult {
  const merged: Record<string, string | undefined> = { ...process.env, ...options.env };
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined) env[key] = value;
  }
  try {
    const stdout = execFileSync("node", [CLI, ...args], { encoding: "utf8", cwd: options.cwd, env });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    return { status: failure.status, stdout: failure.stdout, stderr: failure.stderr };
  }
}

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function initRepoOnBranch(branch: string): string {
  const repo = tempDir("shipkit-check-repo-");
  git(["init", "-q", "-b", branch], repo);
  git(["config", "user.email", "t@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "base"], repo);
  return repo;
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

// A conforming branch, passed explicitly so these tests exercise title/body validation
// only and do not incidentally depend on whichever branch the test runner happens to be
// checked out on (check now defaults --branch to the real checked-out branch — see the
// dedicated "defaulting --branch" tests below).
const CONFORMING_BRANCH = "bugfix/squadb/31087-invoice-default-citizenship";

describe("shipkit check", () => {
  it("exits 0 on a compliant PR and prints exactly 'ok' on stdout", () => {
    const result = run([
      "check", "--title", TITLE, "--body-file", bodyFile(goodBody),
      "--config", CONFIG, "--branch", CONFORMING_BRANCH,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ok\n");
    expect(result.stderr).toBe("");
  });

  it("exits 1 and prints the finding as '<rule>: <message>' on stderr", () => {
    const result = run([
      "check", "--title", "nope", "--body-file", bodyFile(goodBody),
      "--config", CONFIG, "--branch", CONFORMING_BRANCH,
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "title-pattern: Title does not match ^\\[DCP-\\d+\\] (feat|fix|chore|ref|docs)(\\([a-z0-9-]+\\))?: .+\n",
    );
  });

  it("exits 2 when the config is missing", () => {
    const result = run(["check", "--title", TITLE, "--body-file", bodyFile(goodBody), "--config", "nope.yml"]);
    expect(result.status).toBe(2);
  });

  it("exits 2 when the body file does not exist", () => {
    const result = run([
      "check",
      "--title",
      TITLE,
      "--body-file",
      "tests/fixtures/does-not-exist.md",
      "--config",
      CONFIG,
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("does-not-exist.md");
  });

  it("exits 2 on a missing required option instead of commander's default 1", () => {
    const result = run(["check", "--body-file", bodyFile(goodBody), "--config", CONFIG]);
    expect(result.status).toBe(2);
  });
});

describe("shipkit check defaults --branch to the checked-out branch", () => {
  it("reads the branch from git and reports branch-pattern for a non-conforming one", () => {
    const repo = initRepoOnBranch("not-a-valid-branch-name");
    const result = run(
      ["check", "--title", TITLE, "--body-file", bodyFile(goodBody), "--config", CONFIG],
      { cwd: repo },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("branch-pattern");
  });

  it("passes when the checked-out branch conforms, with no --branch given", () => {
    const repo = initRepoOnBranch(CONFORMING_BRANCH);
    const result = run(
      ["check", "--title", TITLE, "--body-file", bodyFile(goodBody), "--config", CONFIG],
      { cwd: repo },
    );
    expect(result.status).toBe(0);
  });

  it("an explicit --branch still overrides the checked-out branch", () => {
    const repo = initRepoOnBranch(CONFORMING_BRANCH);
    const result = run(
      [
        "check", "--title", TITLE, "--body-file", bodyFile(goodBody),
        "--config", CONFIG, "--branch", "not-a-valid-branch-name",
      ],
      { cwd: repo },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("branch-pattern");
  });

  it("skips the rule silently when run outside a git repository", () => {
    const notARepo = tempDir("shipkit-not-a-repo-");
    const result = run(
      ["check", "--title", TITLE, "--body-file", bodyFile(goodBody), "--config", CONFIG],
      { cwd: notARepo },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("branch-pattern");
  });
});

describe("shipkit check --issue token gating", () => {
  it("exits 2 when --issue is passed but SHIPKIT_JIRA_TOKEN is unset", () => {
    const result = run(
      [
        "check", "--title", TITLE, "--body-file", bodyFile(goodBody),
        "--config", CONFIG, "--branch", CONFORMING_BRANCH, "--issue", "ABC-31086",
      ],
      { env: { SHIPKIT_JIRA_TOKEN: undefined } },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("SHIPKIT_JIRA_TOKEN");
  });

  it("stays silent (does not touch Jira or the token) when --issue is not passed", () => {
    const result = run(
      [
        "check", "--title", TITLE, "--body-file", bodyFile(goodBody),
        "--config", CONFIG, "--branch", CONFORMING_BRANCH,
      ],
      { env: { SHIPKIT_JIRA_TOKEN: undefined } },
    );
    expect(result.status).toBe(0);
  });
});
