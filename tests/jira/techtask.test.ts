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

  it("passes an extra field this module does not own straight through", () => {
    const f = (buildCreatePayload({
      ...input,
      config: { ...config, fields: { ...config.fields, customfield_99999: "kept" } },
    }) as any).fields;
    expect(f.customfield_99999).toBe("kept");
  });

  // The four ids this module owns are stripped out of the config spread rather than merely
  // written after it. Spreading first only wins for a field set *unconditionally*, and
  // three of the four are conditional — so a repository's `fields:` block used to supply
  // exactly the values the command had decided to omit. Reproduced: with
  // `techTask.fields.customfield_10005: 999` and `--sprint none`, the header said the sprint
  // came from the flag and the payload carried sprint 999.
  describe("a repository's fields: block cannot supply an id this module owns", () => {
    const overriding = {
      ...config,
      fields: {
        ...config.fields,
        customfield_10005: 999,
        customfield_10006: "ABC-99999",
        customfield_10102: { value: "Squad D" },
      },
    };

    it("omits the sprint the command decided against, however config spells it", () => {
      const f = (buildCreatePayload({ ...input, config: overriding, sprintId: undefined }) as any).fields;
      expect("customfield_10005" in f).toBe(false);
    });

    it("omits the epic when the config's techTask block has none", () => {
      const { epic: _epic, ...noEpic } = overriding;
      const f = (buildCreatePayload({ ...input, config: { ...noEpic } }) as any).fields;
      expect("customfield_10006" in f).toBe(false);
    });

    it("uses the decided sprint, epic and team rather than the block's copies", () => {
      const f = (buildCreatePayload({ ...input, config: overriding }) as any).fields;
      expect(f.customfield_10005).toBe(1234);
      expect(f.customfield_10006).toBe("ABC-12154");
      expect(f.customfield_10102).toEqual({ value: "Squad B" });
    });
  });

  // `typeof [] === "object"`, so a YAML list under customfield_10101: used to be spread
  // into `{0: …, child: {…}}` — a cascading child with no parent value, which Jira rejects.
  it("refuses to build a portfolio parent out of a YAML list", () => {
    const f = (buildCreatePayload({
      ...input,
      config: { ...config, fields: { customfield_10101: [{ value: "Commercial" }] } },
    }) as any).fields;
    expect("customfield_10101" in f).toBe(false);
  });
});
