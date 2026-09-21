import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("cli", () => {
  // Against package.json, not against a literal. This test held `"0.1.0"` through three
  // releases — the same literal the CLI held — so the two agreed with each other and with
  // nothing else. A `--version` that cannot drift from the package is the property worth
  // asserting; the number itself is not.
  it("prints the version the package declares", () => {
    const declared = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string })
      .version;
    const out = execFileSync("node", ["dist/cli.js", "--version"], { encoding: "utf8" });

    expect(out.trim()).toBe(declared);
  });
});
