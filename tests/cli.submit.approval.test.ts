import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Absolute paths: the CLI runs with `cwd` pointed at a scratch repo below, so a relative
// path would resolve against that scratch repo instead of this checkout.
const CONFIG = resolve("tests/fixtures/human-approval.shipkit.yml");
const CLI = resolve("dist/cli.js");

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

// A scratch repository with a develop branch and a feature branch checked out, and an
// untracked file so pre-flight has something to warn about — never this checkout, and
// never pushed anywhere: under `human` with nothing listening, the run must refuse
// before it ever reaches commitAll/pushBranch.
function buildRepo(): string {
  const repo = tempDir("shipkit-human-repo-");
  git(["init", "-q", "-b", "develop"], repo);
  git(["config", "user.email", "t@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "base"], repo);
  git(["checkout", "-q", "-b", "bugfix/squad/31087-invoice"], repo);
  writeFileSync(join(repo, "a.txt"), "two\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "work"], repo);
  writeFileSync(join(repo, ".env.local"), "SECRET=1\n");
  return repo;
}

// findPullRequest shells out to the real `gh` before pre-flight ever runs, and this scratch
// repo has no remote for a real `gh` to resolve — it would fail with its own VcsError before
// the approval path is ever reached. A fake `gh` on PATH ahead of the real one, answering
// `pr list` with an empty array (no open pull request for this branch), lets the run reach
// pre-flight and the approval gate without a real `gh` call of any kind.
function fakeGhDir(): string {
  const dir = tempDir("shipkit-fake-gh-");
  const script = join(dir, "gh");
  writeFileSync(script, "#!/bin/sh\necho '[]'\n", "utf8");
  chmodSync(script, 0o755);
  return dir;
}

function responseFile(): string {
  const body = {
    title: "[ABC-1] fix(x): y",
    commitMessage: "fix(x): y",
    sections: {
      Summary: "It was broken; now it is not.",
      "Screenshots / Screen Recordings": "Nothing to show — logic only.",
      "What to Test": "- one\n- two\n- three",
      "Issues Addressed": "- [ABC-1](https://jira.example.com/browse/ABC-1)",
    },
  };
  const path = join(tempDir("shipkit-human-input-"), "r.json");
  writeFileSync(path, JSON.stringify(body), "utf8");
  return path;
}

function run(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  // SHIPKIT_APPROVAL_SOCKET points at a path with nothing listening, so requestApproval
  // resolves to "no-surface" almost instantly (a real ENOENT/ECONNREFUSED, not a timeout) —
  // no real approval surface, no real git remote, no real gh, ever reached by this file.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SHIPKIT_APPROVAL_SOCKET: join(tempDir("shipkit-nosocket-"), "approvals.sock"),
    PATH: `${fakeGhDir()}:${process.env.PATH ?? ""}`,
  };
  delete env.SHIPKIT_JIRA_TOKEN;
  try {
    const stdout = execFileSync("node", [CLI, ...args], {
      encoding: "utf8",
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const f = error as { status: number; stdout: string; stderr: string };
    return { status: f.status, stdout: f.stdout, stderr: f.stderr };
  }
}

describe("shipkit submit under the human approval policy", () => {
  it("refuses with a no-surface reason and never suggests --yes", () => {
    const repo = buildRepo();
    const r = run(
      ["submit", "--input", responseFile(), "--base", "develop", "--config", CONFIG],
      repo,
    );

    expect(r.status).toBe(2);
    // The core's own sentence names the real problem...
    expect(r.stderr).toMatch(/approval surface/i);
    // ...and the CLI must not append a remedy that cannot fix it. Before the fix, the CLI
    // appended "Re-run with --yes to accept these." for any code-2 result carrying
    // warnings, regardless of why it refused — --yes cannot make a person appear.
    expect(r.stderr).not.toContain("--yes");
  });
});
