import { z } from "zod";

function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

const regexPatternSchema = z
  .string()
  .min(1)
  .refine(isValidRegex, { message: "must be a valid regular expression" });

export const sectionSchema = z.object({
  name: z.string().min(1),
  required: z.boolean(),
  minItems: z.number().int().positive().optional(),
  hint: z.string().optional(),
});

export const configSchema = z.object({
  pr: z.object({
    titlePattern: regexPatternSchema,
    forbidden: z.array(z.string()).default([]),
    sections: z.array(sectionSchema).min(1),
  }),
  branch: z.object({ pattern: regexPatternSchema }),
  jira: z.object({
    baseUrl: z.string().url(),
    keyPattern: regexPatternSchema,
    linkPolicy: z.enum(["story", "any"]).default("story"),
    section: z.string().min(1).default("Issues Addressed"),
  }),
});

export type Section = z.infer<typeof sectionSchema>;
export type ShipkitConfig = z.infer<typeof configSchema>;
