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

/** The same repository, plus a UIKit screen on the base and its SwiftUI rewrite sitting
 *  uncommitted in the working tree — the state an agent leaves when it has just finished
 *  the work and has not reached the gate. */
function buildConvertingRepo(): string {
  const repo = tempDir("shipkit-brief-convert-");
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  writeFileSync(
    join(repo, "Summary.swift"),
    "import UIKit\nfinal class S: UIViewController { @IBOutlet var l: UILabel! }\n",
  );
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "base"], repo);
  git(["checkout", "-q", "-b", "feature/x"], repo);
  writeFileSync(
    join(repo, "Summary.swift"),
    'import SwiftUI\nstruct S: View { @State var n = 0\n  var body: some View { Text("x") } }\n',
  );
  return repo;
}

/** The same converting repository, plus the reason the read of it fails: a `.gitattributes`
 *  clean filter marked `required` whose binary does not exist. This is the git-lfs-not-
 *  installed shape, reproduced against the built CLI — `readPushChangedFiles` runs
 *  `git add --all` into a scratch index, git runs the filter, and the whole command exits
 *  non-zero. Nothing is wrong with the change itself.
 *
 *  A config-level filter rather than a chmod: it does not depend on the uid the tests run
 *  as, so it fails the same way for root. */
function buildUnreadableRepo(): string {
  const repo = buildConvertingRepo();
  writeFileSync(join(repo, ".gitattributes"), "*.bin filter=shipkit-missing\n");
  git(["config", "filter.shipkit-missing.clean", "shipkit-no-such-binary clean -- %f"], repo);
  git(["config", "filter.shipkit-missing.required", "true"], repo);
  git(["add", ".gitattributes"], repo);
  writeFileSync(join(repo, "asset.bin"), "binary\n");
  return repo;
}

describe("shipkit brief", () => {
  // The gap this closes: `detectConversion` existed, was tested, and nothing called it. This
  // is the assertion that it is reachable from the command a person actually runs — and it
  // is made against work that is entirely uncommitted, which is where a `base...HEAD` reader
  // would report nothing.
  it("carries the conversion advice for work that is not committed yet", () => {
    const repo = buildConvertingRepo();

    const result = run(["brief", "--base", "main", "--config", CONFIG], { cwd: repo });

    expect(result.status).toBe(0);
    const brief = JSON.parse(result.stdout) as {
      change: { files: string[] };
      advice?: { topic: string; message: string }[];
    };
    // Nothing is committed, so the committed range names no files at all.
    expect(brief.change.files).toEqual([]);
    expect(brief.advice?.map((item) => item.topic)).toEqual(["uikit-to-swiftui"]);
    expect(brief.advice?.[0]?.message).toContain("shipkit tech-task --subject");
  });

  it("emits no advice key for a change that converts nothing", () => {
    const repo = buildRepo();

    const result = run(["brief", "--base", "main", "--config", CONFIG], { cwd: repo });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).not.toHaveProperty("advice");
  });

  // The serious one. `readPushChangedFiles` is far more machinery than the rest of `brief`
  // needs — a scratch index and a real `git add --all` — and it fails on ordinary
  // repositories. Advice informs and never gates, so a failed advisory read has to yield no
  // advice, never a failed run. Before the guard this exited 2 and printed no brief at all.
  it("prints the brief and exits 0 when the advisory read fails on a broken clean filter", () => {
    const repo = buildUnreadableRepo();

    // The failure is real: git itself refuses to stage this tree.
    expect(() => git(["add", "--all"], repo)).toThrow();

    const result = run(["brief", "--base", "main", "--config", CONFIG], { cwd: repo });

    expect(result.status).toBe(0);
    const brief = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(brief).toHaveProperty("template");
    // No advice rather than wrong advice, and nothing on stderr: there is nothing a reader
    // could do about it, and a line of git plumbing under every brief is how a channel
    // stops being read.
    expect(brief).not.toHaveProperty("advice");
    expect(result.stderr).toBe("");
  });

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
