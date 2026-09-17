import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { ConfigError } from "../config/load.js";
import type { ReadinessRule } from "./types.js";

const ruleSchema = z.object({
  id: z.string().min(1),
  ask: z.string().min(1),
  why: z.string().min(1).optional(),
  appliesTo: z.array(z.string().min(1)).min(1).optional(),
  severity: z.enum(["block", "warn", "advise"]),
});

const rulesSchema = z.object({
  // Pinned rather than defaulted: the file is written by the team, and a `version: 2` they
  // author for a shipkit that understands it must not be half-read by one that does not.
  version: z.literal(1),
  rules: z
    .array(ruleSchema)
    .min(1)
    .superRefine((rules, context) => {
      // Two rules with one id is not a style question. The second is unreachable by any
      // answer — one answer would satisfy both, and a duplicate-answer finding would fire
      // for a response that named each exactly once.
      const seen = new Set<string>();
      const duplicated = new Set<string>();
      for (const rule of rules) {
        if (seen.has(rule.id)) duplicated.add(rule.id);
        seen.add(rule.id);
      }
      if (duplicated.size > 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate rule ids: ${[...duplicated].sort().join(", ")}`,
        });
      }
    }),
});

/**
 * Where `readiness:` points, resolved against the **realpath** of the config that names it.
 *
 * This is the deployment model, not pedantry. A product repository carries `.shipkit.yml`
 * as a symbolic link into a shared conventions repository, so `readiness: ./readiness.yml`
 * has to land next to the link's *target* — the file that actually spells the rules —
 * rather than in the product repository, where nothing of the sort exists. Resolved
 * against the apparent location, every symlinked deployment fails to find its rules at
 * all, which under the rule below is a refusal on every run.
 *
 * An absolute path is taken as given, symlink or not.
 */
export function readinessPath(configPath: string, readiness: string): string {
  if (isAbsolute(readiness)) return readiness;
  let real: string;
  try {
    real = realpathSync(configPath);
  } catch {
    // The config was read a moment ago, so this means it vanished underneath us. Reported
    // the way every other bad input is, rather than escaping as an ENOENT stack trace.
    throw new ConfigError(`Cannot resolve the config path ${configPath} to locate its readiness rules`);
  }
  return resolve(dirname(real), readiness);
}

/**
 * The rules named by `readiness:`, or a loud failure.
 *
 * Every way this can fail throws `ConfigError`, in the same words and the same style
 * `loadConfig` fails today — missing file, unparseable YAML, a rule with no `severity`, two
 * rules sharing an id. The alternative was considered and rejected: a broken rules file
 * that merely turns enforcement off leaves a repository believing its checklist is being
 * carried while nothing is asked and nothing is refused. Enforcement that silently
 * vanishes is worse than a crash, because only one of the two gets fixed.
 */
export function loadReadiness(configPath: string, readiness: string): ReadinessRule[] {
  const path = readinessPath(configPath, readiness);

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(
      `Cannot read readiness rules at ${path} (named by readiness: ${readiness} in ${configPath})`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Cannot parse YAML at ${path}: ${detail}`);
  }

  const result = rulesSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid readiness rules at ${path}: ${detail}`);
  }
  return result.data.rules;
}
