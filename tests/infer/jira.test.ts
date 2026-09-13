import { describe, expect, it } from "vitest";
import { inferJira } from "../../src/infer/jira.js";

describe("inferJira", () => {
  it("reads the base URL and key shape from links in the bodies", () => {
    const got = inferJira([
      "## Issues Addressed\nhttps://jira.example.com/browse/ABC-31086",
      "## Issues Addressed\nhttps://jira.example.com/browse/ABC-31444",
    ]);
    expect(got.value.baseUrl).toBe("https://jira.example.com");
    expect(got.value.keyPattern).toBe("DCP-\\d+");
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
  });

  it("says nothing rather than guessing when no link is present", () => {
    const got = inferJira(["## Summary\nno links here"]);
    expect(got.value.baseUrl).toBeUndefined();
    expect(got.value.keyPattern).toBeUndefined();
  });
});
