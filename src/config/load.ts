import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { configSchema, type ShipkitConfig } from "./schema.js";

export class ConfigError extends Error {}

export function loadConfig(path: string): ShipkitConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // Names the way out. shipkit holds no conventions of its own — without this file it
    // does not know what a title should look like here, which sections a body needs, or
    // which branch names are allowed. "Cannot read config" is accurate and leaves a person
    // with nothing to do about it.
    throw new ConfigError(
      `Cannot read config at ${path}. shipkit keeps no rules of its own — the conventions ` +
        "live in this file. Run `shipkit init` to write a starter one from what your forge " +
        "can prove, or pass --config if yours is somewhere else.",
    );
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Cannot parse YAML at ${path}: ${detail}`);
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid config at ${path}: ${detail}`);
  }
  return result.data;
}
