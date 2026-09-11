import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

const { commitAll, createPullRequest, pushBranch } = await import("../../src/vcs/mutate.js");
const { findPullRequest } = await import("../../src/vcs/github.js");

beforeEach(() => {
  execFileSyncMock.mockReset();
  execFileSyncMock.mockImplementation(() => "");
});

function directories(): (string | undefined)[] {
  return execFileSyncMock.mock.calls.map(
    ([, , options]) => (options as { cwd?: string } | undefined)?.cwd,
  );
}

describe("cwd reaches the child process", () => {
  it("commitAll runs git in the directory it was given", () => {
    commitAll("m", [], "/some/repo");
    expect(directories()).toEqual(["/some/repo", "/some/repo"]);
  });

  it("pushBranch runs git in the directory it was given", () => {
    pushBranch("feature/x", "/some/repo");
    expect(directories()).toEqual(["/some/repo"]);
  });

  it("findPullRequest runs gh in the directory it was given", () => {
    execFileSyncMock.mockImplementation(() => "[]");
    findPullRequest("feature/x", "/some/repo");
    expect(directories()).toEqual(["/some/repo"]);
  });

  // The other three adapters here are pinned at the child-process boundary; createPullRequest
  // previously appeared only with an injected runner, which proves nothing about its default.
  // It is the adapter that opens the pull request, and gh picks its target repository from
  // its own working directory — the one dependency this file exists to prove reaches the
  // child process correctly.
  it("createPullRequest runs gh in the directory it was given", () => {
    execFileSyncMock.mockImplementation(() => "https://example.com/pr/1");
    createPullRequest(
      { title: "t", body: "b", base: "develop", head: "feature/x" },
      "/some/repo",
    );
    expect(directories()).toEqual(["/some/repo"]);
  });

  // Without this, a default of `process.cwd()` captured at module load would pass every
  // test above while still ignoring the argument in the one case that matters.
  it("uses different directories on different calls", () => {
    pushBranch("a", "/repo/one");
    pushBranch("b", "/repo/two");
    expect(directories()).toEqual(["/repo/one", "/repo/two"]);
  });
});
