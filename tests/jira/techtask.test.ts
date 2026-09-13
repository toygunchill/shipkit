import { describe, expect, it } from "vitest";
import { buildCreatePayload } from "../../src/jira/techtask.js";

const config = {
  project: "DCP", issueType: "Story", epic: "ABC-12154",
  summaryPattern: "iOS - {subject} swift ui dönüşümü",
  fields: { customfield_10101: { value: "Commercial" } },
};

const input = { config, subject: "Seyahat özeti", team: "Squad B", sprintId: 1234, portfolioChild: "Portfolio B" };

describe("buildCreatePayload", () => {
  it("writes the summary the team's own tickets use", () => {
    expect((buildCreatePayload(input) as any).fields.summary).toBe("iOS - Seyahat özeti swift ui dönüşümü");
  });

  // Measured: customfield_10101 is a cascading select. A bare {value} is rejected.
  it("nests the portfolio child under its parent", () => {
    expect((buildCreatePayload(input) as any).fields.customfield_10101).toEqual({
      value: "Commercial",
      child: { value: "Portfolio B" },
    });
  });

  it("sets the team and the epic and the sprint", () => {
    const f = (buildCreatePayload(input) as any).fields;
    expect(f.customfield_10102).toEqual({ value: "Squad B" });
    expect(f.customfield_10006).toBe("ABC-12154");
    expect(f.customfield_10005).toBe(1234);
  });

  // Measured: description empty, labels absent on every one of these.
  it("sends no description and no labels", () => {
    const f = (buildCreatePayload(input) as any).fields;
    expect(f.description).toBeUndefined();
    expect(f.labels).toBeUndefined();
  });

  it("omits the sprint rather than sending a null when there is none", () => {
    const f = (buildCreatePayload({ ...input, sprintId: undefined }) as any).fields;
    expect("customfield_10005" in f).toBe(false);
  });
});
