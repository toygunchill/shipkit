import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { configSchema } from "../../src/config/schema.js";
import { parse } from "yaml";
import { readFileSync } from "node:fs";

/** A config that already loads, so these tests vary exactly one key. */
const BASE = parse(readFileSync("tests/fixtures/valid.shipkit.yml", "utf8")) as unknown;

describe("the readiness config key", () => {
  it("is absent from the configs that exist today, and they load unchanged", () => {
    // The compatibility claim stated where it can fail loudly: a repository with no
    // `readiness:` key must keep loading, and must not acquire the key by default.
    for (const path of [
      "tests/fixtures/valid.shipkit.yml",
      "tests/fixtures/human-approval.shipkit.yml",
      "tests/fixtures/blocking-labels.shipkit.yml",
    ]) {
      const config = loadConfig(path);
      expect(config.readiness).toBeUndefined();
      expect("readiness" in config).toBe(false);
    }
  });

  it("is read as written when a repository names one", () => {
    expect(loadConfig("docs/examples/example-app.shipkit.yml").readiness).toBe(
      "./example-app.readiness.yml",
    );
  });
});

describe("readiness: naming more than one file", () => {
  it("takes a list, so a team ruleset and a platform ruleset can both apply", () => {
    const config = configSchema.parse({
      ...configSchema.parse(BASE),
      readiness: ["./team.yml", "./platform.yml"],
    });

    expect(config.readiness).toEqual(["./team.yml", "./platform.yml"]);
  });

  it("still takes one path written as a string", () => {
    expect(configSchema.parse({ ...configSchema.parse(BASE), readiness: "./r.yml" }).readiness).toBe("./r.yml");
  });

  it("refuses an empty list rather than reading it as no rules at all", () => {
    expect(() => configSchema.parse({ ...configSchema.parse(BASE), readiness: [] })).toThrow();
  });
});
