/**
 * Which lines of a pull request's diff a review comment may actually land on.
 *
 * GitHub refuses a review comment whose line is not part of the diff — a 422, returned
 * after the review has otherwise been assembled and sent. That is the worst moment to fail:
 * the person has already read the remarks and decided to publish them.
 *
 * So the allowed positions are computed from the diff up front, handed to the agent as the
 * anchors it may use, and checked again before anything is posted. An anchor outside the
 * set is refused rather than moved to a nearby line, because a comment pointing at the
 * wrong line is worse than one that was never written.
 */

/** Which side of the diff a line belongs to. `LEFT` is the old file, `RIGHT` the new one. */
export type Side = "LEFT" | "RIGHT";

/** The lines of one file a comment may land on, as `"<line>:<side>"` keys. */
export type FileAnchors = Set<string>;

/** Every commentable position in a diff, by path. */
export type Anchors = Map<string, FileAnchors>;

function key(line: number, side: Side): string {
  return `${line}:${side}`;
}

/**
 * The path a comment should be filed under.
 *
 * Taken from the `+++` line, which is the new name — a rename must anchor to where the code
 * now lives. A deleted file has `+++ /dev/null`, and there the old name is the only one
 * there is.
 */
function pathOf(newPath: string | undefined, oldPath: string | undefined): string | undefined {
  if (newPath !== undefined && newPath !== "/dev/null") return newPath;
  if (oldPath !== undefined && oldPath !== "/dev/null") return oldPath;
  return undefined;
}

/** Strips the `a/` or `b/` prefix git puts on diff paths. */
function strip(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "/dev/null") return trimmed;
  return trimmed.replace(/^[ab]\//, "");
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses a unified diff into the positions a comment may use.
 *
 * A file with no hunks — a binary file, a pure mode change — contributes no anchors and no
 * entry, so asking about it answers false rather than throwing.
 */
export function commentableAnchors(diff: string): Anchors {
  const anchors: Anchors = new Map();

  let path: string | undefined;
  let oldPath: string | undefined;
  let newPath: string | undefined;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  const add = (line: number, side: Side): void => {
    if (path === undefined) return;
    let file = anchors.get(path);
    if (file === undefined) {
      file = new Set();
      anchors.set(path, file);
    }
    file.add(key(line, side));
  };

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      // A new file begins. Everything about the previous one is settled.
      path = undefined;
      oldPath = undefined;
      newPath = undefined;
      inHunk = false;
      continue;
    }

    if (raw.startsWith("--- ")) {
      oldPath = strip(raw.slice(4));
      inHunk = false;
      continue;
    }

    if (raw.startsWith("+++ ")) {
      newPath = strip(raw.slice(4));
      path = pathOf(newPath, oldPath);
      inHunk = false;
      continue;
    }

    const hunk = HUNK.exec(raw);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;

    // A marker about the line before it, not a line. Counting it shifts everything after
    // it down by one, which lands every later comment on the wrong line.
    if (raw.startsWith("\\")) continue;

    if (raw.startsWith("+")) {
      add(newLine, "RIGHT");
      newLine += 1;
      continue;
    }

    if (raw.startsWith("-")) {
      add(oldLine, "LEFT");
      oldLine += 1;
      continue;
    }

    if (raw.startsWith(" ")) {
      // Context: present on both sides, but a comment on unchanged code belongs to the
      // version that will exist after the merge.
      add(newLine, "RIGHT");
      oldLine += 1;
      newLine += 1;
      continue;
    }

    // Anything else ends the hunk: the trailing blank line between files, a `Binary files`
    // notice, git's own trailers. None of them is a line of content.
    inHunk = false;
  }

  return anchors;
}

/** Whether a comment at this exact position would be accepted. */
export function isAnchored(anchors: Anchors, path: string, line: number, side: Side): boolean {
  return anchors.get(path)?.has(key(line, side)) ?? false;
}
