import { describe, expect, it } from "vitest";
import { anyMatch, globToRegExp, matchesGlob } from "../../src/readiness/glob.js";

describe("matchesGlob", () => {
  it("crosses directories with ** and stays inside a segment with *", () => {
    expect(matchesGlob("**/*.swift", "A.swift")).toBe(true);
    expect(matchesGlob("**/*.swift", "Sub/Deep/B.swift")).toBe(true);
    // A single star is not a second `**`: it must not swallow the separator, or every
    // `Sub/*.swift` rule in the file would silently become repository-wide.
    expect(matchesGlob("*.swift", "Sub/B.swift")).toBe(false);
  });

  it("anchors a prefixed ** at that prefix, so a sibling directory does not match", () => {
    // The exact pair from docs/examples/example.readiness.yml: `tests-mean-something`
    // is scoped to `Sources/**` and there is a `AppTests/` next to it. Matching by
    // prefix rather than by segment would make the two indistinguishable.
    expect(matchesGlob("Sources/**/*.swift", "Sources/Scenes/Payment/View.swift")).toBe(true);
    expect(matchesGlob("Sources/**/*.swift", "AppTests/X.swift")).toBe(false);
  });

  it("matches zero directories for a **/ in the middle", () => {
    // `a/**/b` has to hold for `a/b`. Without this a rule scoped to `Sources/**/*.swift`
    // would skip every file sitting directly in `Sources/`.
    expect(matchesGlob("Sources/**/*.swift", "Sources/App.swift")).toBe(true);
  });

  it("reaches inside an asset catalog", () => {
    expect(
      matchesGlob("**/*.xcassets/**", "Sources/Resources/Assets.xcassets/Logo.imageset/Contents.json"),
    ).toBe(true);
    expect(matchesGlob("**/*.xcassets/**", "Sources/Resources/Logo.png")).toBe(false);
  });

  it("treats a dot as a dot and not as a wildcard", () => {
    // The bug this project has already been bitten by once, in an inferred Jira key
    // pattern: an unescaped `.` matches any character, so a rule about `.swift` quietly
    // claims `Xswift` too — see tests/infer/jira.test.ts. Compiling is not the claim;
    // discriminating is.
    expect(matchesGlob("**/*.swift", "AXswift")).toBe(false);
    expect(matchesGlob("Podfile.lock", "PodfileXlock")).toBe(false);
    expect(matchesGlob("Podfile.lock", "Podfile.lock")).toBe(true);
  });

  it("matches a path with a space in it", () => {
    expect(matchesGlob("**/*.swift", "Sources/My Scene/Boarding Pass.swift")).toBe(true);
    expect(matchesGlob("Sources/My Scene/*.swift", "Sources/My Scene/Boarding Pass.swift")).toBe(true);
  });

  it("escapes the other regex metacharacters a filename can legally contain", () => {
    // `(`, `)`, `+` and `$` are all legal in a path and all mean something in a regular
    // expression. Unescaped, `Info (copy).plist` compiles to a group and matches
    // `Info copy.plist`, which is a different file.
    expect(matchesGlob("Info (copy).plist", "Info (copy).plist")).toBe(true);
    expect(matchesGlob("Info (copy).plist", "Info copy.plist")).toBe(false);
    expect(matchesGlob("a+b.txt", "a+b.txt")).toBe(true);
    expect(matchesGlob("a+b.txt", "aab.txt")).toBe(false);
  });

  it("matches a whole path, never a fragment of one", () => {
    expect(matchesGlob("*.swift", "A.swift.bak")).toBe(false);
    expect(matchesGlob("Sources", "Sources/App.swift")).toBe(false);
  });

  it("compiles to an anchored expression", () => {
    expect(globToRegExp("**/*.swift").source).toMatch(/^\^/);
    expect(globToRegExp("**/*.swift").source).toMatch(/\$$/);
  });
});

describe("anyMatch", () => {
  it("is true when any pattern matches any path, and false on an empty change", () => {
    const patterns = ["**/*.swift", "**/*.xcassets/**"];
    expect(anyMatch(patterns, ["README.md", "Sub/B.swift"])).toBe(true);
    expect(anyMatch(patterns, ["README.md", "Podfile"])).toBe(false);
    expect(anyMatch(patterns, [])).toBe(false);
  });
});
