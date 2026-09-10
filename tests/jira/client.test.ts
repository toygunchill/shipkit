import { describe, expect, it } from "vitest";
import { fetchIssue, JiraError } from "../../src/jira/client.js";

const BASE = "https://jira.example.com";

const payload = (over: Record<string, unknown> = {}) => ({
  key: "ABC-31454",
  fields: {
    summary: "Geliştirme",
    issuetype: { name: "Development" },
    parent: {
      key: "ABC-31444",
      fields: { summary: "Brand Identity fields", issuetype: { name: "Story" } },
    },
    ...over,
  },
});

describe("fetchIssue", () => {
  it("maps the issue and its parent", async () => {
    const issue = await fetchIssue(BASE, "ABC-31454", "tok", async () => payload());
    expect(issue).toEqual({
      key: "ABC-31454",
      type: "Development",
      summary: "Geliştirme",
      parent: { key: "ABC-31444", type: "Story", summary: "Brand Identity fields" },
    });
  });

  it("omits parent when the issue has none", async () => {
    const issue = await fetchIssue(BASE, "ABC-31789", "tok", async () =>
      payload({ parent: undefined }),
    );
    expect(issue.parent).toBeUndefined();
  });

  it("sends the token as a bearer header", async () => {
    let seen = "";
    await fetchIssue(BASE, "ABC-1", "secret", async (_url, token) => {
      seen = token;
      return payload();
    });
    expect(seen).toBe("secret");
  });

  it("throws JiraError when the payload is not an issue", async () => {
    await expect(fetchIssue(BASE, "ABC-1", "tok", async () => ({ errorMessages: ["nope"] })))
      .rejects.toThrow(JiraError);
  });

  it("never puts the token in the error message", async () => {
    const failing = async () => { throw new Error("boom"); };
    await expect(fetchIssue(BASE, "ABC-1", "s3cr3t", failing)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("s3cr3t") }) as Error,
    );
  });

  it("redacts token from wrapped error messages", async () => {
    const token = "super_secret_token_12345";
    const failing = async () => {
      throw new Error(`request failed: Authorization: Bearer ${token}`);
    };
    await expect(fetchIssue(BASE, "ABC-99", token, failing)).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining(token),
      }) as Error,
    );
    // Verify the key is still mentioned for debugging
    await expect(fetchIssue(BASE, "ABC-99", token, failing)).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringContaining("ABC-99"),
      }) as Error,
    );
  });
});
