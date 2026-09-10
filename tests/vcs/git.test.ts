import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { readRepoState, VcsError } from "../../src/vcs/git.js";

let repo: string;

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "shipkit-git-"));
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
});

describe("readRepoState", () => {
  it("reports the current branch", () => {
    expect(readRepoState("main", repo).branch).toBe("feature/x");
  });

  it("lists files changed against the base", () => {
    expect(readRepoState("main", repo).changedFiles.sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("returns a diffstat mentioning both files", () => {
    const stat = readRepoState("main", repo).diffstat;
    expect(stat).toContain("a.txt");
    expect(stat).toContain("b.txt");
  });

  it("lists commit subjects not on the base", () => {
    expect(readRepoState("main", repo).commits).toEqual(["feat: add b and change a"]);
  });

  it("throws VcsError for an unknown base", () => {
    expect(() => readRepoState("no-such-branch", repo)).toThrow(VcsError);
  });

  it("excludes commits added to base after feature branch diverged", () => {
    // Simulate advancing the base branch after feature branch creation
    git(["checkout", "-q", "main"], repo);
    writeFileSync(join(repo, "c.txt"), "base-only\n");
    git(["add", "."], repo);
    git(["commit", "-q", "-m", "fix: base branch update"], repo);
    git(["checkout", "-q", "feature/x"], repo);

    // The commits should only include the feature branch commit, not the base's
    expect(readRepoState("main", repo).commits).toEqual(["feat: add b and change a"]);
  });
});
