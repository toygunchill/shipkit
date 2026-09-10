import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { loadResponse, renderBody, ResponseError } from "../../src/submit/response.js";

const config = loadConfig("tests/fixtures/valid.shipkit.yml");

function fileWith(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "shipkit-resp-")), "response.json");
  writeFileSync(path, content, "utf8");
  return path;
}

const valid = {
  title: "[ABC-1] fix(x): y",
  commitMessage: "fix(x): y\n\nBody of the commit.",
  sections: { Summary: "It was broken.", "What to Test": "- a\n- b\n- c" },
};

describe("loadResponse", () => {
  it("reads a well-formed response", () => {
    expect(loadResponse(fileWith(JSON.stringify(valid)))).toEqual(valid);
  });

  it("throws for a missing file", () => {
    expect(() => loadResponse("tests/fixtures/nope.json")).toThrow(ResponseError);
  });

  it("throws for unparseable JSON", () => {
    expect(() => loadResponse(fileWith("{"))).toThrow(ResponseError);
  });

  it("throws when a required field is absent", () => {
    expect(() => loadResponse(fileWith(JSON.stringify({ title: "t" })))).toThrow(ResponseError);
  });

  it("throws when sections is not a map of strings", () => {
    const bad = { ...valid, sections: { Summary: 42 } };
    expect(() => loadResponse(fileWith(JSON.stringify(bad)))).toThrow(ResponseError);
  });
});

describe("renderBody", () => {
  it("emits sections in the config's order, not the response's", () => {
    const body = renderBody({ "What to Test": "- a", Summary: "s" }, config);
    expect(body.indexOf("## Summary")).toBeLessThan(body.indexOf("## What to Test"));
  });

  it("emits an empty section rather than dropping it", () => {
    const body = renderBody({ Summary: "s" }, config);
    expect(body).toContain("## What to Test");
  });

  it("separates sections with a rule", () => {
    expect(renderBody({ Summary: "s" }, config)).toContain("\n---\n");
  });

  it("round-trips through the body parser", async () => {
    const { parseBody } = await import("../../src/validate/body.js");
    const parsed = parseBody(renderBody({ Summary: "s", "What to Test": "- a" }, config));
    expect(parsed.sections.Summary).toBe("s");
    expect(parsed.sections["What to Test"]).toBe("- a");
  });

  it("omits sections not in config even if present in response", () => {
    const body = renderBody({ Summary: "s", "Unknown Section": "x" }, config);
    expect(body).not.toContain("Unknown Section");
  });

  it("throws when a rendered section contains a level-two heading", () => {
    const sections = { Summary: "Some text\n\n## Subsection\n\nMore text" };
    expect(() => renderBody(sections, config)).toThrow(ResponseError);
    expect(() => renderBody(sections, config)).toThrow(/Summary/);
  });

  it("allows level-three headings in section content", async () => {
    const sections = { Summary: "Text\n\n### Subsection\n\nMore text", "What to Test": "- item" };
    const body = renderBody(sections, config);
    expect(body).toContain("### Subsection");
    const { parseBody } = await import("../../src/validate/body.js");
    const parsed = parseBody(body);
    expect(parsed.sections.Summary).toContain("### Subsection");
  });

  it("does not throw for level-two headings in config-absent sections", () => {
    const sections = { Summary: "s", "Unknown Section": "## Heading\n\nText" };
    expect(() => renderBody(sections, config)).not.toThrow();
  });

  it("preserves bare rules in section content through round-trip", async () => {
    const sections = { Summary: "Text\n\n---\n\nMore text" };
    const body = renderBody(sections, config);
    const { parseBody } = await import("../../src/validate/body.js");
    const parsed = parseBody(body);
    expect(parsed.sections.Summary).not.toContain("---");
    expect(parsed.sections.Summary).toBe("Text\n\n\nMore text");
  });
});
