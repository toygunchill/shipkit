import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangedFile } from "../advice/uikit.js";
import { asVcsError, execRunner, MAX_OUTPUT_BYTES } from "./exec.js";
import { stagingPathspec } from "./mutate.js";
import { VcsError, type AddedLine, type RepoState } from "./types.js";

export { VcsError };
export type { AddedLine, RepoState };

function git(args: string[], cwd: string): string {
  return execRunner("git", cwd)(args);
}

/**
 * The same call with `GIT_INDEX_FILE` pointed at a scratch index, so a staging
 * question can be asked without disturbing the index the person is working in.
 * `execRunner` has no seam for the environment, and giving it one would put an
 * environment parameter on every read in this module for the sake of one.
 */
function gitWithIndex(args: string[], cwd: string, indexFile: string): string {
  return asVcsError("git", args, () =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // The scratch-index reads include `readPushDiff`, which returns the whole patch. See
      // MAX_OUTPUT_BYTES: the default cap turned a large change into an exit 2 with no
      // reason printed.
      maxBuffer: MAX_OUTPUT_BYTES,
      env: { ...process.env, GIT_INDEX_FILE: indexFile },
    }),
  );
}

export function currentBranch(cwd: string = process.cwd()): string {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], cwd).trim();
}

export function readRepoState(base: string, cwd: string = process.cwd()): RepoState {
  const diffRange = `${base}...HEAD`;
  const logRange = `${base}..HEAD`;
  // `--end-of-options` forces git to treat everything after it as a revision/pathspec, never
  // an option — without it, a `base` starting with `-` (e.g. `--output=/tmp/x`) is parsed as a
  // git flag instead of a ref, letting a caller-controlled string make git write files.
  return {
    branch: currentBranch(cwd),
    changedFiles: git(["diff", "--name-only", "--end-of-options", diffRange], cwd)
      .split("\n")
      .filter(Boolean),
    diffstat: git(["diff", "--stat", "--end-of-options", diffRange], cwd).trim(),
    commits: git(["log", "--format=%s", "--end-of-options", logRange], cwd)
      .split("\n")
      .filter(Boolean),
  };
}

/**
 * The diffstat of what pushing this branch will actually deliver, measured against the
 * merge base with `base` — the committed work *plus* everything `commitAll` is about to
 * sweep in, untracked files included, minus the paths `exclude` keeps out.
 *
 * `readRepoState`'s diffstat answers a different question: `git diff --stat base...HEAD`
 * is committed work only. On the branch this exists for — an agent making four hundred
 * files of uncommitted changes on a fresh branch off `develop` — that range is empty, the
 * panel renders a blank line where the size of the change belongs, and a person approves
 * a push whose size was never shown to them.
 *
 * `git diff --stat` cannot see untracked files at all, so the tree that `git add --all`
 * would produce is built for real, in a scratch index:
 *
 *   - `read-tree <merge-base>` seeds it with what the base already has;
 *   - `add --all` with `commitAll`'s own pathspec applies exactly the staging rules the
 *     commit will apply — `.gitignore`, `core.excludesFile`, the exclusions, all of it,
 *     by construction rather than by a second implementation that can drift;
 *   - `diff --cached <merge-base>` states the difference between the two.
 *
 * `git add --intent-to-add` was tried first and is wrong: measured, `add --all -N` removes
 * the index entry for a file deleted in the working tree, so the deletion vanishes from
 * the stat entirely — an under-report, in the one direction that matters.
 *
 * The scratch index lives outside the repository. Also measured: written beside `.git` it
 * is itself an untracked file, so `add --all` swept the index and its lock into the very
 * stat being computed.
 *
 * The real index and working tree are untouched. `add` does write blobs into the object
 * database, which is the price of asking git what a commit would contain; they are
 * unreferenced and collected like any other.
 */
export function readPushDiffstat(
  base: string,
  exclude: string[] = [],
  cwd: string = process.cwd(),
): string {
  // Only `base` is caller-controlled, and `--end-of-options` is what stops a `--output=`
  // spelling of it from turning a read into a write. Everything downstream is the resolved
  // object id this returns.
  const mergeBase = git(["merge-base", "--end-of-options", base, "HEAD"], cwd).trim();
  const pathspec = stagingPathspec(exclude);
  const scratch = mkdtempSync(join(tmpdir(), "shipkit-index-"));
  const index = join(scratch, "index");
  try {
    gitWithIndex(["read-tree", "--end-of-options", mergeBase], cwd, index);
    gitWithIndex(["add", "--all", ...pathspec], cwd, index);
    return gitWithIndex(
      // `--no-relative` overrides `diff.relative`. That config makes git print paths (and
      // count "N files changed") relative to `cwd` even with an explicit `:/` pathspec —
      // measured, not assumed: from a subdirectory, with `diff.relative` set, a file outside
      // cwd drops out of the stat entirely rather than just displaying oddly. `readUntrackedFiles`
      // above fends off the same axis with `:/` and `--full-name`; `:/` alone doesn't reach here.
      ["diff", "--cached", "--stat", "--no-relative", "--end-of-options", mergeBase, ...pathspec],
      cwd,
      index,
    ).trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Every line this push adds, paired with the file it lands in.
 *
 * Staged into a scratch index for the reason `readPushDiffstat` records: the answer has to
 * be about the change that lands, and `commitAll` stages after the gate, so a read against
 * HEAD alone would miss the working tree entirely.
 *
 * `-U0` because context lines are noise here — the question is only what is new. The `+++`
 * header names the file for the run of `+` lines beneath it; `/dev/null` appears there for
 * a deletion, whose hunk contributes no added lines anyway. A bare `+++` line of the diff's
 * own making is impossible: git escapes a literal one in content as part of the hunk body,
 * which always carries the leading `+` marker this strips.
 */
export function readPushAddedLines(
  base: string,
  exclude: string[] = [],
  cwd: string = process.cwd(),
): AddedLine[] {
  // `--end-of-options` for the reason the reads above record: only `base` is
  // caller-controlled, and it must not be able to spell itself as an option.
  const mergeBase = git(["merge-base", "--end-of-options", base, "HEAD"], cwd).trim();
  const pathspec = stagingPathspec(exclude);
  const scratch = mkdtempSync(join(tmpdir(), "shipkit-index-"));
  const index = join(scratch, "index");
  try {
    gitWithIndex(["read-tree", "--end-of-options", mergeBase], cwd, index);
    gitWithIndex(["add", "--all", ...pathspec], cwd, index);
    const raw = gitWithIndex(
      [
        "diff", "--cached", "-U0", "--no-color", "--no-relative", "--no-renames",
        "--end-of-options", mergeBase, ...pathspec,
      ],
      cwd,
      index,
    );

    const lines: AddedLine[] = [];
    let path = "";
    for (const line of raw.split("\n")) {
      if (line.startsWith("+++ ")) {
        const target = line.slice(4);
        path = target === "/dev/null" ? "" : target.replace(/^b\//, "");
        continue;
      }
      if (line.startsWith("+") && path.length > 0) {
        lines.push({ path, text: line.slice(1) });
      }
    }
    return lines;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The only paths that can carry the UIKit-to-SwiftUI signal. `detectConversion` reads
 * whole file contents, so the restriction is not cosmetic: without it a four-hundred-file
 * push would have every blob on both sides read out of the object database to prove that
 * a `.json` is still not a view controller.
 *
 * `glob` makes `**` mean "any number of directories" rather than falling back to git's
 * default matching, and `top` anchors it at the repository root so the answer does not
 * depend on which directory shipkit was invoked from. Measured against real git: the
 * `.swift` entry matches a root-level `Top.swift` as well as `Sub/Deep/Nested.swift`, and
 * gives the same two answers run from the root and run from `Sub/`.
 */
const CONVERTIBLE_PATHSPEC = [".swift", ".xib", ".storyboard"].map(
  (extension_) => `:(glob,top)**/*${extension_}`,
);

/** git's one-letter `--name-status` codes, narrowed to what `ChangedFile` models. A
 *  type-change (`T`) or anything else unexpected reads as a modification, which is the
 *  answer that makes `detectConversion` look at both sides rather than assume one. */
function changeStatus(code: string): ChangedFile["status"] {
  if (code.startsWith("A")) return "added";
  if (code.startsWith("D")) return "deleted";
  return "modified";
}

/**
 * Reads a blob, or the empty string when there isn't one.
 *
 * Never throwing is the contract, not a convenience: an added file has no `before` and a
 * deleted one has no `after`, and both are the ordinary case rather than an error. This is
 * the *only* rule that produces an empty side — the caller does not also branch on the
 * status letter, which would leave this catch unreachable and untested while the code read
 * as though it were what guaranteed the behaviour.
 *
 * The catch is deliberately total. A blob too large for `execFileSync`'s buffer lands here
 * too, and an empty side makes `detectConversion` say nothing — the direction this whole
 * feature errs in, by design.
 */
function readBlob(spec: string, cwd: string, indexFile: string): string {
  try {
    return execFileSync("git", ["cat-file", "blob", spec], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // The scratch-index reads include `readPushDiff`, which returns the whole patch. See
      // MAX_OUTPUT_BYTES: the default cap turned a large change into an exit 2 with no
      // reason printed.
      maxBuffer: MAX_OUTPUT_BYTES,
      env: { ...process.env, GIT_INDEX_FILE: indexFile },
    });
  } catch {
    return "";
  }
}

/**
 * The `.swift`, `.xib` and `.storyboard` files this push will deliver, with the text on
 * both sides, for `detectConversion` to read.
 *
 * Measured against the merge base and through the same scratch index `readPushDiffstat`
 * builds, for the same reason: `commitAll` runs `git add --all` *after* the gate, so the
 * conversion an agent has just written and not committed is the common case, and a reader
 * asking `base...HEAD` would see nothing exactly when there is something to see. That is
 * the diffstat bug — a blank panel while four hundred files were about to be pushed — and
 * repeating it here would make the advice silent on the run it exists for.
 *
 * `--no-renames` is load-bearing rather than tidy. Rename detection is on by default, and
 * a deleted `Screen.xib` paired with an added `Screen.swift` is precisely the corroborating
 * evidence `detectConversion` looks for — reported as one `R` entry it is neither a
 * deletion nor an addition, and the signal disappears.
 *
 * `-z` for the same class of reason: `core.quotePath` mangles a non-ASCII path into a
 * C-quoted string, and this repository's own Jira speaks Turkish.
 */
export function readPushChangedFiles(
  base: string,
  exclude: string[] = [],
  cwd: string = process.cwd(),
): ChangedFile[] {
  // Only `base` is caller-controlled; `--end-of-options` is what stops a `--output=`
  // spelling of it from turning this read into a write, as in `readPushDiffstat`.
  const mergeBase = git(["merge-base", "--end-of-options", base, "HEAD"], cwd).trim();
  const scratch = mkdtempSync(join(tmpdir(), "shipkit-index-"));
  const index = join(scratch, "index");
  try {
    gitWithIndex(["read-tree", "--end-of-options", mergeBase], cwd, index);
    // `commitAll`'s own pathspec, so the index holds exactly what the commit would —
    // .gitignore and core.excludesFile applied by git rather than re-implemented. For the
    // exclusions specifically this doubles up with the diff pathspec below: measured, either
    // layer alone keeps an excluded path out of the answer. It is kept because
    // `readPushDiffstat` stages identically and the two must not drift.
    gitWithIndex(["add", "--all", ...stagingPathspec(exclude)], cwd, index);

    const pathspec = [
      "--",
      ...CONVERTIBLE_PATHSPEC,
      ...exclude.map((path) => `:(exclude,literal,top)${path}`),
    ];
    // `--no-relative` for the reason `readPushDiffstat` records: `diff.relative` makes git
    // print paths relative to cwd, and a path spelled relative to a subdirectory is not one
    // `cat-file` can resolve against the repository root.
    const raw = gitWithIndex(
      [
        "diff", "--cached", "--name-status", "-z", "--no-relative", "--no-renames",
        "--end-of-options", mergeBase, ...pathspec,
      ],
      cwd,
      index,
    );

    const fields = raw.split("\0").filter((field) => field.length > 0);
    const files: ChangedFile[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const status = changeStatus(fields[i] as string);
      const path = fields[i + 1] as string;
      files.push({
        path,
        status,
        // `<sha>:<path>` reads the merge base's blob; a bare `:<path>` reads stage 0 of the
        // scratch index, which is what the commit would carry. Both are root-relative,
        // which is what `--no-relative` above guarantees the paths are. Asked
        // unconditionally: an added file simply has no blob at the merge base, and a
        // deleted one none in the index, and `readBlob` answers "" for exactly that.
        before: readBlob(`${mergeBase}:${path}`, cwd, index),
        after: readBlob(`:${path}`, cwd, index),
      });
    }
    return files;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Every path this push will deliver — names only, and every file type.
 *
 * `readPushChangedFiles` above cannot serve this: it is deliberately narrowed to
 * `.swift`/`.xib`/`.storyboard` and reads both sides of every blob it returns, which is
 * right for conversion detection and wrong twice over here. A readiness rule can be about
 * an asset catalog, a plist, a storyboard or a Podfile, and none of them would appear; and
 * nothing here needs a byte of content, only whether a path was touched.
 *
 * The same scratch-index recipe as `readPushDiffstat`, for the same reason, which this
 * project has already paid for once: `commitAll` stages *after* the gate, so an agent's
 * whole change is typically uncommitted when this is asked. A reader asking
 * `base...HEAD` would answer "nothing changed" on precisely the run that has everything to
 * check — the blank-diffstat bug, re-created as an `appliesTo` filter that quietly excuses
 * every rule.
 *
 * `-z` because `core.quotePath` mangles a non-ASCII path into a C-quoted string, and a
 * mangled path silently matches no glob. `--no-renames` so a moved file is reported as both
 * the path that went and the path that arrived, which is what a rule about either one wants.
 */
export function readPushChangedPaths(
  base: string,
  exclude: string[] = [],
  cwd: string = process.cwd(),
): string[] {
  // `--end-of-options` for the reason the reads above record: only `base` is
  // caller-controlled, and it must not be able to spell itself as an option.
  const mergeBase = git(["merge-base", "--end-of-options", base, "HEAD"], cwd).trim();
  const pathspec = stagingPathspec(exclude);
  const scratch = mkdtempSync(join(tmpdir(), "shipkit-index-"));
  const index = join(scratch, "index");
  try {
    gitWithIndex(["read-tree", "--end-of-options", mergeBase], cwd, index);
    gitWithIndex(["add", "--all", ...pathspec], cwd, index);
    // `--no-relative` for the reason `readPushDiffstat` records: `diff.relative` prints
    // paths relative to cwd, and a glob written against the repository root would then
    // match or miss depending on which directory shipkit happened to be invoked from.
    const raw = gitWithIndex(
      [
        "diff", "--cached", "--name-only", "-z", "--no-relative", "--no-renames",
        "--end-of-options", mergeBase, ...pathspec,
      ],
      cwd,
      index,
    );
    return raw.split("\0").filter((path) => path.length > 0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** One file of the push, with the patch a person reads. */
export type PushFileDiff = {
  path: string;
  status: ChangedFile["status"];
  /**
   * The unified diff git printed for this file, hunk headers and all, or the empty string
   * when git printed no hunks — a binary file, or a mode change with no content change.
   * Rendered verbatim; the page escapes it rather than re-parsing it.
   */
  patch: string;
  /**
   * The first line this change actually touches, numbered on the *new* side, or 1 when
   * there is no hunk at all (a binary file). It is the only line number in the whole
   * feature that is derived from the diff rather than invented — findings are not
   * line-anchored, and none is claimed for them.
   *
   * Not the hunk header's own `+c`, which was the first attempt and is wrong: measured, a
   * change to the last line of a four-line file produces `@@ -1,4 +1,4 @@`, because the
   * header covers three lines of context first. Opening the editor there puts the cursor
   * three lines above the change in the small case and, on a long file, at whichever line
   * happens to be three above it — close enough to look right and wrong every time.
   */
  line: number;
};

/**
 * The push as a patch, file by file.
 *
 * The same scratch-index recipe as `readPushDiffstat`, for the third time and for the third
 * reason: a review that showed only committed work would be reviewing the wrong change,
 * because `commitAll` runs `git add --all` after the gate and an agent's whole change is
 * typically uncommitted when a person is asked to look at it. `readPushDiffstat` records the
 * measurement; this one just reuses it.
 *
 * Two reads against the one index rather than one. `--name-status -z` is the authoritative
 * list of paths and statuses — `-z` because `core.quotePath` mangles a non-ASCII path, and
 * this repository's own Jira speaks Turkish. The patch read then supplies the text, matched
 * back by path. Deriving the path list from the patch alone was rejected: a binary file
 * produces no `+++` line at all, so it would silently vanish from a review of a change that
 * carries it.
 *
 * `-c core.quotePath=false` on the patch read for the same reason `-z` is on the other, and
 * because there is no `-z` for patch output: without it a path with a non-ASCII byte comes
 * back C-quoted and matches nothing in the `--name-status` list.
 *
 * `--no-renames` so a moved file reads as a deletion and an addition, which is what the
 * other three push reads already do and what keeps the two lists in step.
 */
export function readPushDiff(
  base: string,
  exclude: string[] = [],
  cwd: string = process.cwd(),
): PushFileDiff[] {
  // `--end-of-options` for the reason the reads above record: only `base` is
  // caller-controlled, and it must not be able to spell itself as an option.
  const mergeBase = git(["merge-base", "--end-of-options", base, "HEAD"], cwd).trim();
  const pathspec = stagingPathspec(exclude);
  const scratch = mkdtempSync(join(tmpdir(), "shipkit-index-"));
  const index = join(scratch, "index");
  try {
    gitWithIndex(["read-tree", "--end-of-options", mergeBase], cwd, index);
    gitWithIndex(["add", "--all", ...pathspec], cwd, index);
    // `--no-relative` for the reason `readPushDiffstat` records: `diff.relative` prints
    // paths relative to cwd, so the answer would depend on which directory shipkit was
    // invoked from — and these two reads are matched to each other by path.
    const names = gitWithIndex(
      [
        "diff", "--cached", "--name-status", "-z", "--no-relative", "--no-renames",
        "--end-of-options", mergeBase, ...pathspec,
      ],
      cwd,
      index,
    );
    const patches = gitWithIndex(
      [
        "-c", "core.quotePath=false",
        "diff", "--cached", "-p", "--no-color", "--no-relative", "--no-renames",
        "--end-of-options", mergeBase, ...pathspec,
      ],
      cwd,
      index,
    );

    const byPath = splitPatch(patches);
    const fields = names.split("\0").filter((field) => field.length > 0);
    const files: PushFileDiff[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const path = fields[i + 1] as string;
      const patch = byPath.get(path) ?? "";
      files.push({
        path,
        status: changeStatus(fields[i] as string),
        patch,
        line: firstNewLine(patch),
      });
    }
    return files;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Splits `git diff -p` output into one patch per file, keyed by path.
 *
 * The key comes from the `+++ b/<path>` line rather than the `diff --git a/x b/x` header,
 * which is genuinely ambiguous for a path containing a space — git writes both halves on
 * one line with nothing between them but a space. `+++` runs to the end of the line and is
 * not ambiguous. A deletion has `+++ /dev/null`, so the `--- a/<path>` line answers for it.
 *
 * A `+++` line inside the content of the diff cannot be confused for a header: content
 * lines always carry a leading `+`, `-` or space from the hunk body, so a line starting
 * `+++ ` in a file's own text arrives here as `++++ `.
 *
 * The trailing tab is not decoration. Measured: for a path containing a space git writes
 * `+++ b/two words.ts\t`, the unidiff convention that makes such a path parseable at all.
 * Without cutting at it, the key carries a tab, matches nothing in the `--name-status`
 * list, and every file whose name contains a space is shown with an empty patch. A tab
 * inside a real path cannot be lost this way: git C-quotes such a path regardless of
 * `core.quotePath`, so the tab never appears raw.
 */
function splitPatch(raw: string): Map<string, string> {
  const byPath = new Map<string, string>();
  let current: string[] = [];
  let path: string | undefined;
  let minus: string | undefined;

  const flush = (): void => {
    const name = path ?? minus;
    if (name !== undefined && current.length > 0) byPath.set(name, current.join("\n"));
    current = [];
    path = undefined;
    minus = undefined;
  };

  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      current.push(line);
      continue;
    }
    if (current.length === 0) continue;
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).split("\t")[0] as string;
      if (target !== "/dev/null") path = target.replace(/^b\//, "");
    } else if (line.startsWith("--- ")) {
      const target = line.slice(4).split("\t")[0] as string;
      if (target !== "/dev/null") minus = target.replace(/^a\//, "");
    }
    current.push(line);
  }
  flush();
  return byPath;
}

/**
 * Walks the hunks until a line is added or removed, counting context as it goes, and
 * answers where that lands on the new side. 1 when the patch carries no hunk at all.
 */
function firstNewLine(patch: string): number {
  let line = 0;
  let inHunk = false;
  for (const text of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(text);
    if (header !== null) {
      // `@@ ... +0,0 @@` is what a whole-file deletion's hunk says. Nobody can open line 0.
      line = Math.max(1, Number(header[1]));
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    // "\ No newline at end of file" is a note about the line above, not a line of its own.
    if (text.startsWith("\\")) continue;
    if (text.startsWith("+") || text.startsWith("-")) return line;
    if (text.startsWith(" ")) {
      line += 1;
      continue;
    }
    // Anything else ends the hunk — in practice the `diff --git` of the next file, which
    // `splitPatch` has already cut away, so this is only reached by a trailing blank.
    inHunk = false;
  }
  return 1;
}

/**
 * The files `git add --all` would bring into the commit that are not tracked yet —
 * scratch notes, local env files, and the agent's own response file. `--exclude-standard`
 * keeps ignored paths out, so what comes back is only what would really be committed.
 */
export function readUntrackedFiles(cwd: string = process.cwd()): string[] {
  // `:/` and `--full-name` together make this a question about the repository rather than
  // about the current directory. Without them `ls-files` reports only what sits below cwd,
  // so running shipkit from a subdirectory would hide the root-level files that staging
  // sweeps in anyway — the warning would go quiet exactly where it is most needed.
  return git(["ls-files", "--others", "--exclude-standard", "--full-name", "--", ":/"], cwd)
    .split("\n")
    .filter(Boolean);
}

/** Absolute path of the repository root, for turning caller paths into root-relative ones. */
export function readRepoRoot(cwd: string = process.cwd()): string {
  return git(["rev-parse", "--show-toplevel"], cwd).trim();
}

/** The full commit id of `HEAD`, unabbreviated because it goes into a fingerprint. */
export function readHeadSha(cwd: string = process.cwd()): string {
  return git(["rev-parse", "HEAD"], cwd).trim();
}
