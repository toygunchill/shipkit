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
    expect(rules(result)).toContain("title-pattern");
  });

  it("reports a missing required section", () => {
    const body = goodBody.replace(/## What to Test[\s\S]*?(?=## Issues Addressed)/, "");
    const result = validate({ title: TITLE, body, config });
    expect(rules(result)).toContain("section-missing");
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
    expect(rules(result)).toContain("section-empty");
  });

  it("reports too few items in What to Test", () => {
    const body = goodBody
      .replace("- Passenger without one sees Foreign.\n", "")
      .replace("- Switching invoice type keeps the derived default.\n", "");
    const result = validate({ title: TITLE, body, config });
    expect(rules(result)).toContain("section-min-items");
  });

  it("reports leftover template placeholders", () => {
    const body = goodBody.replace(
      "| Before | After |",
      "<!-- drag the screenshot here -->",
    );
    const result = validate({ title: TITLE, body, config });
    expect(rules(result)).toContain("forbidden-text");
  });

  it("reports Issues Addressed without an issue key", () => {
    const body = goodBody.replace(
      "- [ABC-31086](https://jira.example.com/browse/ABC-31086)",
      "- none",
    );
    const result = validate({ title: TITLE, body, config });
    expect(rules(result)).toContain("issue-key-missing");
  });
});
