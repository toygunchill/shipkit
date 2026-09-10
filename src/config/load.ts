import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { configSchema, type ShipkitConfig } from "./schema.js";

export class ConfigError extends Error {}

export function loadConfig(path: string): ShipkitConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`Cannot read config at ${path}`);
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
