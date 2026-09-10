import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { validate } from "../src/validate/rules.js";

// Guards the acceptance bar from the final review: the three worked examples in
// docs/examples/example-app-pr-bodies.md must keep passing `check` against the shared
// fixture config, using each example's own basis title. No --branch is passed — these
// examples don't carry one, and branch-pattern is a separate, opt-in concern.
const DOC = readFileSync("docs/examples/example-app-pr-bodies.md", "utf8");
const config = loadConfig("tests/fixtures/valid.shipkit.yml");

type Example = { title: string; body: string };

function parseExamples(doc: string): Example[] {
  const examples: Example[] = [];
  const sections = doc.split(/\n# Example \d+ — /).slice(1);
  for (const section of sections) {
    const basisMatch = /\*Basis:\s*`([^`]+)`/s.exec(section);
    if (basisMatch === null) throw new Error("Example section is missing its *Basis:* line");
    const title = basisMatch[1].replace(/\s+/g, " ").trim();

    const bodyStart = section.indexOf("## Summary");
    if (bodyStart === -1) throw new Error("Example section is missing a ## Summary heading");
    const body = section.slice(bodyStart).replace(/\n---\n(\n# Example[\s\S]*)?$/, "").trim();
    examples.push({ title, body });
  }
  return examples;
}

const examples = parseExamples(DOC);

describe("docs/examples/example-app-pr-bodies.md", () => {
  it("has exactly three worked examples", () => {
    expect(examples).toHaveLength(3);
  });

  it.each(examples.map((example, index) => [index + 1, example] as const))(
    "Example %i passes check with its own basis title",
    (_index, example) => {
      const result = validate({ title: example.title, body: example.body, config });
      expect(result.findings).toEqual([]);
      expect(result.ok).toBe(true);
    },
  );
});
