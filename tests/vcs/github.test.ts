import { describe, expect, it } from "vitest";
import { baseCandidates, defaultBranch, findPullRequest } from "../../src/vcs/github.js";
import { VcsError } from "../../src/vcs/types.js";

const DEFAULT_BRANCH_ARGS = ["repo", "view", "--json", "defaultBranchRef"];
const BRANCHES_ARGS = ["api", "repos/{owner}/{repo}/branches", "--paginate", "--jq", "[.[] | {name}]"];

// Records the exact argv of every call, and only replies when the args match exactly —
// a substring/`includes` match would let a call carrying extra or wrong arguments (e.g. a
// caller-controlled value smuggled onto the argv) pass silently, which is exactly the kind
// of gap that let the git `--base` injection Critical through review.
function fakeRunner(replies: Map<string, string>) {
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    const reply = replies.get(JSON.stringify(args));
    if (reply === undefined) throw new Error(`unexpected gh call: ${args.join(" ")}`);
    return reply;
  };
  return { run, calls };
}

describe("defaultBranch", () => {
  it("sends exactly the expected argv and reads the repository default", () => {
    const { run, calls } = fakeRunner(
      new Map([[JSON.stringify(DEFAULT_BRANCH_ARGS), JSON.stringify({ defaultBranchRef: { name: "develop" } })]]),
    );
    expect(defaultBranch("/repo", run)).toBe("develop");
    expect(calls).toEqual([DEFAULT_BRANCH_ARGS]);
  });

  it("wraps a plain Error from an injected runner as VcsError", () => {
    const run = () => {
      throw new Error("gh: command not found");
    };
    expect(() => defaultBranch("/repo", run)).toThrow(VcsError);
  });

  it("throws VcsError when JSON shape is wrong", () => {
    const { run } = fakeRunner(new Map([[JSON.stringify(DEFAULT_BRANCH_ARGS), JSON.stringify({})]]));
    expect(() => defaultBranch("/repo", run)).toThrow(VcsError);
  });
});

describe("baseCandidates", () => {
  it("sends exactly the expected argv for both calls, in order", () => {
    const { run, calls } = fakeRunner(
      new Map([
        [JSON.stringify(DEFAULT_BRANCH_ARGS), JSON.stringify({ defaultBranchRef: { name: "develop" } })],
        [JSON.stringify(BRANCHES_ARGS), JSON.stringify([{ name: "develop" }])],
      ]),
    );
    baseCandidates("/repo", run);
    expect(calls).toEqual([DEFAULT_BRANCH_ARGS, BRANCHES_ARGS]);
  });

  it("puts the default branch first and adds release branches, ordered numerically", () => {
    // Was release/3.75.0 and release/3.76.0: those sort identically whether the comparator
    // is lexicographic or numeric, so that fixture could not have caught the wrong-base bug
    // where "release/3.10.0" sorted before "release/3.9.0". 3.9/3.10 can and does.
    const { run } = fakeRunner(
      new Map([
        [JSON.stringify(DEFAULT_BRANCH_ARGS), JSON.stringify({ defaultBranchRef: { name: "develop" } })],
        [
          JSON.stringify(BRANCHES_ARGS),
          JSON.stringify([{ name: "release/3.9.0" }, { name: "release/3.10.0" }, { name: "develop" }]),
        ],
      ]),
    );
    expect(baseCandidates("/repo", run)).toEqual(["develop", "release/3.9.0", "release/3.10.0"]);
  });

  it("orders release branches numerically regardless of gh's own listing order", () => {
    const { run } = fakeRunner(
      new Map([
        [JSON.stringify(DEFAULT_BRANCH_ARGS), JSON.stringify({ defaultBranchRef: { name: "develop" } })],
        [
          JSON.stringify(BRANCHES_ARGS),
          JSON.stringify([{ name: "release/3.10.0" }, { name: "release/3.9.0" }, { name: "develop" }]),
        ],
      ]),
    );
    expect(baseCandidates("/repo", run)).toEqual(["develop", "release/3.9.0", "release/3.10.0"]);
  });

  it("throws VcsError when branches call returns non-array JSON", () => {
    const { run } = fakeRunner(
      new Map([
        [JSON.stringify(DEFAULT_BRANCH_ARGS), JSON.stringify({ defaultBranchRef: { name: "develop" } })],
        [JSON.stringify(BRANCHES_ARGS), JSON.stringify({ message: "API rate limit exceeded" })],
      ]),
    );
    expect(() => baseCandidates("/repo", run)).toThrow(VcsError);
  });
});

describe("findPullRequest", () => {
  it("returns null when the branch has no open pull request", () => {
    const { run } = fakeRunner(
      new Map([
        [
          JSON.stringify(["pr", "list", "--head", "feature/x", "--state", "open", "--json", "number,url,baseRefName"]),
          JSON.stringify([]),
        ],
      ]),
    );
    expect(findPullRequest("feature/x", "/repo", run)).toBeNull();
  });

  it("reports number, base, labels and approving logins", () => {
    const { run } = fakeRunner(
      new Map([
        [
          JSON.stringify(["pr", "list", "--head", "feature/x", "--state", "open", "--json", "number,url,baseRefName"]),
          JSON.stringify([{ number: 881, url: "https://github.com/x/y/pull/881", baseRefName: "release/3.76.0" }]),
        ],
        [
          JSON.stringify(["pr", "view", "881", "--json", "labels,latestReviews"]),
          JSON.stringify({
            labels: [{ name: "in test" }],
            latestReviews: [
              { author: { login: "alice" }, state: "APPROVED" },
              { author: { login: "bob" }, state: "CHANGES_REQUESTED" },
            ],
          }),
        ],
      ]),
    );
    expect(findPullRequest("feature/x", "/repo", run)).toEqual({
      number: 881,
      url: "https://github.com/x/y/pull/881",
      baseRefName: "release/3.76.0",
      labels: ["in test"],
      approvals: ["alice"],
    });
  });

  it("throws VcsError when the pull request entry is missing a url", () => {
    const { run } = fakeRunner(
      new Map([
        [
          JSON.stringify(["pr", "list", "--head", "feature/x", "--state", "open", "--json", "number,url,baseRefName"]),
          JSON.stringify([{ number: 7, baseRefName: "develop" }]),
        ],
      ]),
    );
    expect(() => findPullRequest("feature/x", "/repo", run)).toThrow(VcsError);
  });

  it("sends the exact arguments for both calls", () => {
    const { run } = fakeRunner(
      new Map([
        [
          JSON.stringify(["pr", "list", "--head", "feature/x", "--state", "open", "--json", "number,url,baseRefName"]),
          JSON.stringify([{ number: 7, url: "https://github.com/x/y/pull/7", baseRefName: "develop" }]),
        ],
        [
          JSON.stringify(["pr", "view", "7", "--json", "labels,latestReviews"]),
          JSON.stringify({ labels: [], latestReviews: [] }),
        ],
      ]),
    );
    const calls: string[][] = [];
    const wrappedRun = (args: string[]): string => {
      calls.push(args);
      return run(args);
    };
    findPullRequest("feature/x", "/repo", wrappedRun);
    expect(calls).toEqual([
      ["pr", "list", "--head", "feature/x", "--state", "open", "--json", "number,url,baseRefName"],
      ["pr", "view", "7", "--json", "labels,latestReviews"],
    ]);
  });

  it("throws VcsError when the list payload is not an array", () => {
    const { run } = fakeRunner(
      new Map([
        [
          JSON.stringify(["pr", "list", "--head", "feature/x", "--state", "open", "--json", "number,url,baseRefName"]),
          JSON.stringify({ message: "rate limited" }),
        ],
      ]),
    );
    expect(() => findPullRequest("feature/x", "/repo", run)).toThrow(VcsError);
  });

  it("throws VcsError when gh pr list returns an array with a null entry", () => {
    const { run } = fakeRunner(
      new Map([
        [
          JSON.stringify(["pr", "list", "--head", "feature/x", "--state", "open", "--json", "number,url,baseRefName"]),
          JSON.stringify([null]),
        ],
      ]),
    );
    expect(() => findPullRequest("feature/x", "/repo", run)).toThrow(VcsError);
  });

  it("throws VcsError when labels contains a null entry", () => {
    const { run } = fakeRunner(
      new Map([
        [
          JSON.stringify(["pr", "list", "--head", "feature/x", "--state", "open", "--json", "number,url,baseRefName"]),
          JSON.stringify([{ number: 7, url: "https://github.com/x/y/pull/7", baseRefName: "develop" }]),
        ],
        [
          JSON.stringify(["pr", "view", "7", "--json", "labels,latestReviews"]),
          JSON.stringify({ labels: [null], latestReviews: [] }),
        ],
      ]),
    );
    expect(() => findPullRequest("feature/x", "/repo", run)).toThrow(VcsError);
  });

  it("throws VcsError when latestReviews contains a null entry", () => {
    const { run } = fakeRunner(
      new Map([
        [
          JSON.stringify(["pr", "list", "--head", "feature/x", "--state", "open", "--json", "number,url,baseRefName"]),
          JSON.stringify([{ number: 7, url: "https://github.com/x/y/pull/7", baseRefName: "develop" }]),
        ],
        [
          JSON.stringify(["pr", "view", "7", "--json", "labels,latestReviews"]),
          JSON.stringify({ labels: [], latestReviews: [null] }),
        ],
      ]),
    );
    expect(() => findPullRequest("feature/x", "/repo", run)).toThrow(VcsError);
  });
});
