import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { assembleBrief } from "../../src/brief/assemble.js";
import { resolveIssue } from "../../src/cli-support.js";
import { loadConfig } from "../../src/config/load.js";
import { applicable, observedPaths } from "../../src/readiness/apply.js";
import { loadReadiness } from "../../src/readiness/load.js";
import { renderBody } from "../../src/submit/response.js";
import { runSubmit, type SubmitDeps } from "../../src/submit/run.js";
import {
  currentBranch,
  readHeadSha,
  readPushAddedLines,
  readPushChangedFiles,
  readPushChangedPaths,
  readPushDiffstat,
  readRepoRoot,
  readRepoState,
  readUntrackedFiles,
} from "../../src/vcs/git.js";
import { commitAll, pushBranch } from "../../src/vcs/mutate.js";

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
`;

const RESPONSE = {
  title: "[ABC-1] fix(x): y",
  commitMessage: "fix(x): y",
  sections: {
    Summary: "It was broken; now it is not.",
    "What to Test": "- one\n- two\n- three",
    "Issues Addressed": "- [ABC-1](https://jira.example.com/browse/ABC-1)",
  },
};

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Real git, a real bare remote on disk, and the rules reached through a real symbolic link —
 * the deployment model end to end. Only the two adapters that shell out to `gh` are faked,
 * for the reason tests/submit/run.e2e.test.ts records: `gh` cannot be pointed at a local
 * bare repository, and nothing in this suite may touch a network.
 */
function scratch(): { repo: string; config: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "shipkit-readiness-e2e-")));
  tempDirs.push(root);
  const conventions = join(root, "conventions");
  const remote = join(root, "remote.git");
  const repo = join(root, "product");
  mkdirSync(conventions);
  writeFileSync(join(conventions, "shipkit.yml"), CONFIG, "utf8");
  writeFileSync(join(conventions, "readiness.yml"), RULES, "utf8");

  execFileSync("git", ["init", "--bare", "-b", "develop", remote], { stdio: "pipe" });
  execFileSync("git", ["init", "-b", "develop", repo], { stdio: "pipe" });
  git(["config", "user.email", "t@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  git(["remote", "add", "origin", remote], repo);
  writeFileSync(join(repo, "README.md"), "base\n", "utf8");
  git(["add", "--all"], repo);
  git(["commit", "-m", "base"], repo);
  git(["push", "--set-upstream", "origin", "develop"], repo);
  git(["checkout", "-b", "bugfix/squadb/1-invoice"], repo);

  symlinkSync(join(conventions, "shipkit.yml"), join(repo, ".shipkit.yml"));
  // The change itself: written into the working tree and left entirely uncommitted, which
  // is the state `commitAll` exists to sweep up and the state an `appliesTo` filter has to
  // be able to see.
  mkdirSync(join(repo, "Example"), { recursive: true });
  writeFileSync(join(repo, "Example", "View.swift"), "import SwiftUI\n", "utf8");

  return { repo, config: join(repo, ".shipkit.yml") };
}

function realDeps(repo: string, config: string, opened: { input?: unknown }): SubmitDeps {
  return {
    loadConfig,
    renderBody,
    currentBranch: () => currentBranch(repo),
    resolveIssue,
    readRepoState: (base) => readRepoState(base, repo),
    readPushDiffstat: (base, exclude) => readPushDiffstat(base, exclude, repo),
    readPushChangedFiles: (base, exclude) => readPushChangedFiles(base, exclude, repo),
    readPushChangedPaths: (base, exclude) => readPushChangedPaths(base, exclude, repo),
    readPushAddedLines: (base, exclude) => readPushAddedLines(base, exclude, repo),
    loadReadiness: () => {
      const loaded = loadConfig(config);
      return loaded.readiness === undefined
        ? undefined
        : loadReadiness(config, loaded.readiness);
    },
    findPullRequest: () => null,
    readUntrackedFiles: () => readUntrackedFiles(repo),
    readRepoRoot: () => readRepoRoot(repo),
    readHeadSha: () => readHeadSha(repo),
    realpath: (path) => realpathSync(path),
    requestApproval: async () => ({ outcome: "no-surface" as const }),
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

describe("readiness end to end", () => {
  // The real `resolveIssue` reads SHIPKIT_JIRA_TOKEN. Force-unset for the same reason
  // tests/submit/run.e2e.test.ts records: whoever runs this with a real token exported must
  // not make a live call to a corporate Jira host.
  //
  // Unsetting it is necessary and not sufficient: `jiraToken` falls through to the approval
  // surface's socket, which on a machine running the menu-bar app answers with a real token.
  // Measured here, not assumed — the socket was answering while this suite was written. So
  // the socket is pointed at a path that cannot exist, which `readSocketSecret` reports as
  // no token at all.
  const originalToken = process.env.SHIPKIT_JIRA_TOKEN;
  const originalSocket = process.env.SHIPKIT_APPROVAL_SOCKET;
  beforeEach(() => {
    delete process.env.SHIPKIT_JIRA_TOKEN;
    process.env.SHIPKIT_APPROVAL_SOCKET = "/nonexistent/shipkit-tests.sock";
  });
  afterEach(() => {
    if (originalToken === undefined) delete process.env.SHIPKIT_JIRA_TOKEN;
    else process.env.SHIPKIT_JIRA_TOKEN = originalToken;
    if (originalSocket === undefined) delete process.env.SHIPKIT_APPROVAL_SOCKET;
    else process.env.SHIPKIT_APPROVAL_SOCKET = originalSocket;
  });

  it("briefs the rules an uncommitted change reaches, through a symlinked config", () => {
    const { repo, config } = scratch();
    const loaded = loadConfig(config);
    const rules = loadReadiness(config, loaded.readiness as string);

    const brief = assembleBrief({
      repo: readRepoState("develop", repo),
      target: { branch: "develop", reason: "given" },
      config: loaded,
      readiness: applicable(rules, observedPaths(() => readPushChangedPaths("develop", [], repo))),
    });

    expect(brief.readiness?.map((item) => item.id)).toEqual(["design-tokens", "all-entry-paths"]);
    // The committed range sees none of this — which is exactly why the filter reads the
    // scratch index instead.
    expect(brief.change.files).toEqual([]);
  });

  it("refuses an unanswered rule without committing anything", async () => {
    const { repo, config } = scratch();
    const opened: { input?: unknown } = {};

    const result = await runSubmit(
      {
        base: "develop",
        config,
        response: { ...RESPONSE, readiness: [{ id: "design-tokens", status: "pass" }] },
        mode: "apply",
        acknowledge: "all",
      },
      realDeps(repo, config, opened),
    );

    expect(result.code).toBe(1);
    expect(result.findings.map((finding) => finding.rule)).toEqual(["readiness-unanswered"]);
    expect(result.committed).toBe(false);
    expect(opened.input).toBeUndefined();
    // The working tree is untouched: the change is still sitting there uncommitted,
    // reported as the untracked directory git reports it as.
    expect(
      execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }),
    ).toContain("?? Sources/");
  });

  it("carries a warn failure through to the push, once it is acknowledged", async () => {
    const { repo, config } = scratch();
    const opened: { input?: unknown } = {};

    const result = await runSubmit(
      {
        base: "develop",
        config,
        response: {
          ...RESPONSE,
          readiness: [
            { id: "design-tokens", status: "fail", note: "one legacy pgs colour is left" },
            { id: "all-entry-paths", status: "pass" },
          ],
        },
        mode: "apply",
        acknowledge: "all",
      },
      realDeps(repo, config, opened),
    );

    expect(result.code).toBe(0);
    expect(result.warnings.map((warning) => warning.check)).toContain("readiness-design-tokens");
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    // The change really landed, uncommitted work and all.
    expect(
      execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], {
        cwd: repo,
        encoding: "utf8",
      }),
    ).toContain("Sources/View.swift");
  });

  it("refuses to push when that same warning is not acknowledged", async () => {
    const { repo, config } = scratch();
    const opened: { input?: unknown } = {};

    const result = await runSubmit(
      {
        base: "develop",
        config,
        response: {
          ...RESPONSE,
          readiness: [
            { id: "design-tokens", status: "fail", note: "one legacy pgs colour is left" },
            { id: "all-entry-paths", status: "pass" },
          ],
        },
        mode: "apply",
        acknowledge: [],
      },
      realDeps(repo, config, opened),
    );

    expect(result.code).toBe(2);
    expect(result.refusal).toBe("unacknowledged");
    expect(result.committed).toBe(false);
  });
});
