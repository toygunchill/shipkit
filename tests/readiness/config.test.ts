import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";

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
