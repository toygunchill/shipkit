import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { realToolDeps } from "../../src/mcp/server.js";
import { FIX_REQUEST_PATH } from "../../src/review/fixrequest.js";

/**
 * The dependency object the real MCP server hands to `runSubmit`.
 *
 * `fixRequestExclusions` and `archiveFixRequest` are optional on `SubmitDeps`, so leaving
 * them out type-checked in silence — and did. Without the first, `commitAll` ran
 * `git add --all` with nothing excluded and committed and pushed
 * `.shipkit/fix-request.json`: a person's private notes about what is wrong with their own
 * change, published. Without the second, a selection the agent had acted on was never
 * consumed, so every later brief asked for the same fixes again.
 *
 * Nothing here runs a submit. The deps are built and the two closures are inspected; only
 * the exclusion closure is called, because it reads and the other one writes — into the real
 * Application Support, which no test may touch.
 */
const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "shipkit-mcp-deps-")));
  tempDirs.push(root);
  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
  };
  git(["init", "-q", "-b", "main", "."]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(root, "a.txt"), "one\n", "utf8");
  git(["add", "--all"]);
  git(["commit", "-qm", "seed"]);
  return root;
}

describe("the deps the MCP server really submits with", () => {
  it("excludes the review selection from the commit", () => {
    const root = repo();
    mkdirSync(join(root, ".shipkit"), { recursive: true });
    writeFileSync(join(root, FIX_REQUEST_PATH), "{}\n", "utf8");

    const deps = realToolDeps().submitDeps(root, join(root, ".shipkit.yml"));

    expect(deps.fixRequestExclusions?.()).toEqual([FIX_REQUEST_PATH]);
  });

  it("excludes nothing in a repository nobody has reviewed", () => {
    const deps = realToolDeps().submitDeps(repo(), "/repo/.shipkit.yml");

    expect(deps.fixRequestExclusions?.()).toEqual([]);
  });

  // Not called: it writes into Application Support, and the behaviour itself is covered in
  // tests/review/fixrequest.test.ts against an injected directory. What is asserted here is
  // the thing that was actually wrong — that it was not wired up at all.
  it("has a way to consume a selection once the push has landed", () => {
    const deps = realToolDeps().submitDeps("/repo", "/repo/.shipkit.yml");

    expect(typeof deps.archiveFixRequest).toBe("function");
  });

  it("can read the selection for a brief", () => {
    const root = repo();
    mkdirSync(join(root, ".shipkit"), { recursive: true });
    writeFileSync(
      join(root, FIX_REQUEST_PATH),
      JSON.stringify({
        version: 1,
        createdAt: "2026-09-17T10:00:00.000Z",
        base: "main",
        branch: "feature/x",
        items: [{ kind: "warning", id: "untracked-files", message: "m", note: "n" }],
      }),
      "utf8",
    );

    expect(realToolDeps().readFixRequest?.(root)?.items).toHaveLength(1);
  });
});
