import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const CLI = resolve("dist/cli.js");
const BASE_CONFIG = readFileSync(resolve("tests/fixtures/valid.shipkit.yml"), "utf8");

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A config file carrying the base fixture plus the `techTask:` block spelled by the test.
 *
 * Every case below runs `--dry-run` with `--team`, `--portfolio` and `--sprint` all given,
 * which is the one path through `tech-task` that needs neither a Jira token nor a request:
 * nothing is derived and nothing is created, so the command never leaves the process.
 */
function configWith(techTask: string): string {
  const dir = mkdtempSync(join(tmpdir(), "shipkit-techtask-"));
  tempDirs.push(dir);
  const path = join(dir, ".shipkit.yml");
  writeFileSync(path, `${BASE_CONFIG}\n${techTask}`, "utf8");
  return path;
}

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  const cwd = mkdtempSync(join(tmpdir(), "shipkit-techtask-cwd-"));
  tempDirs.push(cwd);
  try {
    const stdout = execFileSync("node", [CLI, ...args], {
      encoding: "utf8",
      cwd,
      // No token reachable, so a run that tried to derive or create would refuse loudly
      // rather than reach Jira. Nothing below takes that path.
      env: { ...process.env, SHIPKIT_JIRA_TOKEN: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    return { status: failure.status, stdout: failure.stdout, stderr: failure.stderr };
  }
}

const DECIDED = ["--team", "Squad B", "--portfolio", "Portfolio B", "--sprint", "none"];

const WELL_FORMED = [
  "techTask:",
  "  project: DCP",
  "  issueType: Story",
  "  epic: ABC-12154",
  '  summaryPattern: "iOS - {subject} swift ui dönüşümü"',
  // Which field is which, in this Jira. There are no defaults: an id is assigned per
  // instance, so guessing one writes a real value into the wrong field somewhere else.
  "  fieldIds:",
  "    portfolio: customfield_10101",
  "    team: customfield_10102",
  "    epic: customfield_10006",
  "    sprint: customfield_10005",
  "  fields:",
  "    customfield_10101:",
  '      value: "Commercial"',
].join("\n");

describe("shipkit tech-task --dry-run", () => {
  it("prints the payload it would send, and creates nothing", () => {
    const config = configWith(WELL_FORMED);

    const result = run(["tech-task", "--subject", "Seyahat özeti", "--config", config, "--dry-run", ...DECIDED]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("this was a --dry-run");
    const payload = JSON.parse(result.stdout.slice(result.stdout.indexOf("{"), result.stdout.lastIndexOf("}") + 1));
    expect(payload.fields.customfield_10101).toEqual({
      value: "Commercial",
      child: { value: "Portfolio B" },
    });
  });

  // Reproduced against the built code: with `customfield_10005: 999` in the block and
  // `--sprint none`, the header said "Sprint: given with --sprint" and the payload carried
  // sprint 999. A silently wrong value in a created ticket is the class this whole design
  // exists to prevent, so the two have to agree.
  it("does not let the fields: block supply the sprint --sprint none refused", () => {
    const config = configWith(`${WELL_FORMED}\n    customfield_10005: 999`);

    const result = run(["tech-task", "--subject", "Seyahat özeti", "--config", config, "--dry-run", ...DECIDED]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Sprint: given with --sprint");
    expect(result.stdout).not.toContain("999");
    const payload = JSON.parse(result.stdout.slice(result.stdout.indexOf("{"), result.stdout.lastIndexOf("}") + 1));
    expect("customfield_10005" in payload.fields).toBe(false);
  });

  // `typeof [] === "object"`, so a YAML list slipped past the refusal and built a child
  // with no parent value. It failed at Jira rather than silently, but the refusal is what
  // names the fix.
  it("refuses a YAML list as the portfolio parent instead of building a parentless child", () => {
    const config = configWith(
      [
        "techTask:",
        "  project: DCP",
        "  issueType: Story",
        '  summaryPattern: "iOS - {subject} swift ui dönüşümü"',
        "  fields:",
        "    customfield_10101:",
        '      - value: "Commercial"',
      ].join("\n"),
    );

    const result = run(["tech-task", "--subject", "Seyahat özeti", "--config", config, "--dry-run", ...DECIDED]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("customfield_10101");
    expect(result.stderr).toContain("Nothing was created.");
    expect(result.stdout).not.toContain("child");
  });
});

describe("a techTask block that does not say which field is which", () => {
  // The refusal that makes this tool honest anywhere but the Jira it was built against.
  it("refuses, naming every id it is missing at once", () => {
    const config = configWith(
      [
        "techTask:",
        "  project: DCP",
        "  issueType: Story",
        "  epic: ABC-12154",
        '  summaryPattern: "iOS - {subject} swift ui dönüşümü"',
        "  fields:",
        "    customfield_10101:",
        '      value: "Commercial"',
      ].join("\n"),
    );

    const result = run(["tech-task", "--subject", "x", "--config", config, "--dry-run", ...DECIDED]);

    expect(result.status).toBe(2);
    // All three in one run, not one per run.
    expect(result.stderr).toContain("portfolio");
    expect(result.stderr).toContain("team");
    expect(result.stderr).toContain("epic");
    expect(result.stderr).toContain("Nothing was created");
  });

  // A team that links no epics never has to find out what their epic field is called.
  it("does not ask for an epic field when the block links no epic", () => {
    const config = configWith(
      [
        "techTask:",
        "  project: WEB",
        "  issueType: Task",
        '  summaryPattern: "chore: {subject}"',
        "  fieldIds:",
        "    portfolio: customfield_20001",
        "    team: customfield_20002",
        "  fields:",
        "    customfield_20001:",
        '      value: "Platform"',
      ].join("\n"),
    );

    const result = run(["tech-task", "--subject", "x", "--config", config, "--dry-run", ...DECIDED]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("customfield_20002");
    expect(result.stdout).not.toContain("customfield_10102");
  });
});
