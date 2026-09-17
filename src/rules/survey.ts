/**
 * What shipkit can see of a repository without asking anyone anything.
 *
 * A survey is the only input the rule catalogue gets. It is deliberately small: the paths
 * git tracks, and the text of the source files among them. Everything a candidate rule
 * decides, it decides from these — so a proposal can always name the evidence behind it,
 * and so the whole catalogue is testable without a filesystem.
 */

/** One scanned source file. `text` is the whole file; nothing here works on fragments. */
export type SurveyFile = {
  path: string;
  text: string;
};

export type Survey = {
  /** Every path git tracks, root-relative, sorted. */
  paths: readonly string[];
  /** The source files whose text was read. A subset of `paths` — see `capped`. */
  files: readonly SurveyFile[];
  /**
   * True when the scan stopped short of every source file it could have read.
   *
   * Carried into the written file's provenance rather than hidden, because "187 files use
   * async/await" and "187 of the first 2,000 files read use async/await" are different
   * claims, and only one of them is true on a large repository.
   */
  capped: boolean;
};

/** Extensions worth reading the text of. Everything else is counted by path alone. */
const SOURCE_EXTENSIONS = [
  ".swift", ".m", ".mm", ".h",
  ".kt", ".java",
  ".ts", ".tsx", ".js", ".jsx", ".vue",
  ".py", ".rb", ".go", ".rs", ".cs", ".php", ".dart", ".scala",
];

/**
 * How much of a repository is read.
 *
 * A survey exists to answer "does this repository do X at all", and that question is
 * answered by the first few hundred files that do. Reading a monorepo whole to raise a
 * count nobody acts on costs seconds for nothing, so the scan stops and says it stopped.
 */
export const MAX_FILES = 2_000;
export const MAX_BYTES = 32 * 1024 * 1024;

export function isSource(path: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/**
 * Configuration files read whatever the cap says.
 *
 * A rule is left out when a configured tool already covers it, and deciding that means
 * reading the tool's configuration — SwiftLint's `todo` rule is on unless a file switches it
 * off. These are a handful of small files, and letting the source-file cap decide whether
 * they were read would make the same repository propose different rulesets on different runs.
 */
const CONFIG_BASENAMES = [
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

export function isConfiguration(path: string): boolean {
  return CONFIG_BASENAMES.includes(path.slice(path.lastIndexOf("/") + 1));
}

export type SurveyDeps = {
  /** Root-relative paths git tracks. */
  trackedPaths: () => string[];
  /** One file's text, or `undefined` when it cannot be read. */
  read: (path: string) => string | undefined;
};

export function surveyRepository(deps: SurveyDeps): Survey {
  const paths = [...deps.trackedPaths()].sort();
  const files: SurveyFile[] = [];
  let bytes = 0;
  let capped = false;
  for (const path of paths) {
    const configuration = isConfiguration(path);
    if (!isSource(path) && !configuration) continue;
    if (!configuration && (files.length >= MAX_FILES || bytes >= MAX_BYTES)) {
      capped = true;
      // Not a `break`: the configuration files further down the sorted list still have to be
      // read, or which rules a linter covers would depend on where the cap happened to fall.
      continue;
    }
    const text = deps.read(path);
    // An unreadable tracked file is ordinary — a git-lfs pointer whose filter is not
    // installed, a symlink into a directory that is not checked out. It is skipped, not
    // fatal: this command proposes a draft, and one missing file cannot make it wrong.
    if (text === undefined) continue;
    bytes += text.length;
    files.push({ path, text });
  }
  return { paths, files, capped };
}

/** How many scanned files match, and one of them, for the provenance line. */
export function matching(survey: Survey, pattern: RegExp): { count: number; example?: string } {
  let count = 0;
  let example: string | undefined;
  for (const file of survey.files) {
    // `RegExp.test` on a global regex advances `lastIndex` between calls, which silently
    // makes every other file a non-match. Reset rather than requiring callers to remember.
    pattern.lastIndex = 0;
    if (!pattern.test(file.text)) continue;
    count += 1;
    example ??= file.path;
  }
  return example === undefined ? { count } : { count, example };
}

/** The tracked paths matching a predicate, so a rule can cite the files it saw. */
export function pathsWhere(survey: Survey, predicate: (path: string) => boolean): string[] {
  return survey.paths.filter(predicate);
}
