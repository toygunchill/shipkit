import { beforeEach, describe, expect, it, vi } from "vitest";

// Asserts the exact argv sent to `git` for every readRepoState invocation, rather than
// just observing behaviour — the fake runner in github.test.ts used to only check that an
// expected substring was *among* the call args, which is exactly the gap that let the
// `--base` argument-injection Critical slip through review undetected.
const execFileSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

const { readRepoRoot, readRepoState, readUntrackedFiles } = await import("../../src/vcs/git.js");

beforeEach(() => {
  execFileSyncMock.mockReset();
  execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
    if (args[0] === "rev-parse") return "feature/x\n";
    return "";
  });
});

function calls(): string[][] {
  return execFileSyncMock.mock.calls.map(([, args]) => args as string[]);
}

describe("readRepoState git invocations", () => {
  it("sends --end-of-options immediately before the range on every diff/log call", () => {
    readRepoState("main", "/some/repo");

    expect(calls()).toEqual([
      ["rev-parse", "--abbrev-ref", "HEAD"],
      ["diff", "--name-only", "--end-of-options", "main...HEAD"],
      ["diff", "--stat", "--end-of-options", "main...HEAD"],
      ["log", "--format=%s", "--end-of-options", "main..HEAD"],
    ]);
  });

  it("still puts --end-of-options before a base crafted to look like a git flag", () => {
    readRepoState("--output=/tmp/shipkit_probe", "/some/repo");

    const rangeCalls = calls().filter((args) => args[0] === "diff" || args[0] === "log");
    expect(rangeCalls).toHaveLength(3);
    for (const args of rangeCalls) {
      const endIndex = args.indexOf("--end-of-options");
      const rangeIndex = args.findIndex((arg) => arg.includes("--output=/tmp/shipkit_probe"));
      expect(endIndex).toBeGreaterThanOrEqual(0);
      expect(rangeIndex).toBeGreaterThan(endIndex);
    }
  });

  it("passes cwd through to every git invocation", () => {
    readRepoState("main", "/some/repo");
    for (const call of execFileSyncMock.mock.calls as [string, string[], { cwd?: string }][]) {
      expect(call[2]?.cwd).toBe("/some/repo");
    }
  });
});

describe("readUntrackedFiles", () => {
  it("asks git only for untracked files that are not ignored", () => {
    execFileSyncMock.mockImplementation(() => "");
    readUntrackedFiles("/some/repo");
    expect(calls()).toEqual([
      ["ls-files", "--others", "--exclude-standard", "--full-name", "--", ":/"],
    ]);
  });

  // `git ls-files --others` alone reports only what sits below the working directory, so
  // from a subdirectory the warning would go silent about root-level files that staging
  // sweeps in regardless. `:/` plus `--full-name` make it a question about the repository.
  it("asks about the whole repository, not just the working directory", () => {
    execFileSyncMock.mockImplementation(() => "");
    readUntrackedFiles("/some/repo/sub");
    expect(calls()[0]).toContain(":/");
    expect(calls()[0]).toContain("--full-name");
  });

  it("splits the output into paths and drops the trailing blank", () => {
    execFileSyncMock.mockImplementation(() => ".env.local\nnotes.md\n");
    expect(readUntrackedFiles("/some/repo")).toEqual([".env.local", "notes.md"]);
  });

  it("returns an empty list for a clean tree", () => {
    execFileSyncMock.mockImplementation(() => "");
    expect(readUntrackedFiles("/some/repo")).toEqual([]);
  });
});

describe("readRepoRoot", () => {
  it("asks git for the worktree top level and trims it", () => {
    execFileSyncMock.mockImplementation(() => "/some/repo\n");
    expect(readRepoRoot("/some/repo/sub")).toBe("/some/repo");
    expect(calls()).toEqual([["rev-parse", "--show-toplevel"]]);
  });
});
