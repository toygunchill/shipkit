import { describe, expect, it } from "vitest";
import { inferJira } from "../../src/infer/jira.js";

describe("inferJira", () => {
  it("reads the base URL and key shape from links in the bodies", () => {
    const got = inferJira([
      "## Issues Addressed\nhttps://jira.example.com/browse/ABC-31086",
      "## Issues Addressed\nhttps://jira.example.com/browse/ABC-31444",
    ]);
    expect(got.value.baseUrl).toBe("https://jira.example.com");
    expect(got.value.keyPattern).toBe("ABC-\\d+");
  });

  it("picks the host that most bodies agree on, not the first seen", () => {
    const got = inferJira([
      "https://stray.example.com/jira/browse/AAA-1",
      "https://jira.example.com/browse/ABC-1",
      "https://jira.example.com/browse/ABC-2",
      "https://jira.example.com/browse/ABC-3",
    ]);
    expect(got.value.baseUrl).toBe("https://jira.example.com");
  });

  it("covers every project prefix it saw, not only the commonest", () => {
    const got = inferJira([
      "https://x.example.com/jira/browse/ABC-1",
      "https://x.example.com/jira/browse/ABC-2",
      "https://x.example.com/jira/browse/OPS-9",
    ]);
    expect(new RegExp(got.value.keyPattern as string).test("OPS-9")).toBe(true);
    expect(new RegExp(got.value.keyPattern as string).test("ABC-1")).toBe(true);
  });

  it("produces a pattern that is a valid regular expression", () => {
    const got = inferJira(["https://x.example.com/jira/browse/A.B-1"]);
    expect(() => new RegExp(got.value.keyPattern as string)).not.toThrow();
    // Compiling is the weaker half of the claim, and on its own it proves almost
    // nothing: `A.B-\d+` is valid regex whether or not the dot was escaped, so a
    // missing escape passes that check silently. What an unescaped dot actually
    // does is match any character, quietly accepting keys from projects the team
    // never had. That is the assertion worth making.
    const pattern = new RegExp(`^(?:${got.value.keyPattern as string})$`);
    expect(pattern.test("A.B-1")).toBe(true);
    expect(pattern.test("AXB-1")).toBe(false);
  });

  it("says nothing rather than guessing when no link is present", () => {
    const got = inferJira(["## Summary\nno links here"]);
    expect(got.value.baseUrl).toBeUndefined();
    expect(got.value.keyPattern).toBeUndefined();
  });

  // In a real pull-request body a browse link is almost never bare: it is
  // wrapped in markdown, in angle brackets or backticks, or it ends a sentence.
  // A key that has to run to the next space misses all of those — including the
  // markdown link, which is the commonest citation shape there is.
  const WRAPPED: [string, string][] = [
    ["a markdown link, the commonest form of all", "- [ABC-1](https://x.example.com/jira/browse/ABC-1)"],
    ["an autolink in angle brackets", "<https://x.example.com/jira/browse/ABC-1>"],
    ["a backticked link", "See `https://x.example.com/jira/browse/ABC-1` for detail"],
    ["a sentence that ends in a full stop", "Fixes https://x.example.com/jira/browse/ABC-1."],
    ["a link followed by a comma", "Fixes https://x.example.com/jira/browse/ABC-1, plus a revert"],
    ["a link carrying a query string", "https://x.example.com/jira/browse/ABC-1?focusedId=9"],
    ["a link carrying more path", "https://x.example.com/jira/browse/ABC-1/worklog"],
    ["a shouted scheme", "HTTPS://x.example.com/jira/browse/ABC-1"],
    ["a link inside a parenthesis", "(https://x.example.com/jira/browse/ABC-1)"],
  ];

  it.each(WRAPPED)("sees a browse link written as %s", (_shape, body) => {
    const got = inferJira([body]);
    expect(got.value.baseUrl).toBe("https://x.example.com/jira");
    expect(got.value.keyPattern).toBe("ABC-\\d+");
  });

  it("keeps a project prefix that carries its own hyphen", () => {
    const got = inferJira(["https://x.example.com/jira/browse/MY-PROJ-12"]);
    expect(got.value.keyPattern).toBe("MY-PROJ-\\d+");
  });

  it("counts a host once per body, so one rollup cannot outvote the ordinary pull requests", () => {
    // Twenty pull requests citing the live instance, and one epic rollup listing
    // thirty links to an archived one. Counting links hands the config to the
    // archive; counting bodies — which is what the comment always claimed —
    // gives it to the twenty.
    const ordinary = Array.from(
      { length: 20 },
      (_, i) => `- [ABC-${i + 1}](https://real.example.com/jira/browse/ABC-${i + 1})`,
    );
    const rollup = Array.from(
      { length: 30 },
      (_, i) => `- https://archived.example.com/jira/browse/OLD-${i + 1}`,
    ).join("\n");
    const got = inferJira([...ordinary, rollup]);
    expect(got.value.baseUrl).toBe("https://real.example.com/jira");
    expect(got.why).toContain("20 of 21");
  });

  it("does not let two bare sandbox links beat twenty markdown citations of the real host", () => {
    const bodies = [
      ...Array.from(
        { length: 20 },
        (_, i) => `## Issues Addressed\n- [ABC-${i + 1}](https://real.example.com/jira/browse/ABC-${i + 1})`,
      ),
      "https://sandbox.atlassian.net/browse/TEST-1",
      "https://sandbox.atlassian.net/browse/TEST-2",
    ];
    const got = inferJira(bodies);
    expect(got.value.baseUrl).toBe("https://real.example.com/jira");
    expect(got.value.keyPattern).toBe("ABC-\\d+");
  });

  it("does not split one host's vote over the case of its scheme", () => {
    // Scheme and host are case-insensitive; the path is not. Two spellings of
    // one instance must not compete with each other for the config.
    const got = inferJira([
      "HTTPS://X.example.com/jira/browse/ABC-1",
      "https://x.example.com/jira/browse/ABC-2",
    ]);
    expect(got.value.baseUrl).toBe("https://x.example.com/jira");
    expect(got.why).toContain("2 of 2");
  });
});
