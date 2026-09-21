import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { validate } from "../../src/validate/rules.js";

const config = loadConfig("tests/fixtures/valid.shipkit.yml");
const TITLE = "[ABC-31087] fix(invoice): default citizenship from passenger info";

const goodBody = [
  "## Summary",
  "",
  "Add Invoice always defaulted citizenship to Turkish.",
  "",
  "---",
  "",
  "## Screenshots / Screen Recordings",
  "",
  "| Before | After |",
  "",
  "---",
  "",
  "## What to Test",
  "",
  "- Passenger with a national ID sees Turkish.",
  "- Passenger without one sees Foreign.",
  "- Switching invoice type keeps the derived default.",
  "",
  "---",
  "",
  "## Issues Addressed",
  "",
  "- [ABC-31086](https://jira.example.com/browse/ABC-31086)",
].join("\n");

const rules = (result: { findings: { rule: string }[] }) =>
  result.findings.map((f) => f.rule);

describe("validate", () => {
  it("accepts a well-formed PR", () => {
    const result = validate({ title: TITLE, body: goodBody, config });
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rejects a title that does not match the pattern", () => {
    const result = validate({ title: "fix invoice", body: goodBody, config });
    expect(rules(result)).toEqual(["title-pattern"]);
  });

  it("reports a missing required section", () => {
    const body = goodBody.replace(/## What to Test[\s\S]*?(?=## Issues Addressed)/, "");
    const result = validate({ title: TITLE, body, config });
    expect(rules(result)).toEqual(["section-missing"]);
    const finding = result.findings.find((f) => f.rule === "section-missing");
    expect(finding?.section).toBe("What to Test");
  });

  it("does not report a missing optional section", () => {
    const result = validate({ title: TITLE, body: goodBody, config });
    expect(rules(result)).not.toContain("section-missing");
  });

  it("reports a required section left empty", () => {
    const body = goodBody.replace(
      "Add Invoice always defaulted citizenship to Turkish.",
      "",
    );
    const result = validate({ title: TITLE, body, config });
    expect(rules(result)).toEqual(["section-empty"]);
  });

  it("reports too few items in What to Test", () => {
    const body = goodBody
      .replace("- Passenger without one sees Foreign.\n", "")
      .replace("- Switching invoice type keeps the derived default.\n", "");
    const result = validate({ title: TITLE, body, config });
    expect(rules(result)).toEqual(["section-min-items"]);
    const finding = result.findings.find((f) => f.rule === "section-min-items");
    expect(finding?.section).toBe("What to Test");
  });

  it("counts numbered and plus-marked list items", () => {
    const body = goodBody
      .replace(
        "- Passenger with a national ID sees Turkish.",
        "1. Passenger with a national ID sees Turkish.",
      )
      .replace(
        "- Passenger without one sees Foreign.",
        "2) Passenger without one sees Foreign.",
      )
      .replace(
        "- Switching invoice type keeps the derived default.",
        "+ Switching invoice type keeps the derived default.",
      );
    const result = validate({ title: TITLE, body, config });
    expect(rules(result)).toEqual([]);
  });

  it("reports leftover template placeholders", () => {
    const body = goodBody.replace(
      "| Before | After |",
      "<!-- drag the screenshot here -->",
    );
    const result = validate({ title: TITLE, body, config });
    expect(rules(result)).toEqual(["forbidden-text"]);
  });

  it("reports Issues Addressed without an issue key", () => {
    const body = goodBody.replace(
      "- [ABC-31086](https://jira.example.com/browse/ABC-31086)",
      "- none",
    );
    const result = validate({ title: TITLE, body, config });
    expect(rules(result)).toEqual(["issue-key-missing"]);
    const finding = result.findings.find((f) => f.rule === "issue-key-missing");
    expect(finding?.section).toBe("Issues Addressed");
  });

  it("follows a renamed issues section instead of the old hardcoded name", () => {
    const renamedConfig = {
      ...config,
      jira: { ...config.jira, section: "Related Tickets" },
    };
    const body = goodBody.replace(
      "## Issues Addressed\n\n- [ABC-31086](https://jira.example.com/browse/ABC-31086)",
      "## Related Tickets\n\n- none",
    );
    const result = validate({ title: TITLE, body, config: renamedConfig });
    expect(rules(result)).toContain("issue-key-missing");
    const finding = result.findings.find((f) => f.rule === "issue-key-missing");
    expect(finding?.section).toBe("Related Tickets");
  });

  it("reports both section-empty and issue-key-missing for empty Issues Addressed", () => {
    const body = goodBody.replace(
      "- [ABC-31086](https://jira.example.com/browse/ABC-31086)",
      "",
    );
    const result = validate({ title: TITLE, body, config });
    expect(rules(result)).toContain("section-empty");
    expect(rules(result)).toContain("issue-key-missing");
    const emptyFinding = result.findings.find((f) => f.rule === "section-empty");
    const keyFinding = result.findings.find((f) => f.rule === "issue-key-missing");
    expect(emptyFinding?.section).toBe("Issues Addressed");
    expect(keyFinding?.section).toBe("Issues Addressed");
  });
});

describe("branch-pattern", () => {
  it("accepts a branch matching the configured pattern", () => {
    const result = validate({
      title: TITLE, body: goodBody, config,
      branch: "bugfix/squad/31087-invoice-default-citizenship",
    });
    expect(result.findings.map((f) => f.rule)).not.toContain("branch-pattern");
  });

  it("reports a branch that does not match", () => {
    const result = validate({
      title: TITLE, body: goodBody, config,
      branch: "bugfix/squad/31087-invoice-default-citizenship-3.75",
    });
    expect(result.findings.map((f) => f.rule)).toContain("branch-pattern");
  });

  it("stays silent when no branch is supplied", () => {
    const result = validate({ title: TITLE, body: goodBody, config });
    expect(result.findings.map((f) => f.rule)).not.toContain("branch-pattern");
  });
});

describe("issue-level", () => {
  const story = { key: "ABC-31444", type: "Story", summary: "s" };
  const subtask = {
    key: "ABC-31454", type: "Development", summary: "Geliştirme",
    parent: { key: "ABC-31444", type: "Story", summary: "s" },
  };

  it("accepts a Story cited directly", () => {
    const result = validate({ title: TITLE, body: goodBody, config, issues: [story] });
    expect(result.findings.map((f) => f.rule)).not.toContain("issue-level");
  });

  it("rejects a Development subtask and names its parent", () => {
    const result = validate({ title: TITLE, body: goodBody, config, issues: [subtask] });
    const finding = result.findings.find((f) => f.rule === "issue-level");
    expect(finding).toBeDefined();
    expect(finding?.message).toContain("ABC-31444");
  });

  it("accepts an issue with no parent whatever its type", () => {
    const orphan = { key: "ABC-31789", type: "Story", summary: "removal" };
    const result = validate({ title: TITLE, body: goodBody, config, issues: [orphan] });
    expect(result.findings.map((f) => f.rule)).not.toContain("issue-level");
  });

  it("accepts a Bug cited directly even if it has a parent", () => {
    const bugWithParent = {
      key: "ABC-31086", type: "Bug", summary: "b",
      parent: { key: "ABC-31000", type: "Epic", summary: "e" },
    };
    const result = validate({ title: TITLE, body: goodBody, config, issues: [bugWithParent] });
    expect(result.findings.map((f) => f.rule)).not.toContain("issue-level");
  });
});

describe("a branch the repository has declared ticketless", () => {
  const body = [
    "## Summary",
    "docs only",
    "## Screenshots / Screen Recordings",
    "Nothing to show.",
    "## What to Test",
    "- one",
    "- two",
    "- three",
    "## Issues Addressed",
    "- None — chore, no ticket.",
  ].join("\n\n");

  const exempting = (exempt: string[]) => ({
    ...config,
    jira: { ...config.jira, keyOptionalOnBranches: exempt },
  });

  // Some work genuinely has no ticket. Without this the only ways out are inventing one or
  // turning the rule off for everybody.
  it("is not reported as missing a key", () => {
    const found = validate({
      title: "chore(adr): x",
      body,
      branch: "chore/pr-readiness-adrs",
      config: exempting(["^chore/"]),
    });

    expect(found.findings.map((f) => f.rule)).not.toContain("issue-key-missing");
  });

  // The exemption is about the key, not the section. An unanswered Issues Addressed is
  // still a section nobody answered.
  it("still has to answer the section", () => {
    const found = validate({
      title: "chore(adr): x",
      body: body.replace("- None — chore, no ticket.", ""),
      branch: "chore/pr-readiness-adrs",
      config: exempting(["^chore/"]),
    });

    expect(found.findings.map((f) => f.rule)).toContain("section-empty");
  });

  it("does not exempt a branch the pattern does not name", () => {
    const found = validate({
      title: "fix(x): y",
      body,
      branch: "bugfix/squad/1-thing",
      config: exempting(["^chore/"]),
    });

    expect(found.findings.map((f) => f.rule)).toContain("issue-key-missing");
  });

  // Every config that existed before this key means "exempt nothing".
  it("exempts nothing when the repository has not said", () => {
    const found = validate({
      title: "chore(adr): x",
      body,
      branch: "chore/pr-readiness-adrs",
      config,
    });

    expect(found.findings.map((f) => f.rule)).toContain("issue-key-missing");
  });
});
