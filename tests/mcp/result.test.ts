import { describe, expect, it } from "vitest";
import { applyContent, briefContent, failureContent, previewContent } from "../../src/mcp/result.js";
import type { SubmitResult } from "../../src/submit/run.js";
import type { Brief } from "../../src/brief/types.js";

const BRIEF: Brief = {
  change: { branch: "bugfix/x/1-y", files: ["a.ts"], diffstat: "1 file", commits: ["fix: y"] },
  target: { branch: "develop", reason: "given" },
  template: { sections: [{ name: "Summary", required: true }] },
  rules: {
    titlePattern: "^x", branchPattern: "^y", keyPattern: "DCP-\\d+",
    forbidden: ["TBD"], issuesSection: "Issues Addressed", linkPolicy: "story",
  },
};

const OK: SubmitResult = {
  code: 0, findings: [], warnings: [], body: "## Summary\n\ns\n",
  url: "https://example.com/pr/1", updated: false, committed: true, pushed: true,
};

describe("briefContent", () => {
  it("carries the brief as structured data, not only as prose", () => {
    expect(briefContent(BRIEF).structuredContent).toEqual(BRIEF as unknown as Record<string, unknown>);
  });

  it("is not an error", () => {
    expect(briefContent(BRIEF).isError).toBe(false);
  });
});

describe("previewContent", () => {
  it("returns the body so the caller can see what would be posted", () => {
    const shaped = previewContent({ ...OK, url: undefined, committed: false, pushed: false });
    expect(shaped.structuredContent.body).toBe("## Summary\n\ns\n");
  });

  it("names every warning id, because those ids are what apply will ask for", () => {
    const shaped = previewContent({
      code: 0, findings: [],
      warnings: [
        { check: "untracked-files", message: "two files" },
        { check: "base-mismatch", message: "targets develop" },
      ],
      body: "b", committed: false, pushed: false,
    });
    expect(shaped.structuredContent.warnings).toEqual(["untracked-files", "base-mismatch"]);
    expect(shaped.content[0].text).toContain("untracked-files");
    expect(shaped.content[0].text).toContain("base-mismatch");
  });

  // A preview reports; it never refuses. Only a wrong answer makes it an error.
  it("is not an error when there are warnings", () => {
    const shaped = previewContent({
      code: 0, findings: [], warnings: [{ check: "untracked-files", message: "m" }],
      body: "b", committed: false, pushed: false,
    });
    expect(shaped.isError).toBe(false);
  });

  it("is an error when the answer does not validate", () => {
    const shaped = previewContent({
      code: 1, findings: [{ rule: "title-pattern", message: "bad" }], warnings: [],
      body: "b", committed: false, pushed: false,
    });
    expect(shaped.isError).toBe(true);
    expect(shaped.content[0].text).toContain("title-pattern");
  });
});

describe("applyContent", () => {
  it("returns the url and whether the pull request already existed", () => {
    const shaped = applyContent(OK);
    expect(shaped.isError).toBe(false);
    expect(shaped.structuredContent.url).toBe("https://example.com/pr/1");
    expect(shaped.structuredContent.updated).toBe(false);
  });

  // The ids are the actionable part: they are exactly what has to come back in acknowledge.
  it("tells a refused caller which ids to acknowledge", () => {
    const shaped = applyContent({
      code: 2, findings: [],
      warnings: [{ check: "untracked-files", message: "m" }],
      body: "b", message: "Refusing to proceed",
      committed: false, pushed: false,
    });
    expect(shaped.isError).toBe(true);
    expect(shaped.structuredContent.warnings).toEqual(["untracked-files"]);
    expect(shaped.content[0].text).toContain(`Call again with acknowledge: ["untracked-files"] to proceed.`);
  });

  it("builds acknowledge guidance from all refused ids, not just the first", () => {
    const shaped = applyContent({
      code: 2, findings: [],
      warnings: [
        { check: "untracked-files", message: "m1" },
        { check: "base-mismatch", message: "m2" },
      ],
      body: "b", message: "Refusing to proceed",
      committed: false, pushed: false,
    });
    expect(shaped.isError).toBe(true);
    expect(shaped.structuredContent.warnings).toEqual(["untracked-files", "base-mismatch"]);
    expect(shaped.content[0].text).toContain(`acknowledge: ["untracked-files", "base-mismatch"]`);
  });

  // Half-done is the state a caller most needs told, and the one it is least likely to guess.
  it("says what was left behind when the sequence failed part way", () => {
    const shaped = applyContent({
      code: 2, findings: [], warnings: [], body: "b",
      message: "git push failed: rejected", committed: true, pushed: false,
    });
    expect(shaped.isError).toBe(true);
    expect(shaped.structuredContent.committed).toBe(true);
    expect(shaped.structuredContent.pushed).toBe(false);
    expect(shaped.content[0].text).toContain("commit");
  });
});

describe("failureContent", () => {
  it("reports a message as content rather than as a thrown fault", () => {
    const shaped = failureContent("Cannot read .shipkit.yml");
    expect(shaped.isError).toBe(true);
    expect(shaped.content[0].text).toContain("Cannot read .shipkit.yml");
  });
});
