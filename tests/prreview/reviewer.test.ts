import { describe, expect, it } from "vitest";
import { askForReviewer, reviewerInTree, reviewersAt } from "../../src/prreview/reviewer.js";

const SUBAGENT = "---\nname: widget-reviewer\n---\n\nYou review changes.\n";

function git(files: Record<string, string>, ref = "origin/develop") {
  return (args: string[]): string | undefined => {
    if (args[0] === "ls-tree") {
      return Object.keys(files)
        .filter((key) => key.startsWith(`${ref}:`))
        .map((key) => key.slice(ref.length + 1))
        .join("\n");
    }
    if (args[0] === "show") return files[args[1] as string];
    return undefined;
  };
}

function tree(files: Record<string, string>) {
  return {
    read: (path: string) => files[path],
    list: (directory: string) =>
      Object.keys(files)
        .filter((path) => path.startsWith(`${directory}/`))
        .map((path) => path.slice(directory.length + 1)),
  };
}

describe("finding the reviewer a repository defines at a ref", () => {
  it("finds a Claude Code subagent", () => {
    const found = reviewersAt("origin/develop", git({ "origin/develop:.claude/agents/app-reviewer.md": SUBAGENT }));

    expect(found[0]).toMatchObject({ path: ".claude/agents/app-reviewer.md", flavour: "Claude Code subagent" });
    expect(found[0]?.instructions).toContain("You review changes");
  });

  // A subagent is what a tool dispatches as a separate reviewer; a command is a person's
  // entry point to roughly the same text. Both are returned, the subagent first.
  it("prefers the subagent when a repository has both", () => {
    const found = reviewersAt(
      "origin/develop",
      git({
        "origin/develop:.claude/commands/review.md": SUBAGENT,
        "origin/develop:.claude/agents/app-reviewer.md": SUBAGENT,
      }),
    );

    expect(found.map((f) => f.flavour)).toEqual(["Claude Code subagent", "Claude Code command"]);
  });

  it("reads a Copilot prompt and a Codex prompt too", () => {
    expect(
      reviewersAt("origin/develop", git({ "origin/develop:.github/prompts/review.prompt.md": SUBAGENT }))[0]?.flavour,
    ).toBe("Copilot prompt");
    expect(
      reviewersAt("origin/develop", git({ "origin/develop:.codex/prompts/review.md": SUBAGENT }))[0]?.flavour,
    ).toBe("Codex prompt");
  });

  // Telling the agent to follow instructions nobody could produce is worse than telling it
  // there are none.
  it("ignores a file that is listed but empty", () => {
    expect(reviewersAt("origin/develop", git({ "origin/develop:.claude/agents/app-reviewer.md": "   \n" }))).toEqual([]);
  });

  it("does not mistake another agent file for a reviewer", () => {
    expect(
      reviewersAt("origin/develop", git({ "origin/develop:.claude/agents/release-notes.md": SUBAGENT })),
    ).toEqual([]);
  });

  it("finds nothing in a repository that defines none", () => {
    expect(reviewersAt("origin/develop", git({ "origin/develop:README.md": "hi" }))).toEqual([]);
  });
});

describe("finding it in a working tree", () => {
  // Tried before the ref, because a branch that is *changing* how reviews work here must be
  // judged by its own version.
  it("reads the checkout the person is standing in", () => {
    const { read, list } = tree({ ".claude/agents/app-reviewer.md": SUBAGENT });

    expect(reviewerInTree(read, list)?.path).toBe(".claude/agents/app-reviewer.md");
  });

  it("answers nothing for a checkout that has none, rather than throwing", () => {
    const { read, list } = tree({ "README.md": "hi" });

    expect(reviewerInTree(read, list)).toBeUndefined();
  });

  it("asks the same question of a tree as of a ref", () => {
    const files = { ".codex/prompts/review.md": SUBAGENT };
    const { read, list } = tree(files);

    expect(reviewerInTree(read, list)?.flavour).toBe("Codex prompt");
  });
});

describe("asking a repository to define one", () => {
  // It asks and offers, because the remedy is mechanical: the rules a reviewer would
  // enforce are already in the repository.
  it("names where to put it and offers to write it", () => {
    const message = askForReviewer("acme/widget");

    expect(message).toContain(".claude/agents/");
    expect(message).toContain("shipkit reviewer --write");
    expect(message).toContain("Nothing is written without that flag");
  });
});
