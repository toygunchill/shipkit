import { describe, expect, it } from "vitest";
import { buildCreatePayload } from "../../src/jira/techtask.js";

const config = {
  project: "DCP", issueType: "Story", epic: "ABC-12154",
  summaryPattern: "iOS - {subject} swift ui dönüşümü",
  // Which field is which, in this Jira. No defaults anywhere in the product — see
  // `missingFieldIds`: a custom field id is assigned per instance, so guessing one writes a
  // real value into the wrong field on somebody else's Jira and nobody finds out.
  fieldIds: {
    portfolio: "customfield_10101",
    team: "customfield_10102",
    epic: "customfield_10006",
    sprint: "customfield_10005",
  },
  fields: { customfield_10101: { value: "Commercial" } },
};

const input = { config, subject: "Seyahat özeti", team: "Squad A", sprintId: 1234, portfolioChild: "Payments" };

describe("buildCreatePayload", () => {
  it("writes the summary the team's own tickets use", () => {
    expect((buildCreatePayload(input) as any).fields.summary).toBe("iOS - Seyahat özeti swift ui dönüşümü");
  });

  // Measured: customfield_10101 is a cascading select. A bare {value} is rejected.
  it("nests the portfolio child under its parent", () => {
    expect((buildCreatePayload(input) as any).fields.customfield_10101).toEqual({
      value: "Commercial",
      child: { value: "Payments" },
    });
  });

  it("sets the team and the epic and the sprint", () => {
    const f = (buildCreatePayload(input) as any).fields;
    expect(f.customfield_10102).toEqual({ value: "Squad A" });
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
      expect(f.customfield_10102).toEqual({ value: "Squad A" });
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

describe("a Jira that spells its fields differently", () => {
  // The whole point of taking the ids out of the code: this tool is not one company's.
  const elsewhere = {
    project: "WEB", issueType: "Task", epic: "WEB-1",
    summaryPattern: "chore: {subject}",
    fieldIds: {
      portfolio: "customfield_20001",
      team: "customfield_20002",
      epic: "customfield_20003",
      sprint: "customfield_20004",
    },
    fields: { customfield_20001: { value: "Platform" } },
  };

  it("writes every value into the field that Jira calls it", () => {
    const f = (buildCreatePayload({ ...input, config: elsewhere }) as any).fields;

    expect(f.customfield_20002).toEqual({ value: "Squad A" });
    expect(f.customfield_20003).toBe("WEB-1");
    expect(f.customfield_20004).toBe(1234);
    expect(f.customfield_20001).toEqual({
      value: "Platform",
      child: { value: "Payments" },
    });
  });

  // The ids this build was written against must not leak into somebody else's payload.
  it("writes nothing into the ids it was originally built against", () => {
    const f = (buildCreatePayload({ ...input, config: elsewhere }) as any).fields;

    for (const old of ["customfield_10101", "customfield_10102", "customfield_10006", "customfield_10005"]) {
      expect(old in f, `${old} leaked into a payload for another Jira`).toBe(false);
    }
  });

  // Without a sprint id there is nowhere to put the sprint. Omitted rather than written
  // somewhere plausible — the command has already said the field is not configured.
  it("omits the sprint when this Jira's sprint field is not configured", () => {
    const { sprint: _sprint, ...noSprint } = elsewhere.fieldIds;
    const f = (buildCreatePayload({
      ...input,
      config: { ...elsewhere, fieldIds: noSprint },
    }) as any).fields;

    expect(f.customfield_20004).toBeUndefined();
    expect(f.customfield_10005).toBeUndefined();
  });
});
