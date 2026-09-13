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

  // A forbidden term is matched with body.includes() in src/validate/rules.ts:
  // it rejects a pull request wherever those characters appear, not only on a
  // line of their own. So the cost of a wrong entry is not a weak guess, it is
  // every later pull request containing that string being rejected as unfilled
  // boilerplate. The tests below fix the shape a line must have to be banned.

  it("does not ban a short answer the team really writes, however often it recurs", () => {
    // "N/A" is the honest answer to a screenshots section on a backend change.
    // Banned, it would also reject "N/A — backend only" and "N/Autopilot".
    const bodies = Array.from(
      { length: 3 },
      (_, i) => `## Summary\nfix ${i}\n\n## Screenshots / Screen Recordings\nN/A`,
    );
    expect(boilerplateLines(bodies, 2).value).toEqual([]);
  });

  it("does not ban a one-character line two bodies happen to share", () => {
    // Two merged pull requests is the bootstrap case init exists for; at that
    // size every line either body repeats clears any count-based threshold.
    expect(boilerplateLines(["## A\nx", "## A\nx"], 2).value).toEqual([]);
  });

  it("treats a bold-only line as a heading, exactly as it treats a # heading", () => {
    // A team writing "**Summary**" instead of "## Summary" has a house style,
    // not a template nobody filled in — and banning it contradicts pr.sections,
    // which proposes those same words as a section to write under.
    const bodies = Array.from(
      { length: 6 },
      (_, i) => `**Summary**\nchange ${i}\n\n**What to Test**\nrun the suite\n\n__Issues Addressed__\nDCP-${i}`,
    );
    expect(boilerplateLines(bodies, 4).value).toEqual([]);
  });

  it("does not ban a long line that is a single token, such as a link", () => {
    // Instruction text is a sentence. A bare URL is one token, and banning it
    // rejects every pull request that cites the page it points at.
    const bodies = Array.from(
      { length: 3 },
      () => "## Summary\nhttps://wiki.example.com/engineering/how-we-write-pull-requests",
    );
    expect(boilerplateLines(bodies, 3).value).toEqual([]);
  });

  it("bans instruction text that is long and sentence-shaped, even among short answers", () => {
    // The positive half of the same rule: not structure, long enough to be an
    // instruction, several words. This is what forbidden is for.
    const bodies = Array.from(
      { length: 3 },
      (_, i) => `**Summary**\nchange ${i}\n\n**Issues Addressed**\nN/A\n${TEMPLATE_LINE}`,
    );
    expect(boilerplateLines(bodies, 3).value).toEqual([TEMPLATE_LINE]);
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

  it("will not make a heading mandatory on the strength of one pull request", () => {
    // One merged pull request carrying someone's ad-hoc note is 100% of the
    // sample and still no evidence of a convention. Required is the setting
    // that rejects later work, so it needs a sample worth generalising from.
    const got = sectionSkeleton(["## Note to self: revisit later\nmeh"]);
    expect(got.value).toEqual([{ name: "Note to self: revisit later", required: false }]);
  });

  it("will not make a heading mandatory on the strength of two", () => {
    const bodies = ["## Summary\na", "## Summary\nb"];
    expect(sectionSkeleton(bodies).value[0].required).toBe(false);
  });

  it("says in why that a sample too small to generalise from is why nothing is required", () => {
    const got = sectionSkeleton(["## Summary\na", "## Summary\nb"]);
    expect(got.why).toMatch(/none marked required/);
    expect(got.why).toContain("2 bodies");
  });

  it("marks a heading required once the sample is big enough to mean something", () => {
    const bodies = ["## Summary\na", "## Summary\nb", "## Summary\nc"];
    expect(sectionSkeleton(bodies).value[0].required).toBe(true);
  });
});
