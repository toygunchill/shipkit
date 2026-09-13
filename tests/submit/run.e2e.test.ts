import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { assembleBrief } from "../../src/brief/assemble.js";
import { loadConfig } from "../../src/config/load.js";
import { resolveIssue } from "../../src/cli-support.js";
import { renderBody } from "../../src/submit/response.js";
import { runSubmit, type SubmitDeps } from "../../src/submit/run.js";
import {
  currentBranch,
  readHeadSha,
  readPushChangedFiles,
  readPushDiffstat,
  readRepoRoot,
  readRepoState,
  readUntrackedFiles,
} from "../../src/vcs/git.js";
import { commitAll, pushBranch } from "../../src/vcs/mutate.js";

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

// Every scratch root created by `scratch()` below, so it can be swept up once the suite is
// done — matching the cleanup pattern tests/cli.submit.test.ts and friends already use for
// their own mkdtempSync directories.
const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** A scratch repository on a branch the fixture's branch.pattern accepts, with a local
 *  bare remote so `git push` is a real push rather than a mock. */
function scratch(): { repo: string; remote: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "shipkit-e2e-")));
  tempDirs.push(root);
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
    readPushDiffstat: (base, exclude) => readPushDiffstat(base, exclude, repo),
    readPushChangedFiles: (base, exclude) => readPushChangedFiles(base, exclude, repo),
    // gh cannot be pointed at a local bare repository, so the two adapters that reach it
    // are the only fakes here. Everything else is the real thing.
    findPullRequest: () => null,
    readUntrackedFiles: () => readUntrackedFiles(repo),
    readRepoRoot: () => readRepoRoot(repo),
    readHeadSha: () => readHeadSha(repo),
    realpath: (path) => realpathSync(path),
    // This suite must never open a real socket — every call here uses acknowledge: "all" or
    // acknowledge: [] with no warnings, so shouldRequestApproval never actually fires this,
    // but a future test that adds a warning must fail loud rather than reach for a real
    // approval surface.
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

describe("runSubmit end to end", () => {
  // resolveIssue is the real one here, and it reads SHIPKIT_JIRA_TOKEN from the environment.
  // Whoever runs this suite with a real token exported must not get a broken test or a live
  // call to a corporate Jira host — so the token is force-unset for the duration of every
  // test in this file and restored afterward, exactly like tests/cli-support.test.ts does for
  // resolveIssue's own unit tests. The intent (issueVerified: false, issue-unverified firing)
  // is unchanged; it is guaranteed now, not merely inherited from an empty environment.
  const originalToken = process.env.SHIPKIT_JIRA_TOKEN;

  beforeEach(() => {
    delete process.env.SHIPKIT_JIRA_TOKEN;
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.SHIPKIT_JIRA_TOKEN;
    else process.env.SHIPKIT_JIRA_TOKEN = originalToken;
  });

  // The spec's Testing section names brief -> preview -> apply as the sequence this suite
  // covers end to end. The two tests below drive preview and apply against real adapters;
  // this one drives the leg that comes before either — the same real readRepoState the other
  // two use, feeding the same real assembleBrief the CLI's `brief` action and shipkit_brief
  // both call, against the same kind of scratch repository.
  it("assembles a brief that reports the branch and the sections the config declares", () => {
    const { repo } = scratch();
    const config = loadConfig(CONFIG);

    const brief = assembleBrief({
      repo: readRepoState("develop", repo),
      target: { branch: "develop", reason: "given" },
      config,
    });

    expect(brief.change.branch).toBe("bugfix/squadb/1-invoice");
    expect(brief.template.sections.map((s) => s.name)).toEqual(
      config.pr.sections.map((s) => s.name),
    );
  });

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

    // The real readUntrackedFiles adapter ran and its answer reached pre-flight: proof the
    // adapters agree, not just that the sequence didn't throw. An adapter regressed to `[]`
    // or to the wrong paths would pass every assertion below without this one.
    const untrackedWarning = result.warnings.find((w) => w.check === "untracked-files");
    expect(untrackedWarning).toBeDefined();
    expect(untrackedWarning?.message).toContain(".env.local");

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

    // And what reached the forge is the pull request this run actually means to open —
    // right title, right body, right base, and — the one that matters most, since targeting
    // the wrong branch is exactly the failure this product exists to prevent — right head.
    const openedInput = opened.input as { title: string; body: string; base: string; head: string };
    expect(openedInput.title).toBe(RESPONSE.title);
    expect(openedInput.base).toBe("develop");
    expect(openedInput.head).toBe("bugfix/squadb/1-invoice");
    expect(openedInput.body).toContain("## What to Test");
  });

  // The failure this change exists for, driven through the whole sequence against a real
  // repository: a branch cut from develop whose entire change is still in the working
  // tree. `git diff --stat develop...HEAD` is empty for it, so the panel used to render a
  // blank line where the size of the change belongs — and then `commitAll` swept every one
  // of those files into the push.
  it("asks about the size of the uncommitted work, not the empty committed range", async () => {
    const { repo } = scratch();
    const responsePath = join(repo, "response.json");
    writeFileSync(responsePath, JSON.stringify(RESPONSE), "utf8");
    for (let i = 0; i < 12; i += 1) {
      writeFileSync(join(repo, `swept-${i}.ts`), `export const n = ${i};\n`, "utf8");
    }

    // The range the panel used to be given.
    expect(readRepoState("develop", repo).diffstat).toBe("");

    let sent: { diffstat: string } | undefined;
    const opened: { input?: unknown } = {};
    const result = await runSubmit(
      {
        base: "develop",
        config: CONFIG,
        response: RESPONSE,
        responsePath,
        mode: "apply",
        acknowledge: [],
      },
      {
        ...realDeps(repo, opened),
        // Denied, so nothing is committed or pushed — the request is the subject here.
        requestApproval: async (request) => {
          sent = request;
          return { outcome: "denied" as const };
        },
      },
    );

    expect(result.code).toBe(2);
    expect(result.committed).toBe(false);
    // app.ts is the tracked file the scratch repository leaves modified; the twelve
    // swept-*.ts are untracked, and `git add --all` would carry all thirteen.
    expect(sent?.diffstat).toContain("13 files changed");
    expect(sent?.diffstat).toContain("swept-0.ts");
    expect(sent?.diffstat).toContain("app.ts");
    // The response file is excluded from staging, so a stat naming it would contradict
    // the commit it describes.
    expect(sent?.diffstat).not.toContain("response.json");
    // And reading it staged nothing.
    expect(
      execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }),
    ).toContain("?? swept-0.ts");
  });

  // The wiring this suite exists to prove reaches the end: `detectConversion` had no caller,
  // so the advice was built and unreachable. Driven here through the real
  // `readPushChangedFiles` against a real repository, with the conversion left *entirely
  // uncommitted* — which is what an agent that has just finished the work leaves, and what a
  // `base...HEAD` reader would be blind to.
  it("advises on an uncommitted conversion, and returns the same code as a run without one", async () => {
    const UIKIT = "import UIKit\nfinal class S: UIViewController { @IBOutlet var l: UILabel! }\n";
    const SWIFTUI = 'import SwiftUI\nstruct S: View { @State var n = 0\n  var body: some View { Text("x") } }\n';

    /** One apply run against a fresh repository, optionally converting a screen in it. */
    async function run(convert: boolean) {
      const { repo } = scratch();
      const responsePath = join(repo, "response.json");
      writeFileSync(responsePath, JSON.stringify(RESPONSE), "utf8");
      if (convert) {
        // Committed on the base as UIKit, rewritten as SwiftUI in the working tree and left
        // there. Nothing about the conversion is committed on the branch.
        git(["checkout", "-q", "develop"], repo);
        writeFileSync(join(repo, "Summary.swift"), UIKIT, "utf8");
        git(["add", "Summary.swift"], repo);
        git(["commit", "-q", "-m", "chore: the screen as it was"], repo);
        git(["checkout", "-q", "bugfix/squadb/1-invoice"], repo);
        git(["merge", "-q", "develop"], repo);
        writeFileSync(join(repo, "Summary.swift"), SWIFTUI, "utf8");
      }

      // The range that cannot see it, stated so it cannot quietly stop being true.
      expect(readRepoState("develop", repo).changedFiles).toEqual([]);

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
      return result;
    }

    const advised = await run(true);
    const plain = await run(false);

    expect(advised.advice?.map((item) => item.topic)).toEqual(["uikit-to-swiftui"]);
    expect(advised.advice?.[0]?.message).toContain("1 file");
    expect(plain.advice).toEqual([]);

    // The point of the whole separate type: the observation costs the run nothing.
    expect(advised.code).toBe(plain.code);
    expect(advised.code).toBe(0);
    expect(advised.committed).toBe(true);
    expect(advised.pushed).toBe(true);
  });

  it("previews the same repository without leaving a trace", async () => {
    const { repo } = scratch();
    const beforeHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });
    const beforeStatus = execFileSync("git", ["status", "--porcelain"], {
      cwd: repo,
      encoding: "utf8",
    });

    const opened: { input?: unknown } = {};
    const result = await runSubmit(
      { base: "develop", config: CONFIG, response: RESPONSE, mode: "preview", acknowledge: [] },
      realDeps(repo, opened),
    );

    expect(result.code).toBe(0);
    expect(result.body).toContain("## Summary");
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" })).toBe(
      beforeHead,
    );
    // HEAD alone would miss a stray `git add`: it moves the index, not the branch tip. This
    // covers the index and working tree too, so "without leaving a trace" is actually checked
    // rather than merely the part of it that a bad `git add` wouldn't touch anyway.
    expect(
      execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }),
    ).toBe(beforeStatus);
    expect(opened.input).toBeUndefined();
  });
});
