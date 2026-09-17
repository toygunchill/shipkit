import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ShipkitConfig } from "../config/schema.js";

export class ResponseError extends Error {}

/**
 * One rule's answer. Optional as a block, because a repository with no `readiness:` key has
 * no rules to answer — and required in practice by `runSubmit` the moment there are any: an
 * applicable rule with no answer here is a finding, not a shrug.
 *
 * A malformed shape refuses like everything else in this file rather than being repaired or
 * dropped. An answer shipkit had to guess at is not an answer.
 */
const readinessAnswerSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["pass", "fail", "n/a"]),
  note: z.string().optional(),
});

const responseSchema = z.object({
  title: z.string().min(1),
  commitMessage: z.string().min(1),
  sections: z.record(z.string(), z.string()),
  readiness: z.array(readinessAnswerSchema).optional(),
});

export type SubmitResponse = z.infer<typeof responseSchema>;

export function loadResponse(path: string): SubmitResponse {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new ResponseError(`Cannot read response at ${path}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ResponseError(`Cannot parse JSON at ${path}: ${detail}`);
  }

  const result = responseSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new ResponseError(`Invalid response at ${path}: ${detail}`);
  }
  return result.data;
}

export function renderBody(
  sections: Record<string, string>,
  config: ShipkitConfig,
): string {
  const knownNames = config.pr.sections.map((section) => section.name);
  const knownSet = new Set(knownNames);
  const unknownKeys = Object.keys(sections).filter((key) => !knownSet.has(key));

  if (unknownKeys.length > 0) {
    // Silently dropping a key the config doesn't recognise is its own kind of repair: an
    // agent that writes "What To Test" instead of "What to Test" loses that prose and is
    // then told section-empty for a section it did fill. Naming the near-miss, and listing
    // what the config actually declares, makes the typo visible instead of erased.
    const unknownPlural = unknownKeys.length > 1;
    const unknownList = unknownKeys.map((s) => `"${s}"`).join(", ");
    const knownList = knownNames.map((s) => `"${s}"`).join(", ");
    throw new ResponseError(
      `${unknownPlural ? "Sections" : "Section"} ${unknownList} ` +
        `${unknownPlural ? "are not configured sections" : "is not a configured section"}. ` +
        `Configured sections are ${knownList}.`,
    );
  }

  const headingPattern = /^##(?!#)\s+/;
  const offendingSections: string[] = [];

  for (const section of config.pr.sections) {
    const content = sections[section.name];
    if (content) {
      for (const line of content.split("\n")) {
        if (headingPattern.test(line)) {
          offendingSections.push(section.name);
          break;
        }
      }
    }
  }

  if (offendingSections.length > 0) {
    const sectionList = offendingSections.map((s) => `"${s}"`).join(", ");
    const plural = offendingSections.length > 1;
    const noun = plural ? "Sections" : "Section";
    const verb = plural ? "contain" : "contains";
    throw new ResponseError(
      `${noun} ${sectionList} ${verb} level-two headings (##). Use ### for sub-headings.`,
    );
  }

  return config.pr.sections
    .map((section) => `## ${section.name}\n\n${(sections[section.name] ?? "").trim()}\n`)
    .join("\n---\n\n");
}
