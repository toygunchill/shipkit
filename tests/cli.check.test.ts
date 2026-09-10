import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CONFIG = "tests/fixtures/valid.shipkit.yml";
const TITLE = "[ABC-31087] fix(invoice): default citizenship from passenger info";

function bodyFile(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "shipkit-")), "body.md");
  writeFileSync(path, content, "utf8");
  return path;
}

function run(args: string[]): { status: number; output: string } {
  try {
    const output = execFileSync("node", ["dist/cli.js", ...args], { encoding: "utf8" });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    return { status: failure.status, output: `${failure.stdout}${failure.stderr}` };
  }
}

const goodBody = [
  "## Summary",
  "",
  "Add Invoice always defaulted citizenship to Turkish.",
  "",
  "## Screenshots / Screen Recordings",
  "",
  "| Before | After |",
  "",
  "## What to Test",
  "",
  "- one",
  "- two",
  "- three",
  "",
  "## Issues Addressed",
  "",
  "- [ABC-31086](https://jira.example.com/browse/ABC-31086)",
].join("\n");

describe("shipkit check", () => {
  it("exits 0 on a compliant PR", () => {
    const result = run(["check", "--title", TITLE, "--body-file", bodyFile(goodBody), "--config", CONFIG]);
    expect(result.status).toBe(0);
  });

  it("exits 1 and names the rule on a bad title", () => {
    const result = run(["check", "--title", "nope", "--body-file", bodyFile(goodBody), "--config", CONFIG]);
    expect(result.status).toBe(1);
    expect(result.output).toContain("title-pattern");
  });

  it("exits 2 when the config is missing", () => {
    const result = run(["check", "--title", TITLE, "--body-file", bodyFile(goodBody), "--config", "nope.yml"]);
    expect(result.status).toBe(2);
  });
});
