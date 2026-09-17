import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readPushDiff } from "../../src/vcs/git.js";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

/**
 * A repository with one commit on `develop` and a feature branch cut from it. No remote.
 *
 * `baseline` lands in that first commit, which matters more than it looks: everything the
 * branch adds afterwards is measured against the merge base, so a file written only on the
 * branch reads as an addition no matter how it got there.
 */
function scratch(baseline: Record<string, string> = {}): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "shipkit-diff-")));
  tempDirs.push(repo);
  git(["init", "-b", "develop", "."], repo);
  git(["config", "user.email", "t@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  writeFileSync(join(repo, "app.ts"), "one\ntwo\nthree\nfour\n", "utf8");
  for (const [path, text] of Object.entries(baseline)) {
    writeFileSync(join(repo, path), text, "utf8");
  }
  git(["add", "--all"], repo);
  git(["commit", "-m", "init"], repo);
  git(["checkout", "-b", "work"], repo);
  return repo;
}

function byPath(repo: string, exclude: string[] = []): Map<string, ReturnType<typeof readPushDiff>[number]> {
  return new Map(readPushDiff("develop", exclude, repo).map((file) => [file.path, file]));
}

describe("readPushDiff", () => {
  // The bug this feature could most easily repeat: `commitAll` stages after the gate, so a
  // review of `base...HEAD` would show a person an empty page while the whole change waits
  // in the working tree.
  it("shows work that is entirely uncommitted, which base...HEAD cannot", () => {
    const repo = scratch();
    writeFileSync(join(repo, "app.ts"), "one\nTWO\nthree\nfour\n", "utf8");

    const files = byPath(repo);

    expect([...files.keys()]).toEqual(["app.ts"]);
    expect(files.get("app.ts")?.patch).toContain("-two");
    expect(files.get("app.ts")?.patch).toContain("+TWO");
  });

  it("shows untracked work, which git diff cannot see at all", () => {
    const repo = scratch();
    writeFileSync(join(repo, "new.ts"), "brand new\n", "utf8");

    const files = byPath(repo);

    expect(files.get("new.ts")?.status).toBe("added");
    expect(files.get("new.ts")?.patch).toContain("+brand new");
  });

  it("shows a deletion the push will carry", () => {
    const repo = scratch();
    rmSync(join(repo, "app.ts"));

    const files = byPath(repo);

    expect(files.get("app.ts")?.status).toBe("deleted");
    expect(files.get("app.ts")?.patch).toContain("-one");
  });

  it("shows committed and working-tree work together", () => {
    const repo = scratch();
    writeFileSync(join(repo, "committed.ts"), "a\n", "utf8");
    git(["add", "--all"], repo);
    git(["commit", "-m", "one"], repo);
    writeFileSync(join(repo, "pending.ts"), "b\n", "utf8");

    expect([...byPath(repo).keys()].sort()).toEqual(["committed.ts", "pending.ts"]);
  });

  it("leaves out a path the commit is told to exclude", () => {
    const repo = scratch();
    mkdirSync(join(repo, ".shipkit"), { recursive: true });
    writeFileSync(join(repo, ".shipkit/fix-request.json"), "{}\n", "utf8");
    writeFileSync(join(repo, "kept.ts"), "k\n", "utf8");

    const files = byPath(repo, [".shipkit/fix-request.json"]);

    expect(files.has("kept.ts")).toBe(true);
    expect(files.has(".shipkit/fix-request.json")).toBe(false);
  });

  // The one line number in the whole feature that is derived rather than invented.
  it("reports the first line the change touches on the new side", () => {
    const repo = scratch();
    writeFileSync(join(repo, "app.ts"), "one\ntwo\nthree\nFOUR\n", "utf8");

    expect(byPath(repo).get("app.ts")?.line).toBe(4);
  });

  // The hunk header is not the answer: with three lines of context this change sits under
  // `@@ -7,7 +7,7 @@`, and the header alone would send the editor three lines early.
  it("counts past the context lines the hunk header covers", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const repo = scratch({ "long.ts": `${lines.join("\n")}\n` });
    lines[9] = "CHANGED";
    writeFileSync(join(repo, "long.ts"), `${lines.join("\n")}\n`, "utf8");

    const file = byPath(repo).get("long.ts");

    expect(file?.patch).toContain("@@ -7,7 +7,7 @@");
    expect(file?.line).toBe(10);
  });

  it("falls back to line 1 for a file with no hunk to read a line from", () => {
    const repo = scratch();
    // A PNG header: git calls this binary and prints no hunks for it at all.
    writeFileSync(join(repo, "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]));

    const file = byPath(repo).get("icon.png");

    expect(file?.status).toBe("added");
    expect(file?.line).toBe(1);
  });

  // Deriving the path list from the patch alone would lose this file entirely: git prints
  // no `+++` line for a binary one, only "Binary files ... differ".
  it("still names a binary file, which has no +++ header to be found by", () => {
    const repo = scratch();
    writeFileSync(join(repo, "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
    writeFileSync(join(repo, "app.ts"), "one\nTWO\nthree\nfour\n", "utf8");

    expect([...byPath(repo).keys()].sort()).toEqual(["app.ts", "icon.png"]);
  });

  it("reports a moved file as a deletion and an addition, never a three-field rename", () => {
    const repo = scratch();
    execFileSync("git", ["mv", "app.ts", "moved.ts"], { cwd: repo, stdio: "pipe" });

    const files = byPath(repo);

    expect(files.get("app.ts")?.status).toBe("deleted");
    expect(files.get("moved.ts")?.status).toBe("added");
  });

  // `core.quotePath` mangles a non-ASCII path into a C-quoted string, and a mangled path
  // matches nothing in the `--name-status` list — the file would be listed with an empty
  // patch. This repository's own Jira speaks Turkish.
  it("keeps a non-ASCII path in step between its two reads", () => {
    const repo = scratch();
    writeFileSync(join(repo, "ödeme.ts"), "para\n", "utf8");

    const file = byPath(repo).get("ödeme.ts");

    expect(file).toBeDefined();
    expect(file?.patch).toContain("+para");
  });

  it("keeps a path with a space in step too, which the diff --git header cannot disambiguate", () => {
    const repo = scratch();
    writeFileSync(join(repo, "two words.ts"), "spaced\n", "utf8");

    expect(byPath(repo).get("two words.ts")?.patch).toContain("+spaced");
  });

  // A line of file content that begins `+++ ` arrives in the patch as `++++ `, because the
  // hunk body always adds its own marker. If it did not, it would be read as a header and
  // the rest of the file's patch would be filed under whatever it named.
  it("is not confused by a file whose own content looks like a diff header", () => {
    const repo = scratch();
    writeFileSync(join(repo, "tricky.md"), "+++ b/not-a-file\ndiff --git a/x b/x\n", "utf8");

    const files = byPath(repo);

    expect([...files.keys()]).toEqual(["tricky.md"]);
    expect(files.get("tricky.md")?.patch).toContain("++++ b/not-a-file");
  });

  it("leaves the real index and working tree exactly as it found them", () => {
    const repo = scratch();
    writeFileSync(join(repo, "app.ts"), "one\nTWO\nthree\nfour\n", "utf8");
    writeFileSync(join(repo, "untracked.ts"), "u\n", "utf8");
    const before = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });

    readPushDiff("develop", [], repo);

    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" })).toBe(before);
  });
});
