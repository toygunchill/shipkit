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

type RunResult = { status: number; stdout: string; stderr: string };

function run(args: string[]): RunResult {
  try {
    const stdout = execFileSync("node", ["dist/cli.js", ...args], { encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    return { status: failure.status, stdout: failure.stdout, stderr: failure.stderr };
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
  it("exits 0 on a compliant PR and prints exactly 'ok' on stdout", () => {
    const result = run(["check", "--title", TITLE, "--body-file", bodyFile(goodBody), "--config", CONFIG]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ok\n");
    expect(result.stderr).toBe("");
  });

  it("exits 1 and prints the finding as '<rule>: <message>' on stderr", () => {
    const result = run(["check", "--title", "nope", "--body-file", bodyFile(goodBody), "--config", CONFIG]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "title-pattern: Title does not match ^\\[DCP-\\d+\\] (feat|fix|chore|ref|docs)(\\([a-z0-9-]+\\))?: .+\n",
    );
  });

  it("exits 2 when the config is missing", () => {
    const result = run(["check", "--title", TITLE, "--body-file", bodyFile(goodBody), "--config", "nope.yml"]);
    expect(result.status).toBe(2);
  });

  it("exits 2 when the body file does not exist", () => {
    const result = run([
      "check",
      "--title",
      TITLE,
      "--body-file",
      "tests/fixtures/does-not-exist.md",
      "--config",
      CONFIG,
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("does-not-exist.md");
  });

  it("exits 2 on a missing required option instead of commander's default 1", () => {
    const result = run(["check", "--body-file", bodyFile(goodBody), "--config", CONFIG]);
    expect(result.status).toBe(2);
  });
});
