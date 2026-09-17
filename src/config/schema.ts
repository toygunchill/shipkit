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
  // Where this repository's PR-readiness rules live, relative to the **realpath** of this
  // file — see src/readiness/load.ts for why the realpath and not the apparent location.
  // Absent from every `.shipkit.yml` that exists today, and one of those must keep loading
  // and behaving exactly as it does now: absent means the channel is off entirely, no
  // question is carried and no answer is required.
  readiness: z.string().min(1).optional(),
  branch: z.object({ pattern: regexPatternSchema }),
  jira: z.object({
    baseUrl: z.string().url(),
    keyPattern: regexPatternSchema,
    linkPolicy: z.enum(["story", "any"]).default("story"),
    section: z.string().min(1).default("Issues Addressed"),
  }),
  // Absent from every `.shipkit.yml` that exists today, and loading one of
  // those must not change: this block only matters to a repository that opts
  // a project into `shipkit tech-task`.
  techTask: z
    .object({
      project: z.string().min(1),
      issueType: z.string().min(1),
      epic: z.string().min(1).optional(),
      // Must carry "{subject}" — a pattern without it produces the same
      // summary for every ticket, which is how a backlog fills with rows
      // nobody can tell apart.
      summaryPattern: z
        .string()
        .min(1)
        .refine((pattern) => pattern.includes("{subject}"), {
          message: 'must contain "{subject}"',
        }),
      // Extra Jira fields beyond project/issuetype/epic/summary, keyed by
      // field id since that's what the Jira API takes. Known ids seen so far:
      //   customfield_10101  Portfolio / Servis Bilgisi (a cascading select;
      //                      its parent has exactly one allowed value,
      //                      "Commercial")
      //   customfield_10102  Digital Team
      fields: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

export type Section = z.infer<typeof sectionSchema>;
export type ShipkitConfig = z.infer<typeof configSchema>;
