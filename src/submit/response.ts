import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ShipkitConfig } from "../config/schema.js";

export class ResponseError extends Error {}

const responseSchema = z.object({
  title: z.string().min(1),
  commitMessage: z.string().min(1),
  sections: z.record(z.string(), z.string()),
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
