import { matching, pathsWhere, type Survey } from "./survey.js";

/**
 * The candidate rules shipkit knows how to look for, and how it decides each one applies.
 *
 * This catalogue is the honest half of "derive a ruleset from the code". The measured
 * checklist in docs/examples/example.readiness.yml came out of reading one team's code
 * *and its review comments* — that is not a thing a command can do. What a command can do is
 * decide, for each rule here, whether its subject exists in the repository in front of it,
 * and say what it saw.
 *
 * So this selects; it never invents. A rule whose subject is absent is left out entirely
 * rather than written in disabled: a checklist asking about things a repository does not
 * have is a checklist people learn to skip, and this project has paid for that lesson twice
 * already — `issue-unverified` firing on every run, and `forbidden` banning "N/A".
 */

export type Finding = {
  /** What the detector saw, written for the provenance comment above the rule. */
  why: string;
  /**
   * The scope this particular repository's evidence implies, when the detector found it.
   *
   * Takes precedence over the candidate's own `appliesTo`: the shared-layer rule cannot know
   * in advance that this repository calls its shared layer `Sources/Common/`, and a rule
   * scoped to the directory it was derived from is the whole reason it is worth asking.
   */
  scope?: string[];
};

export type Candidate = {
  id: string;
  ask: string;
  /** Carried into the file as the rule's own `why`, for whoever answers it later. */
  why: string;
  /**
   * Which files the rule is about, derived rather than declared where it can be.
   *
   * A rule with no `appliesTo` is asked on every change, including one that touches only a
   * README — and a checklist that asks nine questions about a typo is a checklist people
   * answer without reading. Where the detector already knows the scope it says so: the
   * shared layer names the directory it found, and the rules about source say which
   * languages this repository is actually written in.
   */
  appliesTo?: (survey: Survey) => string[] | undefined;
  /** `undefined` when this repository has no such subject. */
  detect: (survey: Survey) => Finding | undefined;
  /**
   * Why this repository should *not* be asked, even though the subject is there.
   *
   * The measured checklist's governing rule was that nothing SwiftLint or Sonar already
   * catches appears in it: a checklist repeating the linter teaches people to answer
   * without reading. When a configured tool covers a rule, the proposal says which tool and
   * leaves the rule out.
   */
  coveredBy?: (survey: Survey) => string | undefined;
};

const count = (n: number, one: string, many: string = `${one}s`): string =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

const has = (survey: Survey, path: string): boolean => survey.paths.includes(path);

/**
 * Globs for the languages this repository is written in.
 *
 * Every extension holding at least a twentieth of the scanned files. The threshold exists so
 * that one stray `.py` script in a Swift application does not scope a rule to Python as well;
 * it is low enough that a genuine second language is never dropped.
 */
function sourceGlobs(survey: Survey): string[] | undefined {
  const counts = new Map<string, number>();
  for (const file of survey.files) {
    const dot = file.path.lastIndexOf(".");
    if (dot < 0) continue;
    const extension = file.path.slice(dot);
    counts.set(extension, (counts.get(extension) ?? 0) + 1);
  }
  const floor = Math.max(1, survey.files.length / 20);
  const kept = [...counts.entries()]
    .filter(([extension, n]) => n >= floor && extension !== ".yml" && extension !== ".yaml")
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([extension]) => `**/*${extension}`);
  return kept.length === 0 ? undefined : kept;
}

/** Any tracked path whose basename is one of these, wherever it sits. */
const named = (survey: Survey, names: readonly string[]): string[] =>
  pathsWhere(survey, (path) => names.includes(path.slice(path.lastIndexOf("/") + 1)));

const LINTER_CONFIGS = [
  ".swiftlint.yml",
  ".swiftlint.yaml",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.json",
  ".eslintrc.yml",
  "eslint.config.js",
  "eslint.config.mjs",
  ".golangci.yml",
  ".golangci.yaml",
  "detekt.yml",
  "ruff.toml",
  ".rubocop.yml",
  "sonar-project.properties",
];

const TEST_FILE = /(^|\/)(tests?|spec|__tests__)\//i;
const TEST_NAME = /(Tests?|Spec)\.(swift|kt|java|ts|tsx|js|jsx|rb|scala)$|_test\.(go|py|rb)$|^test_.*\.py$|\.(test|spec)\.(ts|tsx|js|jsx)$/;

export const CATALOGUE: readonly Candidate[] = [
  {
    id: "tests-mean-something",
    ask: "Does a test here fail if the behaviour you changed goes wrong? Name one.",
    why: "A test that passes either way is a test nobody can trust to catch the next change.",
    appliesTo: sourceGlobs,
    detect: (survey) => {
      const tests = pathsWhere(survey, (path) => TEST_FILE.test(path) || TEST_NAME.test(path));
      if (tests.length === 0) return undefined;
      return { why: `${count(tests.length, "test file")}, e.g. ${tests[0]}` };
    },
  },
  {
    id: "concurrency",
    ask: "What runs off the main thread here, and what guarantees the shared state it touches is safe?",
    why: "This repository already runs work concurrently, so a change can introduce a race that no test schedules.",
    appliesTo: sourceGlobs,
    detect: (survey) => {
      const found = matching(survey, /@MainActor|\bactor\b|\bawait\b|DispatchQueue|Task\s*\{|goroutine|\bgo func\b|asyncio|Thread\(/);
      if (found.count === 0) return undefined;
      return { why: `concurrent work in ${count(found.count, "file")}, e.g. ${found.example}` };
    },
  },
  {
    id: "design-tokens",
    ask: "Do the colours, spacings and fonts you added come from the shared definitions rather than literals?",
    why: "This repository keeps its visual values in one place; a literal beside them is invisible to every later change.",
    appliesTo: sourceGlobs,
    detect: (survey) => {
      const tokens = named(survey, [
        "Colors.swift", "Color.swift", "Colours.swift", "Spacing.swift", "Theme.swift",
        "Tokens.swift", "Palette.swift", "DesignTokens.swift",
        "tokens.ts", "theme.ts", "colors.ts", "tokens.css", "_variables.scss",
      ]);
      if (tokens.length === 0) return undefined;
      return { why: `defined in ${tokens.slice(0, 3).join(", ")}` };
    },
  },
  {
    id: "swiftui-direction",
    ask: "If you touched a UIKit screen, does this change move it toward SwiftUI or further from it?",
    why: "Both frameworks are in use here, so every change either narrows the split or widens it.",
    appliesTo: () => ["**/*.swift"],
    detect: (survey) => {
      const uikit = matching(survey, /UIViewController|UIView\b|@IBOutlet/);
      const swiftui = matching(survey, /some View|@State\b|@ObservedObject|var body:/);
      if (uikit.count === 0 || swiftui.count === 0) return undefined;
      return { why: `UIKit in ${count(uikit.count, "file")}, SwiftUI in ${count(swiftui.count, "file")}` };
    },
  },
  {
    id: "localization",
    ask: "Is every string a person will read localized, rather than written in the code?",
    why: "This repository localizes its text; a hard-coded string ships untranslated and is found by a user.",
    appliesTo: sourceGlobs,
    detect: (survey) => {
      const files = pathsWhere(
        survey,
        (path) =>
          path.endsWith(".strings") ||
          path.endsWith(".xcstrings") ||
          path.endsWith(".po") ||
          /(^|\/)locales?\//i.test(path) ||
          /(^|\/)i18n\//i.test(path),
      );
      if (files.length === 0) return undefined;
      return { why: `${count(files.length, "translation file")}, e.g. ${files[0]}` };
    },
  },
  {
    id: "accessibility",
    ask: "Can what you added be reached and read without sight or touch precision?",
    why: "This repository already labels its interface for assistive technology; an unlabelled addition is a hole in it.",
    appliesTo: sourceGlobs,
    detect: (survey) => {
      const found = matching(survey, /accessibilityIdentifier|accessibilityLabel|aria-label|contentDescription/);
      if (found.count === 0) return undefined;
      return { why: `accessibility labels already in ${count(found.count, "file")}, e.g. ${found.example}` };
    },
  },
  {
    id: "shared-component-blast-radius",
    ask: "Did you change something shared? If so, what else uses it, and did you look?",
    why: "This repository has a shared layer, and a change inside it reaches screens nobody opened while making it.",
    detect: (survey) => {
      const shared = new Map<string, number>();
      for (const path of survey.paths) {
        const match = /(^|\/)((?:Common|Shared|Core|DesignSystem|UIComponents|components)\/)/.exec(path);
        if (match === null) continue;
        const directory = path.slice(0, match.index + match[0].length);
        shared.set(directory, (shared.get(directory) ?? 0) + 1);
      }
      const biggest = [...shared.entries()].sort((a, b) => b[1] - a[1])[0];
      // Ten is the point at which "a folder two things live in" becomes "a layer": below it
      // the question has a one-line answer and asking it every time is noise.
      if (biggest === undefined || biggest[1] < 10) return undefined;
      return { why: `${biggest[0]} holds ${count(biggest[1], "file")}`, scope: [`${biggest[0]}**`] };
    },
  },
  {
    id: "leftovers",
    ask: "Is there anything left in this change you did not mean to ship — a TODO, a print, commented-out code?",
    why: "Debug output and half-finished notes are invisible in a diff a person is reading for logic.",
    appliesTo: sourceGlobs,
    detect: (survey) => {
      const found = matching(survey, /TODO|FIXME|console\.log\(|debugPrint\(|fmt\.Println\(/);
      if (found.count === 0) return undefined;
      return { why: `already in ${count(found.count, "file")}, e.g. ${found.example}` };
    },
    coveredBy: (survey) => {
      // SwiftLint's `todo` rule is on unless a configuration switches it off, so the file
      // existing is the evidence — what has to be checked is whether it was disabled.
      const swiftlint = survey.paths.find((path) => path.endsWith(".swiftlint.yml") || path.endsWith(".swiftlint.yaml"));
      if (swiftlint !== undefined) {
        // Configuration files are always read, whatever the source cap says — see
        // `isConfiguration` in survey.ts — so an absent text here means genuinely unreadable,
        // and "present and not known to be disabled" is the conservative reading.
        const text = survey.files.find((file) => file.path === swiftlint)?.text ?? "";
        if (!/disabled_rules:[\s\S]*?- *todo\b/.test(text)) {
          return `SwiftLint's todo rule already catches this (${swiftlint})`;
        }
      }
      return undefined;
    },
  },
  {
    id: "no-new-lint-warnings",
    ask: "Does this change add any warning the linter did not report before it?",
    why: "A warning added here is one everyone after you learns to scroll past.",
    appliesTo: sourceGlobs,
    detect: (survey) => {
      const configs = LINTER_CONFIGS.filter((name) => has(survey, name) || named(survey, [name]).length > 0);
      if (configs.length === 0) return undefined;
      return { why: `configured by ${configs.slice(0, 3).join(", ")}` };
    },
  },
];
