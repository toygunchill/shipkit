import { posix } from "node:path";
import { parse } from "yaml";
import { isConfigText, searchDirectories } from "../config/discover.js";
import { configSchema } from "../config/schema.js";
import { rulesSchema } from "../readiness/load.js";
import type { ReadinessRule } from "../readiness/types.js";

/**
 * The rules a pull request will be merged into, read from the branch it targets.
 *
 * Not from the working tree. A reviewer's checkout is on whatever branch their own work is
 * on, and that branch has nothing to do with the change in front of them — it may predate
 * the rules entirely, which is exactly what happened the first time this was used: the
 * rules had been merged to `develop`, the reviewer was on a bugfix branch cut before that,
 * and shipkit reported no conventions file at all.
 *
 * Reading the base ref also answers the question correctly rather than conveniently: a
 * change is judged against the rules it will land among, not against whichever revision a
 * reviewer happens to have checked out.
 *
 * Read through `git`, not the forge's contents API. The reviewer has a checkout already, so
 * `git show <ref>:<path>` costs one local process and no round trip, needs no base64
 * decoding, and leaves the working tree untouched.
 */

/** Runs a git command in `root` and returns stdout, or `undefined` if it failed. */
export type GitRunner = (args: string[]) => string | undefined;

/** Makes the ref that `git show` should read, preferring the remote-tracking copy. */
export function baseRef(base: string, git: GitRunner, remote = "origin"): string | undefined {
  // The remote-tracking ref first: a reviewer's local `develop` can be weeks behind, and
  // judging against stale rules is the failure this whole module exists to avoid.
  for (const candidate of [`${remote}/${base}`, base]) {
    if (git(["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]) !== undefined) {
      return candidate;
    }
  }
  return undefined;
}

/** Every `.yml`/`.yaml` blob at `ref`, in the directories a config is kept in. */
function candidatesAt(ref: string, git: GitRunner): string[] {
  const listed = git(["ls-tree", "-r", "--name-only", ref]);
  if (listed === undefined) return [];

  // The same bounded set the working-tree search uses, derived from what the ref actually
  // holds rather than from the disk — the reviewer's checkout may not have these
  // directories at all.
  const inRef = listed.split("\n").filter((line) => line.length > 0);
  const docsSubdirectories = new Set<string>();
  for (const path of inRef) {
    const parts = path.split("/");
    if (parts.length >= 3 && parts[0] === "docs") docsSubdirectories.add(`docs/${parts[1]}`);
  }
  const directories = new Set([...searchDirectories("/nonexistent"), ...docsSubdirectories]);

  return inRef.filter((path) => {
    if (!path.endsWith(".yml") && !path.endsWith(".yaml")) return false;
    const directory = path.includes("/") ? posix.dirname(path) : ".";
    return directories.has(directory);
  });
}

export type BaseRules =
  | { found: "one"; configPath: string; rules: ReadinessRule[] }
  | { found: "none"; ref: string }
  | { found: "several"; paths: string[] };

/**
 * The conventions and readiness rules as they stand on `base`.
 *
 * Two files that both read as a config are refused rather than resolved by order, exactly
 * as in the working-tree search: two answers to "what are this repository's conventions" is
 * not something to settle by which path sorts first.
 */
export function rulesAtBase(base: string, git: GitRunner, remote = "origin"): BaseRules {
  const ref = baseRef(base, git, remote);
  if (ref === undefined) return { found: "none", ref: base };

  const found: { path: string; raw: string }[] = [];
  for (const path of candidatesAt(ref, git)) {
    const raw = git(["show", `${ref}:${path}`]);
    if (raw !== undefined && isConfigText(raw)) found.push({ path, raw });
  }

  if (found.length === 0) return { found: "none", ref };
  if (found.length > 1) return { found: "several", paths: found.map((entry) => entry.path) };

  const only = found[0] as { path: string; raw: string };
  const config = configSchema.parse(parse(only.raw));

  return {
    found: "one",
    configPath: only.path,
    rules: readinessAt(ref, only.path, config.readiness, git),
  };
}

/**
 * The checklist the config names, read from the same ref.
 *
 * `readiness:` is relative to the config, so it is resolved against the config's directory
 * inside the ref rather than against anything on disk. A checklist that cannot be read is
 * reported as no rules rather than as a crash: a review with no rules to cite produces no
 * remarks, which is a correct and visible outcome.
 */
function readinessAt(
  ref: string,
  configPath: string,
  readiness: string | readonly string[] | undefined,
  git: GitRunner,
): ReadinessRule[] {
  if (readiness === undefined) return [];
  const named = typeof readiness === "string" ? [readiness] : [...readiness];
  const base = configPath.includes("/") ? posix.dirname(configPath) : ".";

  const rules: ReadinessRule[] = [];
  for (const entry of named) {
    const path = posix.normalize(base === "." ? entry : `${base}/${entry}`).replace(/^\.\//, "");
    const raw = git(["show", `${ref}:${path}`]);
    if (raw === undefined) continue;
    const parsed = rulesSchema.safeParse(parse(raw));
    if (parsed.success) rules.push(...parsed.data.rules);
  }
  return rules;
}

/** Kept so a caller can say where it looked without rebuilding the reasoning. */
export function explainBaseRules(outcome: BaseRules, base: string): string {
  if (outcome.found === "several") {
    return (
      `More than one file on ${base} reads as a conventions file: ${outcome.paths.join(", ")}. ` +
      "shipkit will not pick between them."
    );
  }
  return (
    `No conventions file on ${base}. The rules for a review are read from the branch the ` +
    "pull request targets, not from your own checkout, so this says the target branch " +
    "carries none — not that yours does."
  );
}

/**
 * The rule files at `base`, as text, for a caller that needs them on disk.
 *
 * `brief`, `submit` and the rest load conventions by path, and `readiness:` resolves
 * against the directory of the config that named it. Handing them text would mean changing
 * every one of those; handing them a directory that looks like the repository's own costs
 * one temporary write and leaves the rest of the product alone.
 */
export function ruleFilesAtBase(
  base: string,
  git: GitRunner,
  remote = "origin",
): { configName: string; files: { name: string; contents: string }[] } | undefined {
  const ref = baseRef(base, git, remote);
  if (ref === undefined) return undefined;

  const found: { path: string; raw: string }[] = [];
  for (const path of candidatesAt(ref, git)) {
    const raw = git(["show", `${ref}:${path}`]);
    if (raw !== undefined && isConfigText(raw)) found.push({ path, raw });
  }
  // Exactly one, for the same reason the working-tree search insists on it: two answers to
  // "what are this repository's conventions" is not something to settle by path order.
  if (found.length !== 1) return undefined;

  const only = found[0] as { path: string; raw: string };
  const configName = only.path.includes("/") ? (only.path.split("/").pop() as string) : only.path;
  const files = [{ name: configName, contents: only.raw }];

  const config = configSchema.parse(parse(only.raw));
  const readiness = config.readiness;
  if (readiness !== undefined) {
    const directory = only.path.includes("/") ? posix.dirname(only.path) : ".";
    for (const entry of typeof readiness === "string" ? [readiness] : readiness) {
      const at = posix.normalize(directory === "." ? entry : `${directory}/${entry}`).replace(/^\.\//, "");
      const raw = git(["show", `${ref}:${at}`]);
      // Written under the name the config asks for, so `readiness:` resolves unchanged.
      if (raw !== undefined) files.push({ name: entry.replace(/^\.\//, ""), contents: raw });
    }
  }

  return { configName, files };
}
