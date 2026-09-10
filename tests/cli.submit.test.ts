import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Absolute paths: the CLI runs with `cwd` pointed at a scratch repo below, so a relative
// path would resolve against that scratch repo instead of this checkout.
const CONFIG = resolve("tests/fixtures/valid.shipkit.yml");
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

// A scratch repository, never this checkout — `submit` calls `currentBranch()` (a real `git
// rev-parse`) on its way to every one of these outcomes except the missing-response-file
// case, and must never be given the developer's own working tree to do that in.
function buildRepo(): string {
  const repo = tempDir("shipkit-submit-repo-");
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "base"], repo);
  return repo;
}

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
  const path = join(tempDir("shipkit-sub-"), "r.json");
  writeFileSync(path, JSON.stringify(body), "utf8");
  return path;
}

function run(
  args: string[],
  cwd: string,
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [CLI, ...args], {
      encoding: "utf8",
      cwd,
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
    const repo = buildRepo();
    const r = run(
      ["submit", "--input", responseFile(), "--base", "--output=/tmp/x", "--config", CONFIG],
      repo,
    );
    expect(r.status).toBe(2);
  });

  it("exits 2 when the response file is missing", () => {
    const repo = buildRepo();
    const r = run(
      ["submit", "--input", "tests/fixtures/nope.json", "--base", "develop", "--config", CONFIG],
      repo,
    );
    expect(r.status).toBe(2);
  });

  it("exits 1 and names the rule when the answer does not comply", () => {
    const repo = buildRepo();
    const bad = responseFile({ title: "nope" });
    const r = run(["submit", "--input", bad, "--base", "develop", "--config", CONFIG], repo);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("title-pattern");
  });

  it("does not push when validation fails", () => {
    const repo = buildRepo();
    const bad = responseFile({ title: "nope" });
    const r = run(["submit", "--input", bad, "--base", "develop", "--config", CONFIG], repo);
    expect(r.stderr).not.toContain("https://");
  });
});
