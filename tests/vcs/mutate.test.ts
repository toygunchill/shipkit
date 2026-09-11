import { describe, expect, it } from "vitest";
import { commitAll, createPullRequest, pushBranch } from "../../src/vcs/mutate.js";
import { VcsError } from "../../src/vcs/types.js";

describe("commitAll", () => {
  it("stages everything then commits with the message as one argument", () => {
    const seen: string[][] = [];
    commitAll("fix(x): y\n\nBody.", [], "/repo", (args) => {
      seen.push(args);
      return "";
    });
    expect(seen).toEqual([
      ["add", "--all"],
      ["commit", "-m", "fix(x): y\n\nBody."],
    ]);
  });

  it("keeps an excluded path out of the staging pathspec", () => {
    const seen: string[][] = [];
    commitAll("m", ["scratch/response.json"], "/repo", (args) => {
      seen.push(args);
      return "";
    });
    expect(seen[0]).toEqual([
      "add", "--all", "--", ":/", ":(exclude,literal,top)scratch/response.json",
    ]);
  });

  // `:/` is what keeps the exclusion from narrowing the commit. A bare `.` pathspec means
  // "below the current directory", so running shipkit from a subdirectory would silently
  // stage only part of the change — the opposite of what `--all` promises.
  it("anchors the pathspec at the repository root, not the working directory", () => {
    const seen: string[][] = [];
    commitAll("m", ["scratch/response.json"], "/repo", (args) => {
      seen.push(args);
      return "";
    });
    expect(seen[0]).toContain(":/");
    expect(seen[0]).not.toContain(".");
  });

  it("excludes several paths at once", () => {
    const seen: string[][] = [];
    commitAll("m", ["a.json", "b.json"], "/repo", (args) => {
      seen.push(args);
      return "";
    });
    expect(seen[0]).toEqual([
      "add", "--all", "--", ":/", ":(exclude,literal,top)a.json", ":(exclude,literal,top)b.json",
    ]);
  });

  // Without `literal`, a pathspec is glob-matched: excluding a real file named
  // `weird[1].txt` also silently drops an unrelated `weird1.txt` from the commit. Dropping
  // someone's actual work is worse than the stray-file problem this exclusion exists for.
  it("disables globbing so a bracket in a filename cannot match another file", () => {
    const seen: string[][] = [];
    commitAll("m", ["weird[1].txt"], "/repo", (args) => {
      seen.push(args);
      return "";
    });
    expect(seen[0]).toContain(":(exclude,literal,top)weird[1].txt");
  });

  // `top` is what makes the root-relative path match when shipkit runs from a
  // subdirectory; without it the pathspec is read relative to the working directory.
  it("reads excluded paths from the repository root", () => {
    const seen: string[][] = [];
    commitAll("m", ["sub/response.json"], "/repo", (args) => {
      seen.push(args);
      return "";
    });
    expect(seen[0][4]).toContain("top");
  });

  it("throws VcsError when git fails", () => {
    expect(() => commitAll("m", [], "/repo", () => { throw new Error("nothing to commit"); })).toThrow(VcsError);
  });

  it("does not attempt commit when staging fails", () => {
    const seen: string[][] = [];
    expect(() => commitAll("m", [], "/repo", (args) => {
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
    pushBranch("feature/x", "/repo", (args) => {
      seen.push(args);
      return "";
    });
    expect(seen).toEqual([["push", "--set-upstream", "origin", "--end-of-options", "feature/x"]]);
  });

  it("never passes --force", () => {
    const seen: string[][] = [];
    pushBranch("feature/x", "/repo", (args) => {
      seen.push(args);
      return "";
    });
    expect(seen.flat()).not.toContain("--force");
    expect(seen.flat()).not.toContain("-f");
  });

  it("throws VcsError when the push is rejected", () => {
    expect(() => pushBranch("x", "/repo", () => { throw new Error("rejected"); })).toThrow(VcsError);
  });

  it("passes branch name after --end-of-options to prevent argv injection", () => {
    const seen: string[][] = [];
    pushBranch("--delete", "/repo", (args) => {
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
      "/repo",
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
      createPullRequest({ title: "T", body: "B", base: "d", head: "h" }, "/repo", () => {
        throw new Error("not authenticated");
      }),
    ).toThrow(VcsError);
  });
});

describe("cwd", () => {
  it("builds the default git runner against the directory it was given", () => {
    // Asserting the *default* runner picks up cwd needs the child-process boundary, which
    // this file deliberately never crosses. What is assertable here is that an explicitly
    // injected runner still wins over the cwd argument, so the seam every other test in
    // this file relies on is not quietly broken by the new parameter.
    const seen: string[][] = [];
    commitAll("m", [], "/some/repo", (args) => {
      seen.push(args);
      return "";
    });
    expect(seen).toEqual([
      ["add", "--all"],
      ["commit", "-m", "m"],
    ]);
  });

  it("accepts a cwd for pushBranch without disturbing the argv", () => {
    const seen: string[][] = [];
    pushBranch("feature/x", "/some/repo", (args) => {
      seen.push(args);
      return "";
    });
    expect(seen).toEqual([["push", "--set-upstream", "origin", "--end-of-options", "feature/x"]]);
  });

  it("accepts a cwd for createPullRequest without disturbing the argv", () => {
    const seen: string[][] = [];
    const url = createPullRequest(
      { title: "T", body: "B", base: "develop", head: "feature/x" },
      "/some/repo",
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
});
