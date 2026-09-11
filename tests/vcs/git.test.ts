import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readPushDiffstat, readRepoState, VcsError } from "../../src/vcs/git.js";

let repo: string;

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "shipkit-git-"));
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "base"], repo);
  git(["checkout", "-q", "-b", "feature/x"], repo);
  writeFileSync(join(repo, "a.txt"), "two\n");
  writeFileSync(join(repo, "b.txt"), "new\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "feat: add b and change a"], repo);
});

describe("readRepoState", () => {
  it("reports the current branch", () => {
    expect(readRepoState("main", repo).branch).toBe("feature/x");
  });

  it("lists files changed against the base", () => {
    expect(readRepoState("main", repo).changedFiles.sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("returns a diffstat mentioning both files", () => {
    const stat = readRepoState("main", repo).diffstat;
    expect(stat).toContain("a.txt");
    expect(stat).toContain("b.txt");
  });

  it("lists commit subjects not on the base", () => {
    expect(readRepoState("main", repo).commits).toEqual(["feat: add b and change a"]);
  });

  it("throws VcsError for an unknown base", () => {
    expect(() => readRepoState("no-such-branch", repo)).toThrow(VcsError);
  });

  it("excludes commits added to base after feature branch diverged", () => {
    // Simulate advancing the base branch after feature branch creation
    git(["checkout", "-q", "main"], repo);
    writeFileSync(join(repo, "c.txt"), "base-only\n");
    git(["add", "."], repo);
    git(["commit", "-q", "-m", "fix: base branch update"], repo);
    git(["checkout", "-q", "feature/x"], repo);

    // The commits should only include the feature branch commit, not the base's
    expect(readRepoState("main", repo).commits).toEqual(["feat: add b and change a"]);
  });

  it("treats a --base that looks like a git option as an invalid ref, and creates no file", () => {
    // Without `--end-of-options`, git parses this as `git diff --output=<path>`, writing the
    // diff to <path> instead of stdout, and exits 0 — a read-only command mutating the disk.
    const marker = `shipkit-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const maliciousBase = `--output=${join(tmpdir(), marker)}`;

    expect(() => readRepoState(maliciousBase, repo)).toThrow(VcsError);

    const created = readdirSync(tmpdir()).filter((name) => name.startsWith(marker));
    expect(created).toEqual([]);
  });
});

// The failure this exists for, built as a repository rather than described: an agent
// makes its whole change without committing, on a branch freshly cut from the base.
// `git diff --stat base...HEAD` — the three-dot range `readRepoState` uses — sees only
// committed work, so it returns the empty string, the approval panel renders a blank
// line where the size of the change belongs, and `commitAll`'s `git add --all` sweeps
// every one of those files into the push a moment later.
describe("readPushDiffstat", () => {
  let scratch: string;

  const RESPONSE = "shipkit-response.json";

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "shipkit-push-"));
    git(["init", "-q", "-b", "develop"], scratch);
    git(["config", "user.email", "t@example.com"], scratch);
    git(["config", "user.name", "Test"], scratch);
    writeFileSync(join(scratch, "tracked.txt"), "one\n");
    writeFileSync(join(scratch, "doomed.txt"), "keep\n");
    git(["add", "."], scratch);
    git(["commit", "-q", "-m", "base"], scratch);
    git(["checkout", "-q", "-b", "feature/x"], scratch);
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  /** The scenario in full: nothing committed on the branch, everything in the tree. */
  function uncommittedWork(): void {
    writeFileSync(join(scratch, "tracked.txt"), "one\ntwo\n");
    writeFileSync(join(scratch, "untracked.txt"), "new\n");
    mkdirSync(join(scratch, "sub"), { recursive: true });
    writeFileSync(join(scratch, "sub", "deep.txt"), "deep\n");
    writeFileSync(join(scratch, RESPONSE), '{"title":"x"}\n');
  }

  it("names the uncommitted and untracked work that the push will carry", () => {
    uncommittedWork();

    // The bug, stated as an assertion so it cannot quietly stop being true.
    expect(readRepoState("develop", scratch).diffstat).toBe("");

    const stat = readPushDiffstat("develop", [], scratch);
    expect(stat).toContain("tracked.txt");
    expect(stat).toContain("untracked.txt");
    expect(stat).toContain("sub/deep.txt");
    expect(stat).toContain("4 files changed");
  });

  it("leaves out the response file the commit is told to exclude", () => {
    uncommittedWork();

    const stat = readPushDiffstat("develop", [RESPONSE], scratch);
    expect(stat).not.toContain(RESPONSE);
    expect(stat).toContain("untracked.txt");
    expect(stat).toContain("3 files changed");
  });

  // Committed work has to stay in it: this replaces `readRepoState`'s diffstat on the
  // approval path, and a branch that has committed some of its change and left the rest
  // in the tree is the ordinary case, not an edge one.
  it("counts committed work and working-tree work together", () => {
    writeFileSync(join(scratch, "tracked.txt"), "one\ntwo\n");
    git(["add", "."], scratch);
    git(["commit", "-q", "-m", "feat: half of it"], scratch);
    writeFileSync(join(scratch, "tracked.txt"), "one\ntwo\nthree\n");
    writeFileSync(join(scratch, "untracked.txt"), "new\n");

    const stat = readPushDiffstat("develop", [], scratch);
    expect(stat).toContain("2 files changed");
    expect(stat).toContain("3 insertions(+)");
  });

  // `git add --all --intent-to-add` was the first attempt and drops the index entry for a
  // file deleted in the working tree, so the deletion disappears from the stat — an
  // under-report of what is being approved, which is the direction that matters.
  it("reports a deletion the commit will carry", () => {
    rmSync(join(scratch, "doomed.txt"));

    const stat = readPushDiffstat("develop", [], scratch);
    expect(stat).toContain("doomed.txt");
    expect(stat).toContain("1 deletion(-)");
  });

  // Same staging rules as `commitAll`, because it is the same pathspec and the same
  // `git add --all` — not a second implementation of "what would be committed".
  it("ignores what .gitignore ignores, exactly as staging would", () => {
    writeFileSync(join(scratch, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(scratch, "ignored.txt"), "noise\n");

    const stat = readPushDiffstat("develop", [], scratch);
    expect(stat).toContain(".gitignore");
    expect(stat).not.toContain("ignored.txt\n");
  });

  // The scratch index is written outside the repository. Beside `.git` it is itself an
  // untracked file, and `git add --all` sweeps it into the stat it is being used to
  // compute — measured, not imagined.
  it("does not name its own scratch index", () => {
    uncommittedWork();

    expect(readPushDiffstat("develop", [], scratch)).not.toContain("index");
  });

  // It runs before a person has said yes, and may run again after they say no. Reading
  // must not stage anything: a `git add` against the real index would leave the tree
  // staged for whatever the author does next.
  it("leaves the real index and working tree exactly as it found them", () => {
    uncommittedWork();
    const before = execFileSync("git", ["status", "--porcelain"], { cwd: scratch, encoding: "utf8" });

    readPushDiffstat("develop", [RESPONSE], scratch);

    const after = execFileSync("git", ["status", "--porcelain"], { cwd: scratch, encoding: "utf8" });
    expect(after).toBe(before);
    expect(after).toContain("?? untracked.txt");
  });

  // Measured against the merge base, like the range it replaces: work that landed on the
  // base after this branch was cut is the base's, not this push's.
  it("excludes work added to the base after the branch was cut", () => {
    writeFileSync(join(scratch, "tracked.txt"), "one\ntwo\n");
    git(["checkout", "-q", "develop"], scratch);
    writeFileSync(join(scratch, "base-only.txt"), "theirs\n");
    git(["add", "base-only.txt"], scratch);
    git(["commit", "-q", "-m", "fix: base moved on"], scratch);
    git(["checkout", "-q", "feature/x"], scratch);

    const stat = readPushDiffstat("develop", [], scratch);
    expect(stat).toContain("tracked.txt");
    expect(stat).not.toContain("base-only.txt");
  });

  it("throws VcsError for an unknown base", () => {
    expect(() => readPushDiffstat("no-such-branch", [], scratch)).toThrow(VcsError);
  });

  // `base` is the one caller-controlled value here, and without `--end-of-options` a
  // `--output=` spelling of it turns a read into a write.
  it("treats a --base that looks like a git option as an invalid ref, and creates no file", () => {
    const marker = `shipkit-push-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    expect(() => readPushDiffstat(`--output=${join(tmpdir(), marker)}`, [], scratch)).toThrow(
      VcsError,
    );

    expect(readdirSync(tmpdir()).filter((name) => name.startsWith(marker))).toEqual([]);
  });

  // Measured against real git: `diff.relative` makes git print paths, and count "N files
  // changed", relative to `cwd` — and it does this even with an explicit `:/` pathspec, so
  // the defense `readUntrackedFiles` uses above does not carry over here for free. A repo
  // with the config set, a new file below `cwd` and a new file outside it, run from that
  // subdirectory: without `--no-relative` this reports "1 file changed" and silently drops
  // the file outside `sub/` from the stat a person approves.
  it("counts a file outside cwd even when diff.relative is set, run from a subdirectory", () => {
    git(["config", "diff.relative", "true"], scratch);
    mkdirSync(join(scratch, "sub"), { recursive: true });
    writeFileSync(join(scratch, "sub", "a.txt"), "new\n");
    writeFileSync(join(scratch, "top.txt"), "new\n");

    const stat = readPushDiffstat("develop", [], join(scratch, "sub"));
    expect(stat).toContain("sub/a.txt");
    expect(stat).toContain("top.txt");
    expect(stat).toContain("2 files changed");
  });
});
