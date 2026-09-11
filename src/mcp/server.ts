import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { loadConfig } from "../config/load.js";
import { resolveIssue } from "../cli-support.js";
import { renderBody } from "../submit/response.js";
import { runSubmit } from "../submit/run.js";
import type { SubmitDeps } from "../submit/run.js";
import {
  currentBranch,
  readRepoRoot,
  readRepoState,
  readUntrackedFiles,
} from "../vcs/git.js";
import { findPullRequest } from "../vcs/github.js";
import { commitAll, createPullRequest, pushBranch } from "../vcs/mutate.js";
import { handleApply, handleBrief, handlePreview } from "./tools.js";
import type { ToolDeps } from "./tools.js";

const repoAndBase = {
  // A relative path (e.g. "." or "repo") resolves against the server process's own cwd, not
  // the caller's intended repository — configPath and every adapter would then read and
  // mutate whatever directory the long-lived server happens to have been started from,
  // silently, since that directory is a perfectly valid git repository too. Requiring an
  // absolute path here, not just documenting it, is what prevents that.
  repo: z
    .string()
    .refine((value) => isAbsolute(value), { message: "repo must be an absolute path" })
    .describe("Absolute path to the repository to act on"),
  base: z.string().describe("Branch the pull request targets, e.g. develop"),
  config: z.string().optional().describe("Path to .shipkit.yml; defaults to <repo>/.shipkit.yml"),
};

const answer = {
  title: z.string().describe("Pull-request title, matching the brief's titlePattern"),
  commitMessage: z.string().describe("Commit message: subject, then an optional body"),
  sections: z
    .record(z.string(), z.string())
    .describe("One entry per section named in the brief, spelled exactly"),
};

export function realToolDeps(): ToolDeps {
  return {
    loadConfig,
    readRepoState: (base, cwd) => readRepoState(base, cwd),
    runSubmit,
    submitDeps: (repo: string): SubmitDeps => ({
      loadConfig,
      renderBody,
      currentBranch: () => currentBranch(repo),
      resolveIssue,
      readRepoState: (base) => readRepoState(base, repo),
      findPullRequest: (branch) => findPullRequest(branch, repo),
      readUntrackedFiles: () => readUntrackedFiles(repo),
      readRepoRoot: () => readRepoRoot(repo),
      realpath: (path) => realpathSync(path),
      commitAll: (message, exclude) => commitAll(message, exclude, repo),
      pushBranch: (branch) => pushBranch(branch, repo),
      createPullRequest: (input) => createPullRequest(input, repo),
      // stdout is the protocol channel. Anything written to it corrupts the stream, so the
      // sequence's output is discarded here and returned as tool content instead.
      out: () => undefined,
      err: () => undefined,
    }),
  };
}

export function createServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: "shipkit", version: "0.1.0" });

  server.registerTool(
    "shipkit_brief",
    {
      description:
        "Read this repository's pull-request conventions and the facts about the current " +
        "change before writing a pull request. Returns the sections to fill, a hint for " +
        "each, and the rules the answer must satisfy. Changes nothing. Ask the human which " +
        "branch to target before calling this; release timing decides it and the repository " +
        "does not record it, so it is not yours to infer.",
      inputSchema: repoAndBase,
    },
    async (args) => handleBrief(args, deps),
  );

  server.registerTool(
    "shipkit_preview",
    {
      description:
        "Check a drafted pull-request title, commit message and sections against this " +
        "repository's conventions. Returns what is wrong, what is risky, and the body " +
        "that would be posted. Changes nothing. Run this before shipkit_apply.",
      inputSchema: { ...repoAndBase, ...answer },
    },
    async (args) => handlePreview(args, deps),
  );

  server.registerTool(
    "shipkit_apply",
    {
      description:
        "Commit, push, and open or update the pull request. Refuses if the answer does " +
        "not comply. If pre-flight warns, it refuses until every warning id it reports is " +
        "passed back in acknowledge — get those ids from shipkit_preview and show them to " +
        "the human before acknowledging.",
      inputSchema: {
        ...repoAndBase,
        ...answer,
        acknowledge: z
          .array(z.string())
          .optional()
          .describe("Check ids of the pre-flight warnings you have seen and accepted"),
      },
    },
    async (args) => handleApply(args, deps),
  );

  return server;
}

export async function serveStdio(): Promise<void> {
  await createServer(realToolDeps()).connect(new StdioServerTransport());
}
