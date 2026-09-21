import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { discoverConfig, isConfigFile, resolveConfigPath } from "../../src/config/discover.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "shipkit-discover-"));
  dirs.push(root);
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text, "utf8");
  }
  return root;
}

const CONFIG = `
pr:
  titlePattern: '^(feat|fix): .+'
  sections:
    - name: Summary
      required: true
branch:
  pattern: '^feature/.+'
jira:
  baseUrl: https://jira.example.com
  keyPattern: 'ABC-\\d+'
`;

describe("finding a repository's conventions", () => {
  // The whole point: a team's conventions are not the tool's, and the file should carry
  // the team's name for it.
  it("recognises a config by its shape, whatever it is called", () => {
    const root = repo({ "docs/adr/pull-request-conventions.yml": CONFIG });

    const found = discoverConfig(root);

    expect(found.found).toBe("one");
    expect(found.found === "one" && found.path).toContain("pull-request-conventions.yml");
  });

  it("still finds the conventional name first, where a repository uses it", () => {
    const root = repo({ ".shipkit.yml": CONFIG, "docs/other.yml": CONFIG });

    const found = discoverConfig(root);

    expect(found.found === "one" && found.path.endsWith(".shipkit.yml")).toBe(true);
  });

  // Two answers to "what are this repository's conventions" is not something to settle by
  // which filename sorts first.
  it("refuses to choose when two files both read as a config", () => {
    const root = repo({ "a-conventions.yml": CONFIG, "docs/b-conventions.yml": CONFIG });

    const found = discoverConfig(root);

    expect(found.found).toBe("several");
    expect(found.found === "several" && found.paths).toHaveLength(2);
  });

  it("says nothing was found, and where it looked", () => {
    const found = discoverConfig(repo({ "README.md": "# hi" }));

    expect(found.found).toBe("none");
    expect(found.found === "none" && found.looked.length).toBeGreaterThan(3);
  });

  // A YAML file that is not a config must not become one. This repository has eight of
  // them — workflows, a linter config — and none is a set of pull-request conventions.
  it("does not mistake another tool's YAML for a config", () => {
    const root = repo({
      ".swiftlint.yml": "disabled_rules:\n  - todo\n",
      ".github/workflows/ci.yml": "name: CI\non: [push]\njobs:\n  build:\n    runs-on: macos-15\n",
    });

    expect(discoverConfig(root).found).toBe("none");
  });

  it("does not search the whole repository, only the places a config is kept", () => {
    const root = repo({ "Sources/Deep/Nested/conventions.yml": CONFIG });

    // Not found is the correct answer: shipkit reports it rather than walking 6,500 files
    // looking for something nobody pointed it at.
    expect(discoverConfig(root).found).toBe("none");
  });

  it("reads a file that is not YAML as not a config, rather than throwing", () => {
    const root = repo({ "broken.yml": "pr: [unclosed\n" });

    expect(isConfigFile(join(root, "broken.yml"))).toBe(false);
    expect(discoverConfig(root).found).toBe("none");
  });
});

describe("resolving which config to use", () => {
  it("takes --config as given, without looking for anything", () => {
    const resolved = resolveConfigPath("/repo", "team/conventions.yml");

    expect(resolved).toEqual({ path: "/repo/team/conventions.yml" });
  });

  it("leaves an absolute --config alone", () => {
    expect(resolveConfigPath("/repo", "/elsewhere/x.yml")).toEqual({ path: "/elsewhere/x.yml" });
  });

  it("explains rather than guessing when there is none", () => {
    const resolved = resolveConfigPath(repo(), undefined);

    expect("problem" in resolved).toBe(true);
    expect("problem" in resolved && resolved.problem).toContain("shipkit init");
  });

  it("names both files when there are two, and tells you how to choose", () => {
    const root = repo({ "a.yml": CONFIG, "config/b.yml": CONFIG });

    const resolved = resolveConfigPath(root, undefined);

    expect("problem" in resolved && resolved.problem).toContain("--config");
    expect("problem" in resolved && resolved.problem).toContain("a.yml");
  });
});
