import { z } from "zod";

export const sectionSchema = z.object({
  name: z.string().min(1),
  required: z.boolean(),
  minItems: z.number().int().positive().optional(),
  hint: z.string().optional(),
});

export const configSchema = z.object({
  pr: z.object({
    titlePattern: z.string().min(1),
    forbidden: z.array(z.string()).default([]),
    sections: z.array(sectionSchema).min(1),
  }),
  branch: z.object({ pattern: z.string().min(1) }),
  jira: z.object({
    baseUrl: z.string().url(),
    keyPattern: z.string().min(1),
    linkPolicy: z.enum(["story", "any"]).default("story"),
  }),
});

export type Section = z.infer<typeof sectionSchema>;
export type ShipkitConfig = z.infer<typeof configSchema>;
