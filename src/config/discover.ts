import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { parse } from "yaml";
import { readFileSync } from "node:fs";
import { configSchema } from "./schema.js";

/**
 * Finding a repository's conventions without knowing what it called the file.
 *
 * shipkit used to look for `.shipkit.yml` and nothing else, which quietly asked every
 * repository to name a file after the tool that reads it. A team's conventions are not the
 * tool's, and the name should be theirs — `pull-request-conventions.yml` is a better name
 * for what the file holds, and shipkit has no business insisting otherwise.
 *
 * So the file is recognised by **shape**: a YAML file that satisfies `configSchema` is a
 * shipkit config, whatever it is called.
 */

/**
 * Where to look, in order.
 *
 * A bounded list and not a walk of the repository. A full walk would be slow on a large
 * checkout, would read files nobody offered, and — worse — could match something a team
 * never meant as a config. These are the places a project actually keeps such a file, and
 * being unable to find one is a reported failure rather than a reason to search harder.
 */
export const SEARCH_DIRECTORIES = [".", "docs", "docs/adr", ".github", "config", ".config"];

/** Tried first wherever it is found, because it is what earlier versions wrote. */
export const CONVENTIONAL_NAME = ".shipkit.yml";

function candidatesIn(root: string, directory: string): string[] {
  const full = join(root, directory);
  if (!existsSync(full)) return [];
  let entries: string[];
  try {
    entries = readdirSync(full);
  } catch {
    // Unreadable directory. Not finding a config here is an answer; failing the whole
    // search because one directory is unreadable is not.
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => join(full, name))
    .filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    });
}

/** True when this file parses as a shipkit config. The whole definition of "a config". */
export function isConfigFile(path: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  // A file larger than any hand-written config is not one, and parsing a huge generated
  // YAML to find out costs more than the answer is worth.
  if (raw.length > 256 * 1024) return false;
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch {
    return false;
  }
  return configSchema.safeParse(parsed).success;
}

export type Discovery =
  | { found: "one"; path: string }
  | { found: "none"; looked: string[] }
  | { found: "several"; paths: string[] };

/**
 * The conventions file in `root`, or why there is not exactly one.
 *
 * Several is refused rather than resolved by order. Two files that both validate are two
 * answers to "what are this repository's conventions", and picking the one that sorted
 * first would make the answer depend on a filename — which is the dependency this whole
 * change exists to remove.
 */
export function discoverConfig(root: string): Discovery {
  const conventional = join(root, CONVENTIONAL_NAME);
  if (existsSync(conventional) && isConfigFile(conventional)) {
    return { found: "one", path: conventional };
  }

  const found: string[] = [];
  for (const directory of SEARCH_DIRECTORIES) {
    for (const candidate of candidatesIn(root, directory)) {
      if (candidate === conventional) continue;
      if (isConfigFile(candidate)) found.push(candidate);
    }
  }

  if (found.length === 1) return { found: "one", path: found[0] as string };
  if (found.length > 1) return { found: "several", paths: found };
  return { found: "none", looked: SEARCH_DIRECTORIES.map((d) => (d === "." ? root : join(root, d))) };
}

/** What to say when there is no config, or more than one. Written to be acted on. */
export function explainDiscovery(discovery: Discovery, root: string): string {
  if (discovery.found === "several") {
    const names = discovery.paths.map((p) => relative(root, p)).join(", ");
    return (
      `More than one file here reads as a conventions file: ${names}. shipkit will not ` +
      "pick between them — two answers to what this repository's conventions are is not " +
      "something to resolve by filename order. Pass --config to name the one you mean."
    );
  }
  return (
    "No conventions file found. shipkit keeps no rules of its own: what a title should " +
    "look like here, which sections a body needs, which branch names are allowed — all of " +
    "that lives in a file in this repository, and shipkit only knows how to check against " +
    "it.\n\nRun `shipkit init` to write one, or pass --config if yours is somewhere " +
    `shipkit did not look (it tried ${SEARCH_DIRECTORIES.join(", ")}).`
  );
}

/** Resolves `--config` if given, or discovers one. Absolute paths are taken as written. */
export function resolveConfigPath(
  root: string,
  explicit: string | undefined,
): { path: string } | { problem: string } {
  if (explicit !== undefined && explicit.length > 0) {
    return { path: isAbsolute(explicit) ? explicit : join(root, explicit) };
  }
  const discovery = discoverConfig(root);
  return discovery.found === "one" ? { path: discovery.path } : { problem: explainDiscovery(discovery, root) };
}
