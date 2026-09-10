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

  it("throws when sections is empty", () => {
    expect(() => loadConfig("tests/fixtures/invalid.shipkit.yml")).toThrow(ConfigError);
  });

  it("throws when a required key is absent", () => {
    expect(() => loadConfig("tests/fixtures/missing-key.shipkit.yml")).toThrow(ConfigError);
  });

  it("throws when the YAML cannot be parsed", () => {
    expect(() => loadConfig("tests/fixtures/malformed.shipkit.yml")).toThrow(ConfigError);
  });

  it("throws a ConfigError when titlePattern is not a valid regex", () => {
    expect(() => loadConfig("tests/fixtures/invalid-regex.shipkit.yml")).toThrow(ConfigError);
  });

  it("defaults jira.section to Issues Addressed", () => {
    const config = loadConfig(FIXTURE);
    expect(config.jira.section).toBe("Issues Addressed");
  });
});
