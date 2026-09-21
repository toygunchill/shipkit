import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../src/approval/protocol.js";

const execFileAsync = promisify(execFile);

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
const CONFORMING_BRANCH = "bugfix/squad/31087-invoice-default-citizenship";

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
      "title-pattern: Title does not match ^\\[ABC-\\d+\\] (feat|fix|chore|ref|docs)(\\([a-z0-9-]+\\))?: .+\n",
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
  const servers: Server[] = [];
  const socketDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
    for (const dir of socketDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fakeSocketPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "shipkit-check-socket-"));
    socketDirs.push(dir);
    return join(dir, "approvals.sock");
  }

  /** A fake approval surface that answers every token request with `secret`. */
  function listenWithToken(path: string, secret: string): Promise<void> {
    const server = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        socket.end(`${JSON.stringify({ protocol: PROTOCOL_VERSION, kind: "token", secret })}\n`);
      });
    });
    servers.push(server);
    return new Promise((resolve) => server.listen(path, () => resolve()));
  }

  // Pinned to a socket path nobody is listening on so this stays deterministic
  // regardless of whether a real menu-bar app happens to be running on the
  // machine the tests execute on.
  it("exits 2 when --issue is passed but no token is available from the environment or the socket", () => {
    const result = run(
      [
        "check", "--title", TITLE, "--body-file", bodyFile(goodBody),
        "--config", CONFIG, "--branch", CONFORMING_BRANCH, "--issue", "ABC-31086",
      ],
      { env: { SHIPKIT_JIRA_TOKEN: undefined, SHIPKIT_APPROVAL_SOCKET: fakeSocketPath() } },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("SHIPKIT_JIRA_TOKEN");
  });

  // The token check must go through `jiraToken()`, not a direct `process.env` read, so a
  // token saved through the menu-bar app's Settings pane — which lives behind the socket,
  // not the environment — also satisfies `--issue`. Proven by making the socket the only
  // source of a token and a Jira baseUrl nobody can reach: reaching a "cannot reach Jira"
  // failure (rather than "no token is available") shows the socket's token was picked up
  // and used, not skipped over.
  it("falls back to the approval surface's socket for the token, exactly as submit does", async () => {
    const socket = fakeSocketPath();
    await listenWithToken(socket, "s3cret-from-socket");

    const configPath = join(tempDir("shipkit-check-cfg-"), "local.shipkit.yml");
    writeFileSync(
      configPath,
      [
        "pr:",
        "  titlePattern: '.*'",
        "  forbidden: []",
        "  sections:",
        "    - name: Summary",
        "      required: false",
        "branch:",
        "  pattern: '.*'",
        "jira:",
        "  baseUrl: http://127.0.0.1:1/jira",
        "  keyPattern: 'ABC-\\d+'",
        "  linkPolicy: story",
      ].join("\n"),
      "utf8",
    );

    // Not the shared `run()` helper: that shells out with `execFileSync`, which blocks
    // this process's event loop until the child exits — and the fake socket server
    // above lives in this same process, so it would never get to accept the child's
    // connection. `execFile` (promisified) keeps the event loop free while the child
    // runs, the same way the real approval surface is a separate process from shipkit.
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries({
      ...process.env,
      SHIPKIT_JIRA_TOKEN: undefined,
      SHIPKIT_APPROVAL_SOCKET: socket,
    })) {
      if (value !== undefined) env[key] = value;
    }

    const result = await execFileAsync(
      "node",
      [
        CLI, "check", "--title", TITLE, "--body-file", bodyFile(goodBody),
        "--config", configPath, "--branch", CONFORMING_BRANCH, "--issue", "ABC-31086",
      ],
      { encoding: "utf8", env },
    ).then(
      (r) => ({ status: 0, stdout: r.stdout, stderr: r.stderr }),
      (e: { code: number; stdout: string; stderr: string }) => ({
        status: e.code,
        stdout: e.stdout,
        stderr: e.stderr,
      }),
    );

    expect(result.status).toBe(2);
    expect(result.stderr).not.toContain("no Jira token is available");
    expect(result.stderr).toContain("Cannot reach Jira");
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
