import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { requestApproval } from "../approval/client.js";
import { loadConfig } from "../config/load.js";
import { loadReadiness as loadReadinessRules } from "../readiness/load.js";
import { resolveIssue } from "../cli-support.js";
import { archiveFixRequest, fixRequestExclusions, readFixRequest } from "../review/fixrequest.js";
import { renderBody } from "../submit/response.js";
import { runSubmit } from "../submit/run.js";
import type { SubmitDeps } from "../submit/run.js";
import {
  currentBranch,
  readHeadSha,
  readPushChangedFiles,
  readPushChangedPaths,
  readPushAddedLines,
  readPushDiffstat,
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

/**
 * The readiness answers, one per rule the brief listed.
 *
 * Declared on `shipkit_preview` as well as `shipkit_apply`: preview is where an agent
 * learns what is wrong while it can still fix it, and a preview that never saw the answers
 * would report every rule unanswered and teach the agent nothing about the rest.
 */
const readinessAnswer = {
  readiness: z
    .array(
      z.object({
        id: z.string().describe("The rule id, exactly as the brief spells it"),
        status: z
          .enum(["pass", "fail", "n/a"])
          .describe(
            "pass: the rule holds. fail: it does not, and note says how. n/a: it does not apply, and note says why.",
          ),
        note: z.string().optional().describe("Required for n/a; what makes a fail mean anything"),
      }),
    )
    .optional()
    .describe("One answer per readiness rule in the brief. Every rule listed must be answered."),
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
    // No exclusion, as in the CLI's own `brief`: a tool call carries its answer over the
    // wire, so there is never a response file in the repository to keep out of the commit.
    readPushChangedFiles: (base, cwd) => readPushChangedFiles(base, [], cwd),
    readPushChangedPaths: (base, cwd) => readPushChangedPaths(base, [], cwd),
    // Root-relative, so it is read from the repository root and not from whichever
    // subdirectory the caller happened to name.
    readFixRequest: (repo: string) => readFixRequest(readRepoRoot(repo)),
    // Resolved against the realpath of the config that named it — see
    // src/readiness/load.ts. A configured-but-broken rules file throws `ConfigError` from
    // here, which the tool reports as a failure; it never degrades into an empty checklist.
    loadReadiness: (configPath: string) => {
      const config = loadConfig(configPath);
      return config.readiness === undefined
        ? undefined
        : loadReadinessRules(configPath, config.readiness);
    },
    runSubmit,
    submitDeps: (repo: string, configPath: string): SubmitDeps => ({
      loadConfig,
      renderBody,
      currentBranch: () => currentBranch(repo),
      resolveIssue,
      readRepoState: (base) => readRepoState(base, repo),
      readPushDiffstat: (base, exclude) => readPushDiffstat(base, exclude, repo),
      readPushAddedLines: (base, exclude) => readPushAddedLines(base, exclude, repo),
      readPushChangedFiles: (base, exclude) => readPushChangedFiles(base, exclude, repo),
      readPushChangedPaths: (base, exclude) => readPushChangedPaths(base, exclude, repo),
      loadReadiness: () => {
        const config = loadConfig(configPath);
        return config.readiness === undefined
          ? undefined
          : loadReadinessRules(configPath, config.readiness);
      },
      // Both of these were missing, and both are optional on `SubmitDeps`, so their absence
      // type-checked in silence. Without the first, `commitAll` ran `git add --all` with no
      // exclusion and committed and pushed `.shipkit/fix-request.json` — a person's private
      // notes about what is wrong with their own change — and then `untracked-files` warned
      // about it on every later run. Without the second, a selection the agent had acted on
      // was never consumed, so the next brief asked for the same fixes again.
      fixRequestExclusions: () => fixRequestExclusions(readRepoRoot(repo)),
      archiveFixRequest: () => archiveFixRequest(readRepoRoot(repo), new Date()),
      findPullRequest: (branch) => findPullRequest(branch, repo),
      readUntrackedFiles: () => readUntrackedFiles(repo),
      readRepoRoot: () => readRepoRoot(repo),
      readHeadSha: () => readHeadSha(repo),
      realpath: (path) => realpathSync(path),
      requestApproval: (request, timeoutMs) => requestApproval(request, { timeoutMs }),
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
    "shipkit_pending_review",
    {
      description:
        "Check whether the person asked, from the shipkit menu bar, for a pull request to be " +
        "reviewed. Returns the pull request if one is waiting, and nothing if not. Changes " +
        "nothing except that the request is taken, so it is not answered twice. Call this " +
        "when the person says they asked for a review, or mentions the menu bar; the request " +
        "cannot be pushed to you, so asking is the only way to find it. The reply says which " +
        "checkout to point --repo at; ask the person where it is rather than guessing.",
      inputSchema: {},
    },
    async () => {
      const { readRequested, clearRequested } = await import("../prreview/requested.js");
      const waiting = readRequested();
      if (waiting === undefined) {
        return { content: [{ type: "text" as const, text: "No review was asked for." }] };
      }
      clearRequested();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ...waiting,
                next: `shipkit pr-review brief --pr ${waiting.number} --repo-slug ${waiting.repository} --repo <your checkout of ${waiting.repository}>`,
                // Spelled out because getting it wrong fails silently and badly.
                // The rules are read from a local checkout, and `--repo` defaults
                // to the working directory — so an agent standing somewhere else
                // judges this pull request against whatever conventions happen to
                // be there, and writes comments citing another project's rules.
                repoMustPointAt:
                  "your local checkout of " +
                  waiting.repository +
                  ". The rules are read from there, not from the pull request, and pointing " +
                  "--repo at the wrong checkout produces remarks citing the wrong project's rules.",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "shipkit_preview",
    {
      description:
        "Check a drafted pull-request title, commit message and sections against this " +
        "repository's conventions. Returns what is wrong, what is risky, and the body " +
        "that would be posted. Changes nothing. Run this before shipkit_apply.",
      inputSchema: { ...repoAndBase, ...answer, ...readinessAnswer },
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
        ...readinessAnswer,
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
  // Announce this agent to the menu bar, if there is one. The connection lives as long as
  // this process, which lives as long as the agent hosting it, so it says "an agent is
  // here" for exactly the right interval. A missing or stopped application resolves to a
  // no-op: the companion is optional and serving must not depend on it.
  const { attachAgent } = await import("../approval/attach.js");
  // Not awaited: it returns at once and keeps trying in the background, so an
  // application that is not running yet never delays the agent's own startup.
  const attachment = attachAgent(process.env.SHIPKIT_AGENT ?? "agent");
  const detach = (): void => attachment.detach();
  process.once("exit", detach);
  process.once("SIGINT", detach);
  process.once("SIGTERM", detach);

  await createServer(realToolDeps()).connect(new StdioServerTransport());
}
