import { describe, expect, it } from "vitest";
import { CATALOGUE } from "../../src/rules/catalogue.js";
import { propose } from "../../src/rules/propose.js";
import { surveyRepository, type Survey } from "../../src/rules/survey.js";
import { applicable } from "../../src/readiness/apply.js";

/**
 * Every test here builds a survey from a literal, never a filesystem. That is the point of
 * the split: the catalogue decides from what the survey says it saw, so what it decides is
 * exactly as testable as a pure function.
 */
function survey(files: Record<string, string>, extraPaths: string[] = []): Survey {
  return surveyRepository({
    trackedPaths: () => [...Object.keys(files), ...extraPaths],
    read: (path) => files[path],
  });
}

const ids = (result: ReturnType<typeof propose>): string[] => result.rules.map((rule) => rule.id);

describe("a rule whose subject is not in the repository", () => {
  // Left out entirely rather than written in disabled. A checklist asking about things a
  // repository does not have is a checklist people learn to skip — this project has paid for
  // that lesson twice, with `issue-unverified` firing on every run and `forbidden` banning
  // "N/A".
  it("is not proposed, and is named as absent", () => {
    const result = propose(survey({ "README.md": "# hello" }));

    expect(result.rules).toEqual([]);
    expect(result.absent).toEqual(CATALOGUE.map((candidate) => candidate.id));
  });
});

describe("what the catalogue can see", () => {
  it("asks about tests only where tests exist", () => {
    expect(ids(propose(survey({ "src/a.ts": "export const a = 1;" })))).not.toContain("tests-mean-something");
    expect(
      ids(propose(survey({ "src/a.ts": "export const a = 1;", "tests/a.test.ts": "it('x', () => {});" }))),
    ).toContain("tests-mean-something");
  });

  it("asks about concurrency only where work already runs off the main thread", () => {
    expect(ids(propose(survey({ "a.swift": "let x = 1" })))).not.toContain("concurrency");
    expect(ids(propose(survey({ "a.swift": "@MainActor final class A {}" })))).toContain("concurrency");
  });

  // Both frameworks have to be present. A repository that is entirely SwiftUI has no split
  // to narrow, and asking it every time is the noise this whole design exists to avoid.
  it("asks about the SwiftUI direction only where both frameworks are in use", () => {
    const uikitOnly = survey({ "a.swift": "final class A: UIViewController {}" });
    const swiftuiOnly = survey({ "a.swift": "struct A: View { var body: some View { Text(\"x\") } }" });
    const both = survey({
      "a.swift": "final class A: UIViewController {}",
      "b.swift": "struct B { var body: some View { Text(\"x\") } }",
    });

    expect(ids(propose(uikitOnly))).not.toContain("swiftui-direction");
    expect(ids(propose(swiftuiOnly))).not.toContain("swiftui-direction");
    expect(ids(propose(both))).toContain("swiftui-direction");
  });

  // Ten is where "a folder two things live in" becomes "a layer". Below it the question has
  // a one-line answer and asking it every time is noise.
  it("asks about a shared layer only once one is big enough to be one", () => {
    const small = Object.fromEntries(
      Array.from({ length: 9 }, (_unused, i) => [`Sources/Common/A${i}.swift`, "let x = 1"]),
    );
    const large = Object.fromEntries(
      Array.from({ length: 10 }, (_unused, i) => [`Sources/Common/A${i}.swift`, "let x = 1"]),
    );

    expect(ids(propose(survey(small)))).not.toContain("shared-component-blast-radius");
    expect(ids(propose(survey(large)))).toContain("shared-component-blast-radius");
  });

  it("counts translation files by path, since they are not source to read", () => {
    const result = propose(survey({ "a.swift": "let x = 1" }, ["Resources/en.lproj/Localizable.strings"]));

    expect(ids(result)).toContain("localization");
    expect(result.rules.find((rule) => rule.id === "localization")?.evidence).toContain("Localizable.strings");
  });

  it("asks about lint warnings only where a linter is configured", () => {
    expect(ids(propose(survey({ "a.swift": "let x = 1" })))).not.toContain("no-new-lint-warnings");
    expect(
      ids(propose(survey({ "a.swift": "let x = 1", ".swiftlint.yml": "opt_in_rules:\n  - empty_count\n" }))),
    ).toContain("no-new-lint-warnings");
  });
});

describe("what a tool already enforces", () => {
  // The measured checklist's governing rule: nothing SwiftLint or Sonar already catches
  // appears in it, because a checklist that repeats the linter teaches people to answer
  // without reading.
  it("is left out, with the tool named so a person can disagree", () => {
    const result = propose(
      survey({ "a.swift": "// TODO: later", ".swiftlint.yml": "opt_in_rules:\n  - empty_count\n" }),
    );

    expect(ids(result)).not.toContain("leftovers");
    expect(result.covered.find((entry) => entry.id === "leftovers")?.by).toContain("SwiftLint");
  });

  it("comes back the moment the tool stops enforcing it", () => {
    const result = propose(
      survey({ "a.swift": "// TODO: later", ".swiftlint.yml": "disabled_rules:\n  - todo\n" }),
    );

    expect(ids(result)).toContain("leftovers");
    expect(result.covered).toEqual([]);
  });

  it("is not claimed covered by a linter the repository does not configure", () => {
    expect(ids(propose(survey({ "a.ts": "// TODO: later" })))).toContain("leftovers");
  });
});

describe("every rule the catalogue can produce", () => {
  // The whole point of `advise` is that a derived rule cannot gate anyone's push before a
  // person has read it. `init` makes the same choice, defaulting approval to `echo`.
  it("carries an id, a question and a reason, and nothing has two ids", () => {
    const seen = new Set<string>();
    for (const candidate of CATALOGUE) {
      expect(candidate.ask.length, `${candidate.id} asks nothing`).toBeGreaterThan(10);
      expect(candidate.why.length, `${candidate.id} says no reason`).toBeGreaterThan(10);
      expect(seen.has(candidate.id), `${candidate.id} is in the catalogue twice`).toBe(false);
      seen.add(candidate.id);
    }
  });
});

const scopeOf = (result: ReturnType<typeof propose>, id: string): string[] | undefined =>
  result.rules.find((rule) => rule.id === id)?.appliesTo;

describe("what a derived rule is about", () => {
  // A rule with no `appliesTo` is asked on every change, including one that touches only a
  // README — and a checklist that asks nine questions about a typo is one people answer
  // without reading. The scope is derived, like everything else here.
  it("is scoped to the languages this repository is actually written in", () => {
    const result = propose(survey({ "a.swift": "@MainActor final class A {}", "b.swift": "let b = 1" }));

    expect(scopeOf(result, "concurrency")).toEqual(["**/*.swift"]);
  });

  it("keeps a genuine second language and drops a stray script", () => {
    const files: Record<string, string> = Object.fromEntries(
      Array.from({ length: 40 }, (_unused, i) => [`a${i}.swift`, "@MainActor final class A {}"]),
    );
    for (let i = 0; i < 10; i += 1) files[`b${i}.kt`] = "suspend fun x() {}";
    // One Python script among fifty files, well under a twentieth.
    files["tools/release.py"] = "import os\n";

    const scope = scopeOf(propose(survey(files)), "concurrency");

    expect(scope).toContain("**/*.swift");
    expect(scope).toContain("**/*.kt");
    expect(scope).not.toContain("**/*.py");
  });

  // The catalogue cannot know this repository calls its shared layer `Sources/Common/`.
  // The detector found it, so the detector says so — and a rule scoped to the directory it
  // was derived from is the whole reason it is worth asking.
  it("scopes the shared-layer rule to the shared layer it found", () => {
    const files = Object.fromEntries(
      Array.from({ length: 12 }, (_unused, i) => [`Sources/Common/A${i}.swift`, "let x = 1"]),
    );

    expect(scopeOf(propose(survey(files)), "shared-component-blast-radius")).toEqual(["Sources/Common/**"]);
  });

  // The scope is only worth deriving if it narrows anything, so this asserts it through the
  // function that actually decides which rules a change is asked.
  it("really does narrow the checklist, read through the loader that applies it", () => {
    const files = Object.fromEntries(
      Array.from({ length: 12 }, (_unused, i) => [`Sources/Common/A${i}.swift`, "@MainActor final class A {}"]),
    );
    const rules = propose(survey(files)).rules.map((rule) => ({
      id: rule.id,
      ask: rule.ask,
      severity: "advise" as const,
      ...(rule.appliesTo === undefined ? {} : { appliesTo: rule.appliesTo }),
    }));

    expect(applicable(rules, ["README.md"]).map((rule) => rule.id)).toEqual([]);
    expect(applicable(rules, ["Sources/Common/A1.swift"]).map((rule) => rule.id)).toContain(
      "shared-component-blast-radius",
    );
  });
});
