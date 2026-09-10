import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

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

function run(
  args: string[],
  options: { env?: Record<string, string>; cwd?: string } = {},
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...options.env },
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    return { status: failure.status, stdout: failure.stdout, stderr: failure.stderr };
  }
}

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function buildRepo(): string {
  const repo = tempDir("shipkit-brief-repo-");
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
  return repo;
}

describe("shipkit brief", () => {
  it("exits 2 and lists targets when no base is given and stdin is not a terminal", () => {
    const result = run(["brief", "--config", CONFIG]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--base");
  });

  it("exits 2 and creates no file when --base is a git-option-shaped argument", () => {
    // The Critical this pins: `--base "--output=..."` used to be handed straight to `git
    // diff`/`git log`, which parsed it as a flag and wrote the diff to that path — a
    // read-only command mutating the filesystem, at exit 0.
    const repo = buildRepo();
    const marker = `shipkit_probe_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const maliciousBase = `--output=${join(tmpdir(), marker)}`;

    const result = run(["brief", "--base", maliciousBase, "--config", CONFIG], { cwd: repo });

    expect(result.status).not.toBe(0);
    expect(result.status).toBe(2);
    const created = readdirSync(tmpdir()).filter((name) => name.startsWith(marker));
    expect(created).toEqual([]);
  });

  it("emits a brief whose JSON describes the actual change, with no truncation", () => {
    const repo = buildRepo();

    const result = run(["brief", "--base", "main", "--config", CONFIG], { cwd: repo });

    expect(result.status).toBe(0);
    let brief: unknown;
    expect(() => {
      brief = JSON.parse(result.stdout);
    }).not.toThrow();

    expect(brief).toMatchObject({
      change: {
        branch: "feature/x",
        files: expect.arrayContaining(["a.txt", "b.txt"]) as unknown,
        commits: ["feat: add b and change a"],
      },
      target: { branch: "main", reason: "given with --base" },
    });
    expect((brief as { change: { files: string[] } }).change.files.sort()).toEqual(["a.txt", "b.txt"]);
    expect(brief).toHaveProperty("template.sections");
    expect(brief).toHaveProperty("rules.titlePattern");
    expect(brief).not.toHaveProperty("ticket");
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
