import { describe, expect, it } from "vitest";
import { configPath, handleApply, handleBrief, handlePreview } from "../../src/mcp/tools.js";
import type { ToolDeps } from "../../src/mcp/tools.js";
import { loadConfig } from "../../src/config/load.js";
import type { SubmitOptions, SubmitResult, SubmitDeps } from "../../src/submit/run.js";

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
