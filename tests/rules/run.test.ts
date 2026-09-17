import { describe, expect, it } from "vitest";
import { runRules, type RulesDeps } from "../../src/rules/run.js";
import { surveyRepository, MAX_FILES, type Survey } from "../../src/rules/survey.js";

function harness(files: Record<string, string>, over: Partial<RulesDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const written: { path: string; text: string }[] = [];
  const deps: RulesDeps = {
    survey: (): Survey =>
      surveyRepository({ trackedPaths: () => Object.keys(files), read: (path) => files[path] }),
    exists: () => false,
    write: (path, text) => {
      written.push({ path, text });
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...over,
  };
  return { deps, out, err, written };
}

const IOS = {
  "Sources/Screen.swift": "final class A: UIViewController {}\n",
  "Sources/New.swift": "struct B { var body: some View { Text(\"x\") } }\n",
};

describe("shipkit rules", () => {
  it("prints the file when nobody asked for it to be written", () => {
    const h = harness(IOS);

    const result = runRules({ force: false }, h.deps);

    expect(result.code).toBe(0);
    expect(h.written).toEqual([]);
    expect(h.out.join("\n")).toContain("version: 1");
  });

  it("writes where it was told, and says to read it before anything points at it", () => {
    const h = harness(IOS);

    const result = runRules({ out: "/tmp/derived.yml", force: false }, h.deps);

    expect(result.code).toBe(0);
    expect(h.written.map((file) => file.path)).toEqual(["/tmp/derived.yml"]);
    expect(h.err.join("\n")).toContain("Read it before anything points at it");
  });

  // The file may be one a team has already edited. `init` refuses the same way and for the
  // same reason: this command writes a draft, and a draft must never eat a decision.
  it("refuses to overwrite a file that is already there", () => {
    const h = harness(IOS, { exists: () => true });

    const result = runRules({ out: "/tmp/derived.yml", force: false }, h.deps);

    expect(result.code).toBe(2);
    expect(h.written).toEqual([]);
    expect(result.message).toContain("--force");
  });

  it("overwrites when told to in so many words", () => {
    const h = harness(IOS, { exists: () => true });

    expect(runRules({ out: "/tmp/derived.yml", force: true }, h.deps).code).toBe(0);
    expect(h.written).toHaveLength(1);
  });

  // An empty ruleset would not load — the schema requires at least one rule — so writing one
  // would hand a person a file that fails the moment they point at it.
  it("writes nothing and says so when it has nothing to propose", () => {
    const h = harness({ "README.md": "# hello" });

    const result = runRules({ out: "/tmp/derived.yml", force: true }, h.deps);

    expect(result.code).toBe(2);
    expect(h.written).toEqual([]);
    expect(result.message).toContain("nothing to propose");
  });
});

describe("the survey", () => {
  // "187 files use async/await" and "187 of the first 2,000 files read use async/await" are
  // different claims, and only one of them is true on a large repository.
  it("says so in the file when it stopped short of the whole repository", () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_FILES + 50 }, (_unused, i) => [
        `Sources/A${i}.swift`,
        "final class A: UIViewController {}\nstruct B { var body: some View { Text(\"x\") } }\n",
      ]),
    );
    const h = harness(many);

    runRules({ force: false }, h.deps);

    expect(h.out.join("\n")).toContain("the scan stopped there");
  });

  it("says nothing of the sort when it read everything", () => {
    const h = harness(IOS);

    runRules({ force: false }, h.deps);

    expect(h.out.join("\n")).not.toContain("the scan stopped there");
  });

  // Which rules a linter covers must not depend on where the source-file cap happened to
  // fall, or the same repository proposes different rulesets on different runs.
  it("reads a linter's configuration even past the cap", () => {
    const many: Record<string, string> = Object.fromEntries(
      Array.from({ length: MAX_FILES + 50 }, (_unused, i) => [`Sources/A${i}.swift`, "// TODO: later\n"]),
    );
    // Sorted last, so a `break` at the cap would never reach it.
    many["zz/.swiftlint.yml"] = "opt_in_rules:\n  - empty_count\n";
    const survey = surveyRepository({
      trackedPaths: () => Object.keys(many),
      read: (path) => many[path],
    });

    expect(survey.files.some((file) => file.path === "zz/.swiftlint.yml")).toBe(true);
    expect(survey.capped).toBe(true);
  });
});
