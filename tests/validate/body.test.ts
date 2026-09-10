import { describe, expect, it } from "vitest";
import { parseBody } from "../../src/validate/body.js";

describe("parseBody", () => {
  it("splits on level-two headings and preserves order", () => {
    const parsed = parseBody("## Summary\n\nfirst\n\n---\n\n## What to Test\n\n- a\n");
    expect(parsed.order).toEqual(["Summary", "What to Test"]);
    expect(parsed.sections.Summary).toBe("first");
    expect(parsed.sections["What to Test"]).toBe("- a");
  });

  it("drops separator lines but keeps inner dashes", () => {
    const parsed = parseBody("## Summary\n\n---\n\nkept - inline\n");
    expect(parsed.sections.Summary).toBe("kept - inline");
  });

  it("ignores level-three headings", () => {
    const parsed = parseBody("## Summary\n\n### Detail\n\ntext\n");
    expect(parsed.order).toEqual(["Summary"]);
    expect(parsed.sections.Summary).toContain("### Detail");
  });

  it("returns empty content for a heading with nothing under it", () => {
    const parsed = parseBody("## Summary\n\n## What to Test\n\n- a\n");
    expect(parsed.sections.Summary).toBe("");
  });

  it("returns nothing for an empty body", () => {
    expect(parseBody("")).toEqual({ sections: {}, order: [] });
  });
});
