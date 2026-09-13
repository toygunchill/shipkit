import { isAbsolute, join } from "node:path";
import { observedChangedFiles } from "../advice/observe.js";
import type { ChangedFile } from "../advice/uikit.js";
import { assembleBrief } from "../brief/assemble.js";
import { isValidBase } from "../cli-support.js";
import type { ShipkitConfig } from "../config/schema.js";
import { briefContent, failureContent, applyContent, previewContent } from "./result.js";
import type { ToolContent } from "./result.js";
import type { SubmitDeps, SubmitOptions, SubmitResult } from "../submit/run.js";
import type { RepoState } from "../vcs/types.js";

export type ToolDeps = {
  /** Builds the submit dependency object bound to one repository directory. */
  submitDeps: (repo: string) => SubmitDeps;
  loadConfig: (path: string) => ShipkitConfig;
  readRepoState: (base: string, cwd: string) => RepoState;
  /** Both sides of the change's `.swift`/`.xib`/`.storyboard` text, so the brief this tool
   *  returns carries the same advice the CLI's `brief` prints. `readRepoState.changedFiles`
   *  cannot serve: it is names only, and detection needs the text. */
  readPushChangedFiles: (base: string, cwd: string) => ChangedFile[];
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
    const config = deps.loadConfig(configPath(args));
    const repo = deps.readRepoState(args.base, args.repo);
    return briefContent(
      assembleBrief({
        repo,
        target: { branch: args.base, reason: "given by the caller" },
        config,
        // `observedChangedFiles` because this read can fail on a repository where nothing
        // is wrong with the change — see src/advice/observe.ts. Unguarded, a missing
        // clean-filter binary turns the whole brief into `isError: true`.
        changed: observedChangedFiles(() => deps.readPushChangedFiles(args.base, args.repo)),
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
  return deps.runSubmit(
    {
      base: args.base,
      config: configPath(args),
      response: {
        title: args.title,
        commitMessage: args.commitMessage,
        sections: args.sections,
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
    deps.submitDeps(args.repo),
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
