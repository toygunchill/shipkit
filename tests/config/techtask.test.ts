import { describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema.js";

const base = {
  pr: { titlePattern: "^.+$", sections: [{ name: "Summary", required: true }] },
  branch: { pattern: "^.+$" },
  jira: { baseUrl: "https://x.example.com", keyPattern: "A-\\d+" },
};

describe("techTask config", () => {
  it("is optional, so every existing config keeps loading", () => {
    expect(() => configSchema.parse(base)).not.toThrow();
    expect(configSchema.parse(base).techTask).toBeUndefined();
  });

  it("accepts the measured shape, cascading field and all", () => {
    const parsed = configSchema.parse({
      ...base,
      techTask: {
        project: "DCP", issueType: "Story", epic: "ABC-12154",
        summaryPattern: "iOS - {subject} swift ui dönüşümü",
        fields: { customfield_10101: { value: "Commercial" } },
      },
    });
    expect(parsed.techTask?.epic).toBe("ABC-12154");
  });

  // A pattern with no placeholder yields the same summary for every ticket,
  // which is how a backlog fills with indistinguishable rows.
  it("refuses a summary pattern that cannot carry a subject", () => {
    expect(() =>
      configSchema.parse({ ...base, techTask: { project: "D", issueType: "Story", summaryPattern: "iOS - conversion" } }),
    ).toThrow();
  });
});
