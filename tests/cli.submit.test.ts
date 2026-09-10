import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CONFIG = "tests/fixtures/valid.shipkit.yml";

function responseFile(over: Record<string, unknown> = {}): string {
  const body = {
    title: "[ABC-1] fix(x): y",
    commitMessage: "fix(x): y",
    sections: {
      Summary: "It was broken; now it is not.",
      "Screenshots / Screen Recordings": "Nothing to show — logic only.",
      "What to Test": "- one\n- two\n- three",
      "Issues Addressed": "- [ABC-1](https://jira.example.com/browse/ABC-1)",
    },
    ...over,
  };
  const path = join(mkdtempSync(join(tmpdir(), "shipkit-sub-")), "r.json");
  writeFileSync(path, JSON.stringify(body), "utf8");
  return path;
}

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", ["dist/cli.js", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const f = error as { status: number; stdout: string; stderr: string };
    return { status: f.status, stdout: f.stdout, stderr: f.stderr };
  }
}

describe("shipkit submit", () => {
  it("exits 2 for an option-shaped base without running anything", () => {
    const r = run(["submit", "--input", responseFile(), "--base", "--output=/tmp/x", "--config", CONFIG]);
    expect(r.status).toBe(2);
  });

  it("exits 2 when the response file is missing", () => {
    const r = run(["submit", "--input", "tests/fixtures/nope.json", "--base", "develop", "--config", CONFIG]);
    expect(r.status).toBe(2);
  });

  it("exits 1 and names the rule when the answer does not comply", () => {
    const bad = responseFile({ title: "nope" });
    const r = run(["submit", "--input", bad, "--base", "develop", "--config", CONFIG]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("title-pattern");
  });

  it("does not push when validation fails", () => {
    const bad = responseFile({ title: "nope" });
    const r = run(["submit", "--input", bad, "--base", "develop", "--config", CONFIG]);
    expect(r.stderr).not.toContain("https://");
  });
});
