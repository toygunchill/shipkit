import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("cli", () => {
  it("prints its version", () => {
    const out = execFileSync("node", ["dist/cli.js", "--version"], {
      encoding: "utf8",
    });
    expect(out.trim()).toBe("0.1.0");
  });
});
