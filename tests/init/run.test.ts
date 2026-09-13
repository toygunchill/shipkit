import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { configSchema, type ShipkitConfig } from "../../src/config/schema.js";
import { runInit, type InitDeps } from "../../src/init/run.js";

function deps(over: Partial<InitDeps> = {}) {
  const written: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const base: InitDeps = {
    sources: {
      rulesets: () => [],
      mergeGateWorkflow: () => undefined,
      mergedBodies: () => ["## Summary\nreal work\n## Issues Addressed\nhttps://x.example.com/jira/browse/ABC-1"],
    },
    exists: () => false,
    write: (_p, text) => void written.push(text),
    out: (line) => void out.push(line),
    err: (line) => void err.push(line),
    ...over,
  };
  return { deps: base, written, out, err };
}

const OPTIONS = { config: ".shipkit.yml", force: false, limit: 50 };

/** Reads back what was written, through the schema — the shape a loader will see. */
function wroteConfig(sources: Partial<InitDeps["sources"]> = {}): ShipkitConfig {
  const { deps: d, written } = deps({
    sources: {
      rulesets: () => [],
      mergeGateWorkflow: () => undefined,
      mergedBodies: () => [],
      ...sources,
    },
  });
  runInit(OPTIONS, d);
  return configSchema.parse(parse(written[0]));
}

const TEMPLATE = "Briefly describe what this PR does.";

describe("runInit", () => {
  it("writes a config the loader accepts, even with no forge access at all", () => {
    const { deps: d, written } = deps({
      sources: {
        rulesets: () => { throw new Error("no remote"); },
        mergeGateWorkflow: () => { throw new Error("no remote"); },
        mergedBodies: () => { throw new Error("no remote"); },
      },
    });
    const result = runInit(OPTIONS, d);
    expect(result.code).toBe(0);
    expect(result.wrote).toBe(true);
    expect(() => configSchema.parse(parse(written[0]))).not.toThrow();
  });

  it("names what it could not determine, rather than quietly inventing it", () => {
    const { deps: d } = deps({
      sources: {
        rulesets: () => { throw new Error("no remote"); },
        mergeGateWorkflow: () => undefined,
        mergedBodies: () => [],
      },
    });
    expect(runInit(OPTIONS, d).unresolved).toContain("branch.pattern");
  });

  it("refuses to overwrite an existing config", () => {
    const { deps: d, written } = deps({ exists: () => true });
    const result = runInit(OPTIONS, d);
    expect(result.code).toBe(2);
    expect(result.wrote).toBe(false);
    expect(written).toHaveLength(0);
  });

  it("overwrites when told to explicitly", () => {
    const { deps: d, written } = deps({ exists: () => true });
    expect(runInit({ ...OPTIONS, force: true }, d).wrote).toBe(true);
    expect(written).toHaveLength(1);
  });

  it("reports what it actually received when a payload makes no sense", () => {
    const { deps: d, err } = deps({ sources: { rulesets: () => ({ nope: true }), mergeGateWorkflow: () => undefined, mergedBodies: () => [] } });
    runInit(OPTIONS, d);
    expect(err.join("\n")).toMatch(/ruleset/i);
  });

  it("says what the payload actually was, not only that nothing came of it", () => {
    const { deps: d, err } = deps({
      sources: {
        rulesets: () => ({ nope: true }),
        mergeGateWorkflow: () => undefined,
        mergedBodies: () => [],
      },
    });
    runInit(OPTIONS, d);
    expect(err.join("\n")).toContain("nope");
  });

  it("floors What to Test at three items even when the sections were observed", () => {
    // sectionSkeleton observes names and required-ness only, so an observed
    // skeleton carries no minItems at all — and this is the section agents
    // reduce to one vague line. Observing the past faithfully would drop the
    // check that exists to correct it.
    const bodies = ["## Summary\na\n## What to Test\nb", "## Summary\nc\n## What to Test\nd"];
    const config = wroteConfig({ mergedBodies: () => bodies });
    const observed = config.pr.sections.find((s) => s.name === "What to Test");
    expect(observed?.minItems).toBe(3);
    // ...and the note must not claim the forge or the past proved it.
    expect(config.pr.sections.map((s) => s.name)).toEqual(["Summary", "What to Test"]);
  });

  it("drops a heading one body in a large sample carries, and keeps one a quarter carry", () => {
    const bodies = Array.from({ length: 12 }, () => "## Summary\na");
    bodies[0] += "\n## Someone's personal note\nx";
    for (let i = 0; i < 3; i++) bodies[i] += "\n## Analysis JIRA Issue\ny";
    const names = wroteConfig({ mergedBodies: () => bodies }).pr.sections.map((s) => s.name);
    expect(names).not.toContain("Someone's personal note");
    expect(names).toContain("Analysis JIRA Issue");
  });

  it("keeps every heading when the sample is too small for a tenth to mean anything", () => {
    const bodies = ["## Summary\na\n## Analysis JIRA Issue\nx", "## Summary\na", "## Summary\na", "## Summary\na"];
    const names = wroteConfig({ mergedBodies: () => bodies }).pr.sections.map((s) => s.name);
    expect(names).toContain("Analysis JIRA Issue");
  });

  it("judges boilerplate by a share of what it read, not a fixed count", () => {
    // Six bodies. A line four of them share is template text; a line three share
    // is prose that happened to repeat. Two thirds of six is four, so the line in
    // three falls below — where a fixed count of two or three would have let it in.
    const bodies = Array.from({ length: 6 }, (_, i) =>
      [`## Summary\nchange ${i}`, i < 4 ? TEMPLATE : "", i >= 3 ? "Bumped the version." : ""]
        .filter((line) => line !== "")
        .join("\n"),
    );
    const forbidden = wroteConfig({ mergedBodies: () => bodies }).pr.forbidden;
    expect(forbidden).toContain(TEMPLATE);
    expect(forbidden).not.toContain("Bumped the version.");
  });

  it("proposes a skeleton, not an empty section list, when no body could be read", () => {
    // configSchema requires at least one section: an empty list is a file that
    // cannot load, which is the one failure this command must not produce.
    const config = wroteConfig();
    expect(config.pr.sections.length).toBeGreaterThan(0);
    expect(config.pr.sections.map((s) => s.name)).toContain("What to Test");
  });
});
