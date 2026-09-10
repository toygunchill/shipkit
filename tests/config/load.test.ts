import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config/load.js";

const FIXTURE = "tests/fixtures/valid.shipkit.yml";

describe("loadConfig", () => {
  it("reads sections in file order", () => {
    const config = loadConfig(FIXTURE);
    expect(config.pr.sections.map((s) => s.name)).toEqual([
      "Summary",
      "Screenshots / Screen Recordings",
      "What to Test",
      "Issues Addressed",
      "Analysis JIRA Issue",
    ]);
  });

  it("keeps per-section settings", () => {
    const config = loadConfig(FIXTURE);
    const whatToTest = config.pr.sections.find((s) => s.name === "What to Test");
    expect(whatToTest?.minItems).toBe(3);
    expect(config.pr.sections.find((s) => s.name === "Analysis JIRA Issue")?.required).toBe(false);
  });

  it("throws when the file is missing", () => {
    expect(() => loadConfig("tests/fixtures/nope.yml")).toThrow(ConfigError);
  });

  it("throws when a required key is absent", () => {
    expect(() => loadConfig("tests/fixtures/invalid.shipkit.yml")).toThrow(ConfigError);
  });
});
