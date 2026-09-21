import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPushChangedPaths, VcsError } from "../../src/vcs/git.js";

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

// The failure this read exists to avoid, built as a repository rather than described: an
// agent writes its whole change and commits none of it, because `commitAll` stages after
// the gate. A reader asking `base...HEAD` sees an empty change, every `appliesTo` rule
// falls away, and the readiness checklist excuses itself on exactly the run it was for.
describe("readPushChangedPaths", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "shipkit-paths-"));
    git(["init", "-q", "-b", "develop"], scratch);
    git(["config", "user.email", "t@example.com"], scratch);
    git(["config", "user.name", "Test"], scratch);
    writeFileSync(join(scratch, "README.md"), "base\n");
    git(["add", "."], scratch);
    git(["commit", "-q", "-m", "base"], scratch);
    git(["checkout", "-q", "-b", "feature/x"], scratch);
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("sees a matching file that is entirely uncommitted and untracked", () => {
    mkdirSync(join(scratch, "Sources", "Scenes"), { recursive: true });
    writeFileSync(join(scratch, "Sources", "Scenes", "View.swift"), "import SwiftUI\n");

    expect(readPushChangedPaths("develop", [], scratch)).toEqual([
      "Sources/Scenes/View.swift",
    ]);
  });

  it("names every file type, not only the ones conversion detection cares about", () => {
    // `readPushChangedFiles` is restricted to .swift/.xib/.storyboard and reads both blobs
    // of each. A readiness rule can be about an asset catalogue or a plist, and neither
    // would ever appear through that reader.
    mkdirSync(join(scratch, "Art", "Assets.xcassets", "Logo.imageset"), { recursive: true });
    writeFileSync(join(scratch, "Art", "Assets.xcassets", "Logo.imageset", "Contents.json"), "{}\n");
    writeFileSync(join(scratch, "Info.plist"), "<plist/>\n");
    writeFileSync(join(scratch, "Podfile"), "platform :ios\n");

    expect(readPushChangedPaths("develop", [], scratch).sort()).toEqual([
      "Art/Assets.xcassets/Logo.imageset/Contents.json",
      "Info.plist",
      "Podfile",
    ]);
  });

  it("counts committed work and working-tree work together", () => {
    writeFileSync(join(scratch, "Committed.swift"), "one\n");
    git(["add", "."], scratch);
    git(["commit", "-q", "-m", "feat: committed"], scratch);
    writeFileSync(join(scratch, "Uncommitted.swift"), "two\n");
    writeFileSync(join(scratch, "README.md"), "changed\n");

    expect(readPushChangedPaths("develop", [], scratch).sort()).toEqual([
      "Committed.swift",
      "README.md",
      "Uncommitted.swift",
    ]);
  });

  it("keeps the excluded response file out, exactly as the commit will", () => {
    writeFileSync(join(scratch, "A.swift"), "one\n");
    writeFileSync(join(scratch, "shipkit-response.json"), '{"title":"x"}\n');

    expect(readPushChangedPaths("develop", ["shipkit-response.json"], scratch)).toEqual([
      "A.swift",
    ]);
  });

  it("obeys .gitignore, because git applies the staging rules rather than a second copy of them", () => {
    writeFileSync(join(scratch, ".gitignore"), "ignored.swift\n");
    writeFileSync(join(scratch, "ignored.swift"), "noise\n");
    writeFileSync(join(scratch, "A.swift"), "one\n");

    expect(readPushChangedPaths("develop", [], scratch).sort()).toEqual([".gitignore", "A.swift"]);
  });

  it("reports a deletion, so a rule about the file that went still applies", () => {
    rmSync(join(scratch, "README.md"));
    expect(readPushChangedPaths("develop", [], scratch)).toEqual(["README.md"]);
  });

  it("reports a move as both paths rather than as one rename entry", () => {
    // Rename detection is on by default, and it reports one entry naming only where the
    // file arrived. A rule scoped to the directory the file *left* has to see that it left.
    //
    // The moved file has to exist at the merge base for this to be a move at all —
    // measured, not assumed: a file created and moved entirely on this branch is, against
    // the base, simply one addition, and the old path correctly never appears.
    mkdirSync(join(scratch, "Docs"), { recursive: true });
    writeFileSync(join(scratch, "Docs", "README.md"), "base\n");
    rmSync(join(scratch, "README.md"));

    expect(readPushChangedPaths("develop", [], scratch).sort()).toEqual([
      "Docs/README.md",
      "README.md",
    ]);
  });

  it("spells a non-ASCII path plainly, whatever core.quotePath says", () => {
    // The Turkish path this repository's own Jira makes likely. C-quoted, it matches no
    // glob at all and the rule silently stops applying.
    git(["config", "core.quotePath", "true"], scratch);
    writeFileSync(join(scratch, "Ayrıcalık.swift"), "one\n");

    expect(readPushChangedPaths("develop", [], scratch)).toEqual(["Ayrıcalık.swift"]);
  });

  it("gives the same answer run from a subdirectory", () => {
    mkdirSync(join(scratch, "Sub"), { recursive: true });
    writeFileSync(join(scratch, "Sub", "A.swift"), "one\n");
    writeFileSync(join(scratch, "Top.swift"), "one\n");

    expect(readPushChangedPaths("develop", [], join(scratch, "Sub")).sort()).toEqual([
      "Sub/A.swift",
      "Top.swift",
    ]);
  });

  it("leaves the real index and working tree exactly as it found them", () => {
    writeFileSync(join(scratch, "A.swift"), "one\n");
    const before = execFileSync("git", ["status", "--porcelain"], { cwd: scratch, encoding: "utf8" });

    readPushChangedPaths("develop", [], scratch);

    expect(execFileSync("git", ["status", "--porcelain"], { cwd: scratch, encoding: "utf8" })).toBe(
      before,
    );
  });

  it("throws VcsError for an unknown base", () => {
    expect(() => readPushChangedPaths("no-such-branch", [], scratch)).toThrow(VcsError);
  });

  it("treats a --base that looks like a git option as an invalid ref, and creates no file", () => {
    const marker = `shipkit-paths-probe-${Date.now()}`;
    expect(() => readPushChangedPaths(`--output=${join(tmpdir(), marker)}`, [], scratch)).toThrow(
      VcsError,
    );
  });
});
