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
    blockingLabels: z.array(z.string()).default([]),
    sections: z.array(sectionSchema).min(1),
    // Whether a person has to see the pre-flight warnings before a push. `echo`
    // is every repository that exists today: the caller acknowledging the
    // warning ids is enough. `human` requires a decision from the approval
    // surface, and an echoed id no longer suffices.
    approval: z.enum(["echo", "human"]).default("echo"),
    // How long to wait for that decision. Long enough that someone at their desk
    // has time to read three warnings and click; short enough that an agent's
    // tool call does not sit past its own timeout. On expiry the run refuses and
    // names the fingerprint, so calling again resumes the same question rather
    // than asking a new one.
    approvalTimeoutSeconds: z.number().int().positive().default(120),
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
