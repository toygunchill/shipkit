import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { configSchema } from "../../src/config/schema.js";
import { renderConfig, type InitDraft } from "../../src/infer/render.js";

const draft: InitDraft = {
  titlePattern: { value: "^(feat|fix): .+", provenance: "proposed", why: "conventional commits" },
  branchPattern: { value: "^feature/.+$", provenance: "read", why: "from the ruleset" },
  forbidden: { value: ["TBD", "<!--"], provenance: "observed", why: "in 51 of 78 bodies" },
  blockingLabels: { value: ["in test"], provenance: "read", why: "from the merge gate" },
  sections: {
    value: [
      { name: "Summary", required: true },
      { name: "What to Test", required: true, minItems: 3 },
    ],
    provenance: "observed",
    why: "in most bodies",
  },
  jira: {
    value: { baseUrl: "https://x.example.com/jira", keyPattern: "DCP-\\d+" },
    provenance: "observed",
    why: "from links",
  },
  jiraSection: { value: "Summary", provenance: "observed", why: "the section issue keys are cited in" },
};

describe("renderConfig", () => {
  it("produces YAML the real config loader accepts", () => {
    expect(() => configSchema.parse(parse(renderConfig(draft)))).not.toThrow();
  });

  it("says where every value came from, so a reader knows what to edit", () => {
    const yml = renderConfig(draft);
    expect(yml).toContain("from the ruleset");
    expect(yml).toContain("in 51 of 78 bodies");
    expect(yml).toContain("conventional commits");
  });

  it("round-trips a pattern containing backslashes without mangling it", () => {
    const parsed = configSchema.parse(parse(renderConfig(draft)));
    expect(parsed.jira.keyPattern).toBe("DCP-\\d+");
    expect(new RegExp(parsed.jira.keyPattern).test("ABC-7")).toBe(true);
  });

  it("defaults approval to echo, never opting a team into human silently", () => {
    expect(configSchema.parse(parse(renderConfig(draft))).pr.approval).toBe("echo");
  });

  // The three labels mean different things and a reader acts differently on each,
  // so the file has to say what they imply — but once, in the header. Repeating
  // the explanation above every field is how a file teaches people to skip its
  // comments.
  it("explains each label once in the header, not above every field", () => {
    const yml = renderConfig(draft);
    expect(yml).toContain("a fact, not a guess");
    expect(yml).toContain("not the same as intended");
    expect(yml).toContain("your call");
    expect(yml.split("your call")).toHaveLength(2);
  });

  // A comment attached to the value node rather than the key is still valid YAML,
  // but renders the value on its own line below the key, which reads as damage.
  it("keeps each commented key and its value on one line", () => {
    const lines = renderConfig(draft).split("\n");
    const titleLine = lines.find((line) => line.trim().startsWith("titlePattern:"));
    expect(titleLine?.trim()).toBe('titlePattern: "^(feat|fix): .+"');
  });

  it("carries a section's minItems through, and omits it where there is none", () => {
    const parsed = configSchema.parse(parse(renderConfig(draft)));
    expect(parsed.pr.sections.find((s) => s.name === "What to Test")?.minItems).toBe(3);
    expect(parsed.pr.sections.find((s) => s.name === "Summary")?.minItems).toBeUndefined();
  });

  // The header promises every field says where it came from. Four of them —
  // approval, approvalTimeoutSeconds, linkPolicy, section — used to say nothing.
  it("comments the constants too, or the header's promise is false", () => {
    const lines = renderConfig(draft).split("\n");
    for (const key of ["approval", "approvalTimeoutSeconds", "linkPolicy", "section"]) {
      const at = lines.findIndex((line) => line.startsWith(`  ${key}:`));
      expect(at, `${key} is missing`).toBeGreaterThan(0);
      expect(lines[at - 1].trim(), `${key} carries no comment`).toMatch(/^# (read|observed|proposed):/);
    }
  });

  it("takes jira.section from the draft, so it can name a section that exists", () => {
    const parsed = configSchema.parse(
      parse(
        renderConfig({
          ...draft,
          jiraSection: { value: "Ticket", provenance: "observed", why: "the observed section" },
        }),
      ),
    );
    expect(parsed.jira.section).toBe("Ticket");
  });

  it("still loads when nothing could be learned about Jira", () => {
    const blind: InitDraft = { ...draft, jira: { value: {}, provenance: "proposed", why: "no links found" } };
    const parsed = configSchema.parse(parse(renderConfig(blind)));
    expect(() => new RegExp(parsed.jira.keyPattern)).not.toThrow();
    expect(parsed.jira.baseUrl).toMatch(/^https?:\/\//);
  });
});
