import { beforeEach, describe, expect, it, vi } from "vitest";

// Asserts the exact argv sent to `git` for every readRepoState invocation, rather than
// just observing behaviour — the fake runner in github.test.ts used to only check that an
// expected substring was *among* the call args, which is exactly the gap that let the
// `--base` argument-injection Critical slip through review undetected.
const execFileSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

const { readRepoState } = await import("../../src/vcs/git.js");

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
