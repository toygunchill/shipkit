import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assembleBrief } from "../../src/brief/assemble.js";
import { resolveIssue } from "../../src/cli-support.js";
import { loadConfig } from "../../src/config/load.js";
import { observedChangedFiles } from "../../src/advice/observe.js";
import { applicable, observedPaths } from "../../src/readiness/apply.js";
import { loadReadiness } from "../../src/readiness/load.js";
import {
  archiveFixRequest,
  fixRequestExclusions,
  readFixRequest,
  writeFixRequest,
} from "../../src/review/fixrequest.js";
import { runReview, type ReviewDeps } from "../../src/review/run.js";
import type { ReviewHandler } from "../../src/review/server.js";
import { renderBody } from "../../src/submit/response.js";
import { runSubmit, type SubmitDeps } from "../../src/submit/run.js";
import {
  currentBranch,
  readHeadSha,
  readPushAddedLines,
  readPushChangedFiles,
  readPushChangedPaths,
  readPushDiff,
  readPushDiffstat,
  readRepoRoot,
  readRepoState,
  readUntrackedFiles,
} from "../../src/vcs/git.js";
import { commitAll } from "../../src/vcs/mutate.js";

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
`;

const SWIFT = `import SwiftUI

struct InvoiceScreen: View {
  var body: some View {
    Text("invoice")
  }
}
`;

const XIB = `<?xml version="1.0" encoding="UTF-8"?>
<document type="com.apple.InterfaceBuilder3.CocoaTouch.XIB">
  <objects>
    <viewController id="a" customClass="InvoiceViewController" customModule="App"/>
  </objects>
</document>
`;

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * A repository with a conversion nobody has committed and an untracked file staging would
 * sweep in. No remote, no socket, no forge — the two adapters that would reach one are the
 * only fakes in the whole file.
 */
function scratch(): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "shipkit-review-e2e-")));
  tempDirs.push(repo);
  git(["init", "-b", "develop", "."], repo);
  git(["config", "user.email", "t@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  writeFileSync(join(repo, ".shipkit.yml"), CONFIG, "utf8");
  writeFileSync(join(repo, "readiness.yml"), RULES, "utf8");
  mkdirSync(join(repo, "Sources"), { recursive: true });
  writeFileSync(join(repo, "Sources/InvoiceScreen.xib"), XIB, "utf8");
  git(["add", "--all"], repo);
  git(["commit", "-m", "init"], repo);

  git(["checkout", "-b", "bugfix/squadb/31087-invoice"], repo);
  // The conversion, entirely uncommitted — the state `commitAll` stages after the gate, and
  // the state a review of `base...HEAD` would show as empty. The two names correspond,
  // which is what `detectConversion` requires before a deleted interface file counts as
  // evidence of anything (see src/advice/uikit.ts).
  rmSync(join(repo, "Sources/InvoiceScreen.xib"));
  writeFileSync(join(repo, "Sources/InvoiceScreen.swift"), SWIFT, "utf8");
  // A pre-flight warning with nothing to do with the conversion.
  writeFileSync(join(repo, ".env.local"), "TOKEN=sekret\n", "utf8");
  return repo;
}

function reviewDeps(
  repo: string,
  hold: { handler?: ReviewHandler; release?: () => void },
): ReviewDeps {
  const configPath = join(repo, ".shipkit.yml");
  return {
    loadConfig: () => loadConfig(configPath),
    loadResponse: () => {
      throw new Error("no response file in this run");
    },
    renderBody,
    currentBranch: () => currentBranch(repo),
    resolveIssue,
    loadReadiness: () => loadReadiness(configPath, "./readiness.yml"),
    readRepoState: (base) => readRepoState(base, repo),
    readPushDiffstat: (base, exclude) => readPushDiffstat(base, exclude, repo),
    readPushAddedLines: (base, exclude) => readPushAddedLines(base, exclude, repo),
    readPushChangedFiles: (base, exclude) => readPushChangedFiles(base, exclude, repo),
    readPushChangedPaths: (base, exclude) => readPushChangedPaths(base, exclude, repo),
    readPushDiff: (base, exclude) => readPushDiff(base, exclude, repo),
    readUntrackedFiles: () => readUntrackedFiles(repo),
    readRepoRoot: () => readRepoRoot(repo),
    realpath: (path) => realpathSync(path),
    // The one fake: there is no remote and no `gh`, and `review` pushes nothing, so a forge
    // it cannot reach is three pre-flight checks that do not run.
    findPullRequest: () => null,
    fixRequestExclusions: () => fixRequestExclusions(repo),
    writeFixRequest: (request) => writeFixRequest(repo, request),
    // No socket is ever opened. The handler is captured and called directly.
    listen: (handler) => {
      hold.handler = handler;
      return Promise.resolve({
        origin: "http://127.0.0.1:1",
        close: () => Promise.resolve(),
      });
    },
    now: () => new Date("2026-09-17T10:00:00.000Z"),
    wait: () =>
      new Promise<void>((resolve) => {
        hold.release = resolve;
      }),
    out: () => undefined,
    err: () => undefined,
  };
}

describe("shipkit review, end to end, against a real repository", () => {
  it("shows the uncommitted conversion and the warning, then writes what was ticked", async () => {
    const repo = scratch();
    const hold: { handler?: ReviewHandler; release?: () => void } = {};
    const printed: string[] = [];
    const deps = { ...reviewDeps(repo, hold), out: (line: string) => printed.push(line) };

    const running = runReview(
      { base: "develop", config: join(repo, ".shipkit.yml"), port: 0, open: false },
      deps,
    );
    // Let the assessment and the page happen, then act as the browser would.
    for (let i = 0; i < 8; i++) await Promise.resolve();

    const token = new URL(printed[0] as string).searchParams.get("token") as string;
    const page = (hold.handler as ReviewHandler)({
      method: "GET",
      url: `/?token=${token}`,
      remoteAddress: "127.0.0.1",
      body: "",
    }).body;

    // The change, read through the scratch index: the conversion is entirely uncommitted.
    expect(page).toContain("Sources/InvoiceScreen.swift");
    expect(page).toContain("Sources/InvoiceScreen.xib");
    expect(page).toContain("struct InvoiceScreen: View");
    // The findings: a pre-flight warning, the conversion advice, and the unanswered rule.
    expect(page).toContain("untracked-files");
    expect(page).toContain(".env.local");
    expect(page).toContain("uikit-to-swiftui");
    expect(page).toContain("readiness-unanswered");
    expect(page).toContain("Readiness answers are absent");

    (hold.handler as ReviewHandler)({
      method: "POST",
      url: `/submit?token=${token}`,
      remoteAddress: "127.0.0.1",
      body: JSON.stringify({
        items: [
          {
            kind: "warning",
            id: "untracked-files",
            message: "staging sweeps .env.local",
            note: "add it to .gitignore, do not commit it",
          },
          {
            kind: "advice",
            id: "uikit-to-swiftui",
            message: "this looks like a conversion",
            note: "open the tech task before you push",
          },
        ],
      }),
    });

    const result = await running;

    expect(result.code).toBe(0);
    const written = readFixRequest(repo);
    expect(written?.base).toBe("develop");
    expect(written?.branch).toBe("bugfix/squadb/31087-invoice");
    expect(written?.items.map((item) => item.id)).toEqual(["untracked-files", "uikit-to-swiftui"]);
    expect(written?.items[1]?.note).toBe("open the tech task before you push");
  });

  it("carries the selection into the next brief, first, and then out again on a push", async () => {
    const repo = scratch();
    // Injected: an archive must never land in the developer's real Application Support.
    const archives = join(scratch(), "archives");
    const configPath = join(repo, ".shipkit.yml");
    writeFixRequest(repo, {
      version: 1,
      createdAt: "2026-09-17T10:00:00.000Z",
      base: "develop",
      branch: "bugfix/squadb/31087-invoice",
      items: [
        { kind: "warning", id: "untracked-files", message: "m", note: "add it to .gitignore" },
      ],
    });

    // The brief, assembled from the same real reads the CLI makes.
    const rules = loadReadiness(configPath, "./readiness.yml");
    const brief = assembleBrief({
      repo: readRepoState("develop", repo),
      target: { branch: "develop", reason: "given with --base" },
      config: loadConfig(configPath),
      changed: observedChangedFiles(() => readPushChangedFiles("develop", [], repo)),
      readiness: applicable(rules, observedPaths(() => readPushChangedPaths("develop", [], repo))),
      fixRequest: readFixRequest(repo),
    });
    const json = JSON.stringify(brief, null, 2);

    expect(json.indexOf('"fixRequest"')).toBeLessThan(json.indexOf('"change"'));
    expect(json).toContain("add it to .gitignore");
    expect(json).toContain("A person read this change in shipkit review");

    // And the submit that follows: the selection is not committed, and it is moved aside.
    const deps: SubmitDeps = {
      loadConfig: () => loadConfig(configPath),
      renderBody,
      currentBranch: () => currentBranch(repo),
      resolveIssue,
      loadReadiness: () => rules,
      readRepoState: (base) => readRepoState(base, repo),
      readPushDiffstat: (base, exclude) => readPushDiffstat(base, exclude, repo),
      readPushAddedLines: (base, exclude) => readPushAddedLines(base, exclude, repo),
      readPushChangedFiles: (base, exclude) => readPushChangedFiles(base, exclude, repo),
      readPushChangedPaths: (base, exclude) => readPushChangedPaths(base, exclude, repo),
      findPullRequest: () => null,
      readUntrackedFiles: () => readUntrackedFiles(repo),
      fixRequestExclusions: () => fixRequestExclusions(repo),
      archiveFixRequest: () => archiveFixRequest(repo, new Date("2026-09-17T11:00:00.000Z"), archives),
      readRepoRoot: () => readRepoRoot(repo),
      readHeadSha: () => readHeadSha(repo),
      realpath: (path) => realpathSync(path),
      requestApproval: async () => ({ outcome: "no-surface" as const }),
      // The real commit, against the real repository. Only the two adapters that would need
      // a remote are faked.
      commitAll: (message, exclude) => commitAll(message, exclude, repo),
      pushBranch: () => undefined,
      createPullRequest: () => "https://example.com/pr/1",
      out: () => undefined,
      err: () => undefined,
    };

    const result = await runSubmit(
      {
        base: "develop",
        config: configPath,
        response: {
          title: "[ABC-1] fix(invoice): convert the screen",
          commitMessage: "fix(invoice): convert the screen",
          sections: {
            Summary: "It was UIKit; now it is SwiftUI.",
            "What to Test": "- one\n- two\n- three",
            "Issues Addressed": "- [ABC-1](https://jira.example.com/browse/ABC-1)",
          },
          readiness: [{ id: "design-tokens", status: "pass" }],
        },
        mode: "apply",
        acknowledge: "all",
      },
      deps,
    );

    expect(result.code).toBe(0);
    // The commit exists and does not carry the selection.
    const committed = git(["show", "--name-only", "--format=", "HEAD"], repo)
      .split("\n")
      .filter(Boolean);
    expect(committed).toContain("Sources/InvoiceScreen.swift");
    expect(committed.some((path) => path.startsWith(".shipkit/"))).toBe(false);
    // And it has been moved aside, so the next brief cannot carry it again — out of the
    // repository entirely, which is why there is nothing left here to exclude.
    expect(readFixRequest(repo)).toBeUndefined();
    expect(fixRequestExclusions(repo)).toEqual([]);
    // The selection itself survives out there, which is the reason it is moved rather than
    // deleted: after the push, the archive is the only answer to "was what I ticked done?"
    const archived = JSON.parse(
      readFileSync(join(archives, "fix-request-2026-09-17T11-00-00-000Z.json"), "utf8"),
    ) as { items: unknown[] };
    expect(archived.items.length).toBeGreaterThan(0);
  });

  it("leaves the selection where it is when the submit refuses", async () => {
    const repo = scratch();
    const configPath = join(repo, ".shipkit.yml");
    const selection = {
      version: 1 as const,
      createdAt: "2026-09-17T10:00:00.000Z",
      base: "develop",
      branch: "bugfix/squadb/31087-invoice",
      items: [{ kind: "warning" as const, id: "untracked-files", message: "m", note: "n" }],
    };
    writeFixRequest(repo, selection);

    const result = await runSubmit(
      {
        base: "develop",
        config: configPath,
        // A title that does not match, so validation refuses before anything is committed.
        response: {
          title: "no ticket here",
          commitMessage: "x",
          sections: {
            Summary: "s",
            "What to Test": "- one\n- two\n- three",
            "Issues Addressed": "- [ABC-1](https://jira.example.com/browse/ABC-1)",
          },
        },
        mode: "apply",
        acknowledge: "all",
      },
      {
        loadConfig: () => loadConfig(configPath),
        renderBody,
        currentBranch: () => currentBranch(repo),
        resolveIssue,
        readRepoState: (base) => readRepoState(base, repo),
        readPushDiffstat: (base, exclude) => readPushDiffstat(base, exclude, repo),
        readPushAddedLines: (base, exclude) => readPushAddedLines(base, exclude, repo),
        readPushChangedFiles: (base, exclude) => readPushChangedFiles(base, exclude, repo),
        findPullRequest: () => null,
        readUntrackedFiles: () => readUntrackedFiles(repo),
        fixRequestExclusions: () => fixRequestExclusions(repo),
        archiveFixRequest: () => archiveFixRequest(repo, new Date(), join(scratch(), "archives")),
        readRepoRoot: () => readRepoRoot(repo),
        readHeadSha: () => readHeadSha(repo),
        realpath: (path) => realpathSync(path),
        requestApproval: async () => ({ outcome: "no-surface" as const }),
        commitAll: () => {
          throw new Error("nothing should be committed");
        },
        pushBranch: () => undefined,
        createPullRequest: () => "",
        out: () => undefined,
        err: () => undefined,
      },
    );

    expect(result.code).toBe(1);
    expect(readFixRequest(repo)).toEqual(selection);
  });
});
