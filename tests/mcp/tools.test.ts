import { describe, expect, it } from "vitest";
import { configPath, handleApply, handleBrief, handlePreview } from "../../src/mcp/tools.js";
import type { ToolDeps } from "../../src/mcp/tools.js";
import { loadConfig } from "../../src/config/load.js";
import type { SubmitOptions, SubmitResult, SubmitDeps } from "../../src/submit/run.js";
import type { FixRequest } from "../../src/review/fixrequest.js";
import type { Brief } from "../../src/brief/types.js";

const CONFIG = loadConfig("tests/fixtures/valid.shipkit.yml");

const ARGS = {
  repo: "/repo",
  base: "develop",
  title: "[ABC-1] fix(x): y",
  commitMessage: "fix(x): y",
  sections: { Summary: "s" },
};

function makeDeps(over: Partial<ToolDeps> = {}) {
  const seen: SubmitOptions[] = [];
  const repos: string[] = [];
  const deps: ToolDeps = {
    submitDeps: (repo: string) => {
      repos.push(repo);
      return {} as SubmitDeps;
    },
    loadConfig: () => CONFIG,
    readRepoState: () => ({ branch: "bugfix/x/1-y", changedFiles: [], diffstat: "", commits: [] }),
    readPushChangedFiles: () => [],
    runSubmit: async (options: SubmitOptions) => {
      seen.push(options);
      return {
        code: 0, findings: [], warnings: [], body: "## Summary\n\ns\n",
        url: "https://example.com/pr/1", updated: false, committed: true, pushed: true,
      } satisfies SubmitResult;
    },
    ...over,
  };
  return { deps, seen, repos };
}

describe("configPath", () => {
  it("defaults to .shipkit.yml at the repository root", () => {
    expect(configPath({ repo: "/repo" })).toBe("/repo/.shipkit.yml");
  });

  it("uses an explicit absolute config as given", () => {
    expect(configPath({ repo: "/repo", config: "/elsewhere/x.yml" })).toBe("/elsewhere/x.yml");
  });

  it("resolves a relative config against the repository, not the process cwd", () => {
    expect(configPath({ repo: "/repo", config: "team/.shipkit.yml" })).toBe(
      "/repo/team/.shipkit.yml",
    );
  });

  it("treats an empty-string config as absent", () => {
    expect(configPath({ repo: "/repo", config: "" })).toBe("/repo/.shipkit.yml");
  });
});

describe("handleBrief", () => {
  it("reads the repository the caller named, not the process directory", async () => {
    const { deps, repos } = makeDeps();
    let seenCwd = "";
    deps.readRepoState = (_base: string, cwd: string) => {
      seenCwd = cwd;
      return { branch: "bugfix/x/1-y", changedFiles: [], diffstat: "", commits: [] };
    };

    await handleBrief({ repo: "/repo", base: "develop" }, deps);

    expect(seenCwd).toBe("/repo");
  });

  it("returns the brief as structured content", async () => {
    const { deps } = makeDeps();
    const shaped = await handleBrief({ repo: "/repo", base: "develop" }, deps);
    expect(shaped.isError).toBe(false);
    expect(shaped.structuredContent).toHaveProperty("template");
  });

  it("reports a bad config as content rather than throwing", async () => {
    const { deps } = makeDeps({
      loadConfig: () => {
        throw new Error("boom");
      },
    });
    await expect(handleBrief({ repo: "/repo", base: "develop" }, deps)).resolves.toMatchObject({
      isError: true,
    });
  });

  // shipkit_preview and shipkit_apply both refuse an option-shaped base before touching the
  // repository (runSubmit checks it); handleBrief skipped the check entirely, so a caller
  // could get a brief for a target the other two tools will always refuse.
  it("refuses an option-shaped base without reading repo state", async () => {
    const { deps } = makeDeps();
    let readRepoStateCalled = false;
    deps.readRepoState = () => {
      readRepoStateCalled = true;
      return { branch: "bugfix/x/1-y", changedFiles: [], diffstat: "", commits: [] };
    };

    const shaped = await handleBrief({ repo: "/repo", base: "--upload-pack=evil" }, deps);

    expect(shaped.isError).toBe(true);
    expect(readRepoStateCalled).toBe(false);
  });

  // A config that cannot be loaded is a real failure and belongs in `isError`. A failed
  // *advisory* read is not: it is an optional observation, and the brief is complete
  // without it. Reproduced shapes — a `.gitattributes` clean filter marked `required` whose
  // binary is missing, one unreadable file — turned the whole tool call into an error.
  it("returns the brief anyway when the advisory read fails, rather than isError", async () => {
    const { deps } = makeDeps({
      readPushChangedFiles: () => {
        throw new Error("git add --all failed: fatal: asset.bin: clean filter 'lfs' failed");
      },
    });

    const shaped = await handleBrief({ repo: "/repo", base: "develop" }, deps);

    expect(shaped.isError).toBe(false);
    expect(shaped.structuredContent).toHaveProperty("template");
    // No advice key at all, rather than a wrong observation in place of a missing one.
    expect(shaped.structuredContent).not.toHaveProperty("advice");
  });
});

describe("handlePreview", () => {
  it("runs in preview mode and passes no response path", async () => {
    const { deps, seen } = makeDeps();

    await handlePreview(ARGS, deps);

    expect(seen[0].mode).toBe("preview");
    expect(seen[0].responsePath).toBeUndefined();
  });

  it("binds the submit dependencies to the repository the caller named", async () => {
    const { deps, repos } = makeDeps();
    await handlePreview(ARGS, deps);
    expect(repos).toEqual(["/repo"]);
  });

  // Preview must never be able to act, whatever it is handed.
  it("ignores an acknowledge argument", async () => {
    const { deps, seen } = makeDeps();
    await handlePreview({ ...ARGS, acknowledge: ["untracked-files"] }, deps);
    expect(seen[0].mode).toBe("preview");
    expect(seen[0].acknowledge).toEqual([]);
  });

  it("forwards an empty acknowledge even when handed a non-empty array", async () => {
    const { deps, seen } = makeDeps();
    await handlePreview({ ...ARGS, acknowledge: ["untracked-files", "unpushed-commits"] }, deps);
    expect(seen[0].acknowledge).toEqual([]);
  });
});

describe("handleApply", () => {
  it("runs in apply mode and forwards the acknowledged ids", async () => {
    const { deps, seen } = makeDeps();

    await handleApply({ ...ARGS, acknowledge: ["untracked-files"] }, deps);

    expect(seen[0].mode).toBe("apply");
    expect(seen[0].acknowledge).toEqual(["untracked-files"]);
  });

  // A missing acknowledge must mean "nothing acknowledged", never "everything".
  it("treats a missing acknowledge as an empty list, not as all", async () => {
    const { deps, seen } = makeDeps();

    await handleApply(ARGS, deps);

    expect(seen[0].acknowledge).toEqual([]);
  });

  // A model can send arguments a compile-time type never sees. The bare string "all" is
  // exactly what runSubmit's own "all" acknowledgement means — if it slipped through here
  // unchecked it would open the gate on every warning, not just the ones actually acknowledged.
  it("treats a bare string acknowledge as nothing acknowledged, not as all", async () => {
    const { deps, seen } = makeDeps();

    await handleApply({ ...ARGS, acknowledge: "all" as unknown as string[] }, deps);

    expect(seen[0].acknowledge).toEqual([]);
  });

  it("forwards a genuine array acknowledge as-is, including one literally named 'all'", async () => {
    const { deps, seen } = makeDeps();

    await handleApply({ ...ARGS, acknowledge: ["all"] }, deps);

    expect(seen[0].acknowledge).toEqual(["all"]);
  });

  it("reports a thrown adapter failure as content rather than throwing", async () => {
    const { deps } = makeDeps({
      runSubmit: () => Promise.reject(new Error("gh exploded")),
    });
    await expect(handleApply(ARGS, deps)).resolves.toMatchObject({ isError: true });
  });
});

const SELECTION: FixRequest = {
  version: 1,
  createdAt: "2026-09-17T10:00:00.000Z",
  base: "develop",
  branch: "bugfix/x/1-y",
  items: [{ kind: "warning", id: "untracked-files", message: "m", note: "delete the scratch file" }],
};

describe("the MCP brief and the review selection", () => {
  // This surface knew nothing about `shipkit review` at all: a person could tick fourteen
  // boxes, send them, tell the agent to go, and — for any agent driven through `shipkit mcp`,
  // which is the interface this project tells agents to use — the agent was handed nothing,
  // with no way for either of them to see it.
  it("carries the selection the person made, first, like the CLI does", async () => {
    const { deps } = makeDeps({ readFixRequest: () => SELECTION });

    const shaped = await handleBrief({ repo: "/repo", base: "develop" }, deps);
    const brief = shaped.structuredContent as Brief;

    expect(brief.fixRequest?.items).toEqual(SELECTION.items);
    expect(Object.keys(brief)[0]).toBe("fixRequest");
  });

  it("reads it from the repository the caller named", async () => {
    const seen: string[] = [];
    const { deps } = makeDeps({
      readFixRequest: (repo: string) => {
        seen.push(repo);
        return undefined;
      },
    });

    await handleBrief({ repo: "/elsewhere", base: "develop" }, deps);

    expect(seen).toEqual(["/elsewhere"]);
  });

  // Unguarded on purpose, unlike the advice and readiness reads beside it: a brief that
  // silently omits what a person chose is a brief that lies about having been reviewed.
  it("reports a selection it cannot read rather than pretending there is none", async () => {
    const { deps } = makeDeps({
      readFixRequest: () => {
        throw new Error("Cannot read the review selection at /repo/.shipkit/fix-request.json: EACCES");
      },
    });

    const shaped = await handleBrief({ repo: "/repo", base: "develop" }, deps);

    expect(shaped.isError).toBe(true);
    expect(JSON.stringify(shaped.content)).toContain("EACCES");
  });

  it("is absent, as before, in a repository nobody has reviewed", async () => {
    const { deps } = makeDeps();

    const shaped = await handleBrief({ repo: "/repo", base: "develop" }, deps);

    expect((shaped.structuredContent as Brief).fixRequest).toBeUndefined();
  });
});
