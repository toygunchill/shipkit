import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../../src/config/load.js";

function writeConfig(yaml: string): string {
  const tmpDir = mkdtempSync(join("/tmp", "shipkit-test-"));
  const filePath = join(tmpDir, "test.shipkit.yml");
  writeFileSync(filePath, yaml);
  return filePath;
}

describe("pr.approval", () => {
  // Every repository that exists today has no approval key, and none of them may
  // change behaviour because this landed.
  it("defaults to echo when the key is absent", () => {
    expect(loadConfig("tests/fixtures/valid.shipkit.yml").pr.approval).toBe("echo");
  });

  it("accepts human", () => {
    expect(loadConfig("docs/examples/example-app.shipkit.yml").pr.approval).toBe("human");
  });

  it("defaults the wait to 120 seconds", () => {
    expect(loadConfig("tests/fixtures/valid.shipkit.yml").pr.approvalTimeoutSeconds).toBe(120);
  });

  it("refuses a wait that is not a positive whole number of seconds", () => {
    const path = writeConfig(`
pr:
  titlePattern: '^x'
  approvalTimeoutSeconds: 0
  sections:
    - name: Summary
      required: true
branch:
  pattern: '^y'
jira:
  baseUrl: https://example.invalid/jira
  keyPattern: 'ABC-\\d+'
`);
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  it("refuses anything else", () => {
    const path = writeConfig(`
pr:
  titlePattern: '^x'
  approval: sometimes
  sections:
    - name: Summary
      required: true
branch:
  pattern: '^y'
jira:
  baseUrl: https://example.invalid/jira
  keyPattern: 'ABC-\\d+'
`);
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });
});
