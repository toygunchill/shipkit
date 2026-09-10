import { describe, expect, it } from "vitest";
import { commitAll, createPullRequest, pushBranch } from "../../src/vcs/mutate.js";
import { VcsError } from "../../src/vcs/types.js";

describe("commitAll", () => {
  it("stages everything then commits with the message as one argument", () => {
    const seen: string[][] = [];
    commitAll("fix(x): y\n\nBody.", (args) => {
      seen.push(args);
      return "";
    });
    expect(seen).toEqual([
      ["add", "--all"],
      ["commit", "-m", "fix(x): y\n\nBody."],
    ]);
  });

  it("throws VcsError when git fails", () => {
    expect(() => commitAll("m", () => { throw new Error("nothing to commit"); })).toThrow(VcsError);
  });

  it("does not attempt commit when staging fails", () => {
    const seen: string[][] = [];
    expect(() => commitAll("m", (args) => {
      seen.push(args);
      if (args[0] === "add") {
        throw new Error("no files to add");
      }
      return "";
    })).toThrow(VcsError);
    expect(seen).toEqual([["add", "--all"]]);
    expect(seen.flat()).not.toContain("commit");
  });
});

describe("pushBranch", () => {
  it("pushes the named branch to origin and sets upstream", () => {
    const seen: string[][] = [];
    pushBranch("feature/x", (args) => {
      seen.push(args);
      return "";
    });
    expect(seen).toEqual([["push", "--set-upstream", "origin", "--end-of-options", "feature/x"]]);
  });

  it("never passes --force", () => {
    const seen: string[][] = [];
    pushBranch("feature/x", (args) => {
      seen.push(args);
      return "";
    });
    expect(seen.flat()).not.toContain("--force");
    expect(seen.flat()).not.toContain("-f");
  });

  it("throws VcsError when the push is rejected", () => {
    expect(() => pushBranch("x", () => { throw new Error("rejected"); })).toThrow(VcsError);
  });

  it("passes branch name after --end-of-options to prevent argv injection", () => {
    const seen: string[][] = [];
    pushBranch("--delete", (args) => {
      seen.push(args);
      return "";
    });
    const args = seen[0];
    const endOfOptionsIndex = args.indexOf("--end-of-options");
    const branchIndex = args.indexOf("--delete");
    expect(endOfOptionsIndex).toBeGreaterThanOrEqual(0);
    expect(branchIndex).toBeGreaterThan(endOfOptionsIndex);
  });
});

describe("createPullRequest", () => {
  it("sends title, body, base and head, and returns the URL", () => {
    const seen: string[][] = [];
    const url = createPullRequest(
      { title: "T", body: "B", base: "develop", head: "feature/x" },
      (args) => {
        seen.push(args);
        return "https://example.com/pr/1\n";
      },
    );
    expect(seen).toEqual([
      ["pr", "create", "--title", "T", "--body", "B", "--base", "develop", "--head", "feature/x"],
    ]);
    expect(url).toBe("https://example.com/pr/1");
  });

  it("throws VcsError when gh fails", () => {
    expect(() =>
      createPullRequest({ title: "T", body: "B", base: "d", head: "h" }, () => {
        throw new Error("not authenticated");
      }),
    ).toThrow(VcsError);
  });
});
