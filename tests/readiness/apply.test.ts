import { describe, expect, it } from "vitest";
import { applicable, asks, evaluate, matchedPaths, observedPaths } from "../../src/readiness/apply.js";
import type { ReadinessRule } from "../../src/readiness/types.js";

const SWIFT: ReadinessRule = {
  id: "design-tokens",
  ask: "Do the colours use the right semantic token?",
  why: "25 of 80 root comments",
  appliesTo: ["**/*.swift", "**/*.xcassets/**"],
  severity: "warn",
};
const ALWAYS: ReadinessRule = {
  id: "all-entry-paths",
  ask: "Does the new check hold on every entry path?",
  severity: "warn",
};
const BLOCKING: ReadinessRule = { id: "secrets", ask: "Any credential in the diff?", severity: "block" };
const ADVISORY: ReadinessRule = {
  id: "constants-deliberate",
  ask: "Are the magic values deliberate?",
  severity: "advise",
};
const RULES = [SWIFT, ALWAYS, BLOCKING, ADVISORY];

describe("applicable", () => {
  it("always applies a rule with no appliesTo", () => {
    expect(applicable([ALWAYS], ["README.md"]).map((rule) => rule.id)).toEqual(["all-entry-paths"]);
    expect(applicable([ALWAYS], []).map((rule) => rule.id)).toEqual(["all-entry-paths"]);
  });

  it("applies a scoped rule when any glob matches any changed path", () => {
    expect(applicable([SWIFT], ["docs/README.md", "Sources/View.swift"])).toEqual([SWIFT]);
    expect(applicable([SWIFT], ["Art/Assets.xcassets/Logo.imageset/Contents.json"])).toEqual([SWIFT]);
  });

  it("drops a scoped rule the change never touched", () => {
    // The noise rule: an agent asked about asset catalogues it did not open stops reading
    // the checklist, and then misses the question that mattered.
    expect(applicable(RULES, ["docs/README.md"]).map((rule) => rule.id)).toEqual([
      "all-entry-paths",
      "secrets",
      "constants-deliberate",
    ]);
  });

  it("carries every rule when the paths could not be read at all", () => {
    // `undefined` is not `[]`. A failed scratch-index read must over-ask rather than
    // silently excuse every scoped rule — the same failure mode as a blank diffstat.
    expect(applicable(RULES, undefined)).toEqual(RULES);
    expect(applicable(RULES, []).map((rule) => rule.id)).toEqual([
      "all-entry-paths",
      "secrets",
      "constants-deliberate",
    ]);
  });
});

describe("observedPaths", () => {
  it("answers undefined when the read throws, and the paths when it does not", () => {
    expect(observedPaths(() => ["a.swift"])).toEqual(["a.swift"]);
    expect(
      observedPaths(() => {
        throw new Error("git-lfs filter is required but missing");
      }),
    ).toBeUndefined();
  });
});

describe("asks", () => {
  it("carries the question and its stakes, and never the globs", () => {
    const [item] = asks([SWIFT]);
    expect(item).toEqual({
      id: "design-tokens",
      ask: "Do the colours use the right semantic token?",
      why: "25 of 80 root comments",
      severity: "warn",
    });
    expect(item).not.toHaveProperty("appliesTo");
  });

  it("omits why when the rule states none", () => {
    expect(asks([ALWAYS])[0]).not.toHaveProperty("why");
  });
});

describe("evaluate", () => {
  it("says nothing when every applicable rule passes", () => {
    const result = evaluate(RULES, RULES.map((rule) => ({ id: rule.id, status: "pass" as const })));
    expect(result).toEqual({ findings: [], warnings: [], advice: [] });
  });

  it("refuses when an applicable rule is unanswered, naming the ids", () => {
    const result = evaluate(RULES, [{ id: "secrets", status: "pass" }]);
    const finding = result.findings.find((item) => item.rule === "readiness-unanswered");
    expect(finding?.message).toContain("design-tokens");
    expect(finding?.message).toContain("all-entry-paths");
    expect(finding?.message).toContain("constants-deliberate");
    expect(finding?.message).not.toContain("secrets,");
  });

  it("refuses no answers at all the same way as a partial set", () => {
    expect(evaluate(RULES, undefined).findings.map((item) => item.rule)).toEqual([
      "readiness-unanswered",
    ]);
  });

  it("refuses an id no rule has, so a typo cannot satisfy nothing", () => {
    const result = evaluate(
      [BLOCKING],
      [
        { id: "secrets", status: "pass" },
        { id: "secret", status: "pass" },
      ],
    );
    const finding = result.findings.find((item) => item.rule === "readiness-unknown-rule");
    expect(finding?.message).toContain("secret");
  });

  it("accepts an answer to a configured rule that did not apply here", () => {
    // A diligent agent answering all thirteen must not be punished for the eight the
    // change did not reach; only an id no rule has is a typo.
    const result = evaluate([ALWAYS], [
      { id: "all-entry-paths", status: "pass" },
      { id: "design-tokens", status: "pass" },
    ], RULES);
    expect(result.findings).toEqual([]);
  });

  it("refuses n/a without a note", () => {
    const result = evaluate([ALWAYS], [{ id: "all-entry-paths", status: "n/a" }]);
    expect(result.findings.map((item) => item.rule)).toEqual(["readiness-note-required"]);
  });

  it("refuses n/a whose note is only whitespace", () => {
    // A free escape hatch is no rule at all, and " " is free.
    const result = evaluate([ALWAYS], [{ id: "all-entry-paths", status: "n/a", note: "   " }]);
    expect(result.findings.map((item) => item.rule)).toEqual(["readiness-note-required"]);
  });

  it("accepts n/a with a note", () => {
    const result = evaluate([ALWAYS], [
      { id: "all-entry-paths", status: "n/a", note: "No new control was added; this is a copy change." },
    ]);
    expect(result).toEqual({ findings: [], warnings: [], advice: [] });
  });

  it("refuses two answers for one rule rather than picking one", () => {
    const result = evaluate([ALWAYS], [
      { id: "all-entry-paths", status: "fail", note: "only the button path" },
      { id: "all-entry-paths", status: "pass" },
    ]);
    expect(result.findings.map((item) => item.rule)).toContain("readiness-duplicate-answer");
  });

  it("routes a failing block rule to a finding", () => {
    const result = evaluate([BLOCKING], [
      { id: "secrets", status: "fail", note: "a token is still in the fixture" },
    ]);
    expect(result.findings).toEqual([
      { rule: "readiness-secrets", message: "Any credential in the diff? — a token is still in the fixture" },
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.advice).toEqual([]);
  });

  it("routes a failing warn rule to an ordinary pre-flight warning", () => {
    const result = evaluate([ALWAYS], [
      { id: "all-entry-paths", status: "fail", note: "Apple Pay path not covered" },
    ]);
    expect(result.warnings).toEqual([
      {
        check: "readiness-all-entry-paths",
        message: "Does the new check hold on every entry path? — Apple Pay path not covered",
      },
    ]);
    expect(result.findings).toEqual([]);
  });

  it("routes a failing advise rule to advice, never to a warning", () => {
    // Advice must never reach `shouldRequestApproval`; the type keeps that promise at
    // compile time, and this keeps it here.
    const result = evaluate([ADVISORY], [
      { id: "constants-deliberate", status: "fail", note: "two values still inline" },
    ]);
    expect(result.advice).toEqual([
      { topic: "readiness-constants-deliberate", message: "Are the magic values deliberate? — two values still inline" },
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.findings).toEqual([]);
  });

  it("collapses a folded question onto one line, and says so when a fail carries no note", () => {
    const folded: ReadinessRule = {
      id: "layering",
      ask: "Is business logic piling up\nin the view,\nor split across two owners?\n",
      severity: "warn",
    };
    expect(evaluate([folded], [{ id: "layering", status: "fail" }]).warnings).toEqual([
      {
        check: "readiness-layering",
        message:
          "Is business logic piling up in the view, or split across two owners? — reported as failing, with no note",
      },
    ]);
  });

  it("reports every applicable rule's own failure, in the order the file declares them", () => {
    const result = evaluate(RULES, [
      { id: "design-tokens", status: "fail", note: "one legacy colour left" },
      { id: "all-entry-paths", status: "pass" },
      { id: "secrets", status: "fail", note: "none, actually" },
      { id: "constants-deliberate", status: "fail", note: "deliberate" },
    ]);
    expect(result.findings.map((item) => item.rule)).toEqual(["readiness-secrets"]);
    expect(result.warnings.map((item) => item.check)).toEqual(["readiness-design-tokens"]);
    expect(result.advice.map((item) => item.topic)).toEqual(["readiness-constants-deliberate"]);
  });
});

describe("which paths a rule matched", () => {
  const rules = [
    { id: "swift", ask: "a", severity: "warn" as const, appliesTo: ["**/*.swift"] },
    { id: "everything", ask: "b", severity: "warn" as const },
    { id: "views", ask: "c", severity: "warn" as const, appliesTo: ["**/Views/**"] },
  ];

  // `applicable` answers whether a rule applies and throws the reason away. The review page
  // needs the reason: a question shown beside the file it is about is one a person answers.
  it("names the changed paths each rule's globs actually matched", () => {
    const matched = matchedPaths(rules, ["A.swift", "Views/B.swift", "README.md"]);

    expect(matched.get("swift")).toEqual(["A.swift", "Views/B.swift"]);
    expect(matched.get("views")).toEqual(["Views/B.swift"]);
  });

  // A rule with no `appliesTo` is about the change, not about any file in it, so it gets no
  // paths and the page keeps it above the diff.
  it("gives no paths to a rule that applies to everything", () => {
    expect(matchedPaths(rules, ["A.swift"]).has("everything")).toBe(false);
  });

  // `applicable` carries every rule when the paths could not be read. A rule carried for
  // that reason is not a rule about any particular file, and must not be drawn as one.
  it("gives no paths at all when the changed paths could not be read", () => {
    expect(matchedPaths(rules, undefined).size).toBe(0);
  });

  it("omits a rule whose globs matched nothing", () => {
    expect(matchedPaths(rules, ["README.md"]).size).toBe(0);
  });
});
