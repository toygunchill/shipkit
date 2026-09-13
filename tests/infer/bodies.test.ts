import { describe, expect, it } from "vitest";
import { boilerplateLines, sectionSkeleton } from "../../src/infer/bodies.js";

const TEMPLATE_LINE = "Please link only parent Development-level Jira issues such as Story or Task.";

describe("boilerplateLines", () => {
  it("finds the instruction text that recurs verbatim across bodies", () => {
    const bodies = [
      `## Summary\nFixed the invoice bug.\n\n## Issues Addressed\n${TEMPLATE_LINE}`,
      `## Summary\nChanged the seat map.\n\n## Issues Addressed\n${TEMPLATE_LINE}`,
      `## Summary\nSomething else.\n\n## Issues Addressed\n${TEMPLATE_LINE}`,
    ];
    expect(boilerplateLines(bodies, 3).value).toContain(TEMPLATE_LINE);
  });

  it("does not mistake a heading for boilerplate", () => {
    const bodies = ["## Summary\na", "## Summary\nb", "## Summary\nc"];
    expect(boilerplateLines(bodies, 3).value).not.toContain("## Summary");
  });

  it("does not mistake prose that happens to repeat twice for a template", () => {
    const bodies = ["## Summary\nBumped the version.", "## Summary\nBumped the version.", "## Summary\nreal work"];
    expect(boilerplateLines(bodies, 3).value).not.toContain("Bumped the version.");
  });

  it("ignores blank lines and list bullets, which recur everywhere", () => {
    const bodies = ["## A\n\n- \n", "## A\n\n- \n", "## A\n\n- \n"];
    expect(boilerplateLines(bodies, 3).value).toEqual([]);
  });

  it("is observed, not read — it describes the past", () => {
    expect(boilerplateLines(["## A\nx"], 1).provenance).toBe("observed");
  });
});

describe("sectionSkeleton", () => {
  it("keeps the headings most bodies share, in the order they appear", () => {
    const bodies = [
      "## Summary\na\n## What to Test\nb\n## Issues Addressed\nc",
      "## Summary\na\n## What to Test\nb\n## Issues Addressed\nc",
      "## Summary\na\n## Issues Addressed\nc",
    ];
    expect(sectionSkeleton(bodies).value.map((s) => s.name)).toEqual([
      "Summary",
      "What to Test",
      "Issues Addressed",
    ]);
  });

  it("marks a heading that only a minority carry as not required", () => {
    const bodies = [
      "## Summary\na\n## Analysis JIRA Issue\nx",
      "## Summary\na",
      "## Summary\na",
      "## Summary\na",
    ];
    const analysis = sectionSkeleton(bodies).value.find((s) => s.name === "Analysis JIRA Issue");
    expect(analysis?.required).toBe(false);
  });

  it("returns nothing rather than guessing when there are no bodies", () => {
    expect(sectionSkeleton([]).value).toEqual([]);
  });
});
