import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const CONFIG = "tests/fixtures/valid.shipkit.yml";

function run(args: string[], env: Record<string, string> = {}): {
  status: number; stdout: string; stderr: string;
} {
  try {
    const stdout = execFileSync("node", ["dist/cli.js", ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    return { status: failure.status, stdout: failure.stdout, stderr: failure.stderr };
  }
}

describe("shipkit brief", () => {
  it("exits 2 and lists targets when no base is given and stdin is not a terminal", () => {
    const result = run(["brief", "--config", CONFIG]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--base");
  });
});

describe("shipkit check with branch and issue", () => {
  it("reports branch-pattern for a non-conforming branch", () => {
    const result = run([
      "check", "--title", "[ABC-1] fix(x): y",
      "--body-file", "tests/fixtures/complete-body.md",
      "--config", CONFIG,
      "--branch", "not-a-valid-branch-name",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("branch-pattern");
  });

  it("accepts a conforming branch", () => {
    const result = run([
      "check", "--title", "[ABC-1] fix(x): y",
      "--body-file", "tests/fixtures/complete-body.md",
      "--config", CONFIG,
      "--branch", "bugfix/squadb/1-ok",
    ]);
    expect(result.status).toBe(0);
  });
});
