/**
 * The smallest glob that `appliesTo` needs, written here rather than taken as a dependency.
 *
 *   `**`   crosses directory separators, including none at all — `Sources/**\/*.swift`
 *          matches `Sources/A.swift` as well as `Sources/Sub/Deep/B.swift`.
 *   `*`    matches within one segment and never crosses a `/`.
 *   anything else is literal.
 *
 * "Literal" is the part that has to be built rather than assumed. Every other character is
 * escaped before it reaches the regular expression, because a pattern is written by a
 * human in a YAML file and `.` is the character they write most: an unescaped `Assets.xcassets`
 * matches `AssetsXxcassets` too, and the rule then applies to changes it was never about.
 * The same class of bug is recorded in tests/infer/jira.test.ts, where an unescaped dot in
 * an inferred key pattern quietly accepted keys from projects the team never had.
 *
 * Paths are compared as git spells them: forward slashes, repository-root-relative.
 */

const METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

function literal(text: string): string {
  return text.replace(METACHARACTERS, "\\$&");
}

/**
 * The pattern as an anchored regular expression.
 *
 * `**` is only "any number of directories" when it stands as its own segment — `**\/x`,
 * `a/**\/b`, `a/**`. Written against other text (`a**b`) it is not a segment at all, and
 * falls back to "any characters", which is the reading that surprises nobody.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  let i = 0;
  while (i < pattern.length) {
    const character = pattern[i] as string;
    if (character !== "*") {
      source += literal(character);
      i += 1;
      continue;
    }

    if (pattern[i + 1] !== "*") {
      source += "[^/]*";
      i += 1;
      continue;
    }

    let end = i + 2;
    while (pattern[end] === "*") end += 1;
    const ownSegment = i === 0 || pattern[i - 1] === "/";
    if (ownSegment && pattern[end] === "/") {
      // `**/` swallows the slash with the directories, so zero directories still matches:
      // `Sources/**/*.swift` has to hold for a file sitting directly in `Sources/`.
      source += "(?:[^/]*/)*";
      i = end + 1;
      continue;
    }
    source += ".*";
    i = end;
  }
  return new RegExp(`^${source}$`);
}

export function matchesGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}

/** True when any pattern matches any path. The question `appliesTo` actually asks. */
export function anyMatch(patterns: readonly string[], paths: readonly string[]): boolean {
  const expressions = patterns.map(globToRegExp);
  return paths.some((path) => expressions.some((expression) => expression.test(path)));
}
