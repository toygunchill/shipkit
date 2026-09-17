import { isAbsolute, join } from "node:path";
import { observedChangedFiles } from "../advice/observe.js";
import type { ChangedFile } from "../advice/uikit.js";
import { assembleBrief } from "../brief/assemble.js";
import { isValidBase } from "../cli-support.js";
import type { ShipkitConfig } from "../config/schema.js";
import { applicable, observedPaths } from "../readiness/apply.js";
import type { ReadinessAnswer, ReadinessRule } from "../readiness/types.js";
import type { FixRequest } from "../review/fixrequest.js";
import { briefContent, failureContent, applyContent, previewContent } from "./result.js";
import type { ToolContent } from "./result.js";
import type { SubmitDeps, SubmitOptions, SubmitResult } from "../submit/run.js";
import type { RepoState } from "../vcs/types.js";

export type ToolDeps = {
  /**
   * Builds the submit dependency object bound to one repository directory and the config
   * path this call resolved. The config path is what the readiness closure needs — a
   * long-lived server serves several repositories, and each may name its own rules file.
   */
  submitDeps: (repo: string, configPath: string) => SubmitDeps;
  loadConfig: (path: string) => ShipkitConfig;
  /**
   * The selection `shipkit review` left in this repository, when there is one.
   *
   * Optional only so a test may leave it out. Without it `shipkit_brief` returned a brief
   * with no `fixRequest` key at all — so for an agent driven through `shipkit mcp`, which is
   * the interface this project tells agents to use, a person could tick fourteen boxes, send
   * them, tell the agent to go, and the agent would be handed nothing. Neither of them had
   * any way to see it. A read that fails is reported, never degraded: see `readFixRequest`.
   */
  readFixRequest?: (repo: string) => FixRequest | undefined;
  readRepoState: (base: string, cwd: string) => RepoState;
  /** Both sides of the change's `.swift`/`.xib`/`.storyboard` text, so the brief this tool
   *  returns carries the same advice the CLI's `brief` prints. `readRepoState.changedFiles`
   *  cannot serve: it is names only, and detection needs the text. */
  readPushChangedFiles: (base: string, cwd: string) => ChangedFile[];
  /** Every path the push will deliver, of every type, for filtering readiness rules by
   *  `appliesTo`. Optional for the reason `SubmitDeps` records: a caller with no rules has
   *  no use for it, and one with rules but no read carries every rule rather than none. */
  readPushChangedPaths?: (base: string, cwd: string) => string[];
  /** This repository's readiness rules, or undefined when it configures none. Throws
   *  `ConfigError` on a configured-but-broken file, which `handleBrief` reports as a
   *  failure rather than an empty checklist. */
  loadReadiness?: (configPath: string) => ReadinessRule[] | undefined;
  runSubmit: (options: SubmitOptions, deps: SubmitDeps) => Promise<SubmitResult>;
};

export type BriefArgs = { repo: string; base: string; config?: string };

export type SubmitArgs = {
  repo: string;
  base: string;
  config?: string;
  title: string;
  commitMessage: string;
  sections: Record<string, string>;
  acknowledge?: string[];
  readiness?: ReadinessAnswer[];
};

export function configPath(args: { repo: string; config?: string }): string {
  // "" is absent too — `??` alone would read it as an explicit path and fail open.
  if (!args.config) return join(args.repo, ".shipkit.yml");
  // A relative config is relative to the caller's repository, not the server process's cwd —
  // a long-lived server serves several repositories from one process. An absolute path is
  // left exactly as given.
  return isAbsolute(args.config) ? args.config : join(args.repo, args.config);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Arguments arrive from a model, before any schema validates them (that lands in a later
// task). The declared `string[] | undefined` type of `SubmitArgs["acknowledge"]` is only a
// compile-time hint here — at runtime the value can be anything a caller sends, including the
// bare string "all", which `runSubmit` reads as everything-acknowledged. Anything that is not
// genuinely an array of strings means nothing was acknowledged, same as a missing value.
function acknowledged(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

/**
 * The readiness answers, from arguments a model wrote.
 *
 * Anything that is not a well-formed answer is not an answer: it is dropped, and the rule it
 * was meant for is then reported unanswered, which refuses. That is the fail-closed
 * direction — the alternative, repairing a half-shaped entry into a `pass`, would let a
 * malformed argument satisfy a rule nobody actually answered. `undefined` (no array at all)
 * stays `undefined` so a repository with no rules never carries an empty key.
 */
export function readinessAnswers(value: unknown): ReadinessAnswer[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const answers: ReadinessAnswer[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const { id, status, note } = item as { id?: unknown; status?: unknown; note?: unknown };
    if (typeof id !== "string" || id.length === 0) continue;
    if (status !== "pass" && status !== "fail" && status !== "n/a") continue;
    answers.push({ id, status, ...(typeof note === "string" ? { note } : {}) });
  }
  return answers;
}

export async function handleBrief(args: BriefArgs, deps: ToolDeps): Promise<ToolContent> {
  // shipkit_preview and shipkit_apply both refuse an invalid base via runSubmit; handleBrief
  // never called runSubmit, so it skipped this check even though the CLI's own `brief` action
  // performs it. Not exploitable on its own -- readRepoState passes --end-of-options and git
  // refuses -- but without this a caller can get a brief for a target shipkit_apply will
  // always refuse. Check it here so the three tools agree on what counts as a base at all.
  if (!isValidBase(args.base)) {
    return failureContent(`Refusing to use ${JSON.stringify(args.base)} as a base branch`);
  }
  try {
    const path = configPath(args);
    const config = deps.loadConfig(path);
    const repo = deps.readRepoState(args.base, args.repo);
    const rules = deps.loadReadiness?.(path);
    const readPaths = deps.readPushChangedPaths;
    // Guarded like the advice read below, with the difference `applicable` documents: a
    // failed read carries every rule rather than none, because a question about a file
    // nobody touched is answered `n/a` with a note, while a rule nobody was asked is
    // indistinguishable from a rule nobody broke.
    const fixRequest = deps.readFixRequest?.(args.repo);
    const readiness =
      rules === undefined
        ? undefined
        : applicable(
            rules,
            readPaths === undefined
              ? undefined
              : observedPaths(() => readPaths(args.base, args.repo)),
          );
    return briefContent(
      assembleBrief({
        repo,
        target: { branch: args.base, reason: "given by the caller" },
        config,
        ...(readiness === undefined ? {} : { readiness }),
        // `observedChangedFiles` because this read can fail on a repository where nothing
        // is wrong with the change — see src/advice/observe.ts. Unguarded, a missing
        // clean-filter binary turns the whole brief into `isError: true`.
        changed: observedChangedFiles(() => deps.readPushChangedFiles(args.base, args.repo)),
        // Unguarded on purpose, unlike the two reads above. Those degrade because a brief
        // without advice is still a correct brief; this one cannot, because a brief that
        // silently omits what a person chose is a brief that lies about having been reviewed.
        ...(fixRequest === undefined ? {} : { fixRequest }),
      }),
    );
  } catch (error) {
    return failureContent(describe(error));
  }
}

async function run(
  args: SubmitArgs,
  deps: ToolDeps,
  mode: "preview" | "apply",
): Promise<SubmitResult> {
  const path = configPath(args);
  const readiness = readinessAnswers(args.readiness);
  return deps.runSubmit(
    {
      base: args.base,
      config: path,
      response: {
        title: args.title,
        commitMessage: args.commitMessage,
        sections: args.sections,
        ...(readiness === undefined ? {} : { readiness }),
      },
      // No file, so nothing to keep out of the commit — the whole staging-exclusion
      // apparatus the CLI needs is skipped rather than handed a value to special-case.
      responsePath: undefined,
      mode,
      // A missing or malformed acknowledge means nothing was acknowledged. Defaulting it to
      // "all" — whether the value is absent or simply not an array — would turn the gate into
      // a formality the caller never has to notice.
      acknowledge: mode === "apply" ? acknowledged(args.acknowledge) : [],
    },
    deps.submitDeps(args.repo, path),
  );
}

export async function handlePreview(args: SubmitArgs, deps: ToolDeps): Promise<ToolContent> {
  try {
    return previewContent(await run(args, deps, "preview"));
  } catch (error) {
    return failureContent(describe(error));
  }
}

export async function handleApply(args: SubmitArgs, deps: ToolDeps): Promise<ToolContent> {
  try {
    return applyContent(await run(args, deps, "apply"));
  } catch (error) {
    return failureContent(describe(error));
  }
}
