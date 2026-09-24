import { describe, expect, it } from "vitest";
import { commentableAnchors, isAnchored } from "../../src/prreview/anchors.js";

// A two-hunk diff with additions, deletions and context, so the line arithmetic has
// something to get wrong.
const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,6 +10,7 @@ function one() {
 const kept = 1;
-const removed = 2;
+const added = 2;
+const alsoAdded = 3;
 const stillKept = 4;
 }

@@ -40,3 +41,3 @@ function two() {
-const gone = 5;
+const fresh = 5;
 const tail = 6;
`;

describe("deriving the lines a comment may land on", () => {
  it("numbers added lines against the new file, on the right", () => {
    const anchors = commentableAnchors(DIFF);

    // The hunk starts at new-file line 11. Line 11 is context (`kept`), the deletion
    // consumes an old line without advancing the new counter, so `added` is 12.
    expect(isAnchored(anchors, "src/a.ts", 12, "RIGHT")).toBe(true);
    expect(isAnchored(anchors, "src/a.ts", 13, "RIGHT")).toBe(true);
  });

  it("numbers deleted lines against the old file, on the left", () => {
    const anchors = commentableAnchors(DIFF);

    expect(isAnchored(anchors, "src/a.ts", 11, "LEFT")).toBe(true);
  });

  // A context line is commentable and is the anchor an agent reaches for when the remark
  // is about code the change did not touch but did move past.
  it("counts context lines as commentable", () => {
    expect(isAnchored(commentableAnchors(DIFF), "src/a.ts", 11, "RIGHT")).toBe(true);
  });

  it("restarts the arithmetic at the second hunk rather than running on", () => {
    const anchors = commentableAnchors(DIFF);

    expect(isAnchored(anchors, "src/a.ts", 41, "RIGHT")).toBe(true);
    expect(isAnchored(anchors, "src/a.ts", 42, "RIGHT")).toBe(true);
    // Between the hunks there is no diff, so nothing there is commentable.
    expect(isAnchored(anchors, "src/a.ts", 25, "RIGHT")).toBe(false);
  });

  it("does not anchor a file the diff never mentions", () => {
    expect(isAnchored(commentableAnchors(DIFF), "src/elsewhere.ts", 12, "RIGHT")).toBe(false);
  });

  // GitHub rejects a comment on a line outside the diff with a 422, after everything else
  // has succeeded. Being strict here is what keeps that from happening.
  it("does not anchor a line past the end of a hunk", () => {
    expect(isAnchored(commentableAnchors(DIFF), "src/a.ts", 500, "RIGHT")).toBe(false);
  });

  it("keeps two files apart", () => {
    const two = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,1 +1,2 @@
 one
+two
diff --git a/y.ts b/y.ts
--- a/y.ts
+++ b/y.ts
@@ -100,1 +100,2 @@
 hundred
+hundredone
`;
    const anchors = commentableAnchors(two);

    expect(isAnchored(anchors, "x.ts", 2, "RIGHT")).toBe(true);
    expect(isAnchored(anchors, "y.ts", 101, "RIGHT")).toBe(true);
    // x.ts has nothing at 101 — the files must not share a counter.
    expect(isAnchored(anchors, "x.ts", 101, "RIGHT")).toBe(false);
  });

  // `\ No newline at end of file` is a marker about the preceding line, not a line of its
  // own. Counting it shifts every line after it by one, which is the classic off-by-one in
  // diff parsing and produces comments that land one line low.
  it("does not let the no-newline marker advance either counter", () => {
    const diff = `diff --git a/n.ts b/n.ts
--- a/n.ts
+++ b/n.ts
@@ -1,2 +1,2 @@
-old
\\ No newline at end of file
+new
+after
`;
    const anchors = commentableAnchors(diff);

    expect(isAnchored(anchors, "n.ts", 1, "RIGHT")).toBe(true);
    expect(isAnchored(anchors, "n.ts", 2, "RIGHT")).toBe(true);
    expect(isAnchored(anchors, "n.ts", 3, "RIGHT")).toBe(false);
  });

  // A binary file has no lines, so it has no anchors. Emitting one would produce a comment
  // GitHub refuses.
  it("gives a binary file no anchors at all", () => {
    const diff = `diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ
`;
    expect(commentableAnchors(diff).size).toBe(0);
  });

  it("reads the path from the +++ line, so a rename anchors to the new name", () => {
    const diff = `diff --git a/old.ts b/new.ts
similarity index 90%
rename from old.ts
rename to new.ts
--- a/old.ts
+++ b/new.ts
@@ -1,1 +1,2 @@
 one
+two
`;
    const anchors = commentableAnchors(diff);

    expect(isAnchored(anchors, "new.ts", 2, "RIGHT")).toBe(true);
    expect(isAnchored(anchors, "old.ts", 2, "RIGHT")).toBe(false);
  });

  // A deleted file's +++ line is /dev/null; its content is only commentable on the left,
  // under the name the old side carried.
  it("anchors a deleted file to its old path, on the left only", () => {
    const diff = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
`;
    const anchors = commentableAnchors(diff);

    expect(isAnchored(anchors, "gone.ts", 1, "LEFT")).toBe(true);
    expect(isAnchored(anchors, "gone.ts", 2, "LEFT")).toBe(true);
    expect(isAnchored(anchors, "gone.ts", 1, "RIGHT")).toBe(false);
  });

  it("reads an empty diff as nothing being commentable, rather than throwing", () => {
    expect(commentableAnchors("").size).toBe(0);
  });
});
