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
