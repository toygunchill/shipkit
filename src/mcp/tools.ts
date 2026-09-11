import { join } from "node:path";
import { assembleBrief } from "../brief/assemble.js";
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
  return args.config ?? join(args.repo, ".shipkit.yml");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function handleBrief(args: BriefArgs, deps: ToolDeps): Promise<ToolContent> {
  try {
    const config = deps.loadConfig(configPath(args));
    const repo = deps.readRepoState(args.base, args.repo);
    return briefContent(
      assembleBrief({
        repo,
        target: { branch: args.base, reason: "given by the caller" },
        config,
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
      // A missing acknowledge means nothing was acknowledged. Defaulting it to "all" would
      // turn the gate into a formality the caller never has to notice.
      acknowledge: mode === "apply" ? (args.acknowledge ?? []) : [],
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
