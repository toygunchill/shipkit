import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/mcp/server.js";
import type { ToolDeps } from "../../src/mcp/tools.js";
import { loadConfig } from "../../src/config/load.js";
import type { SubmitDeps, SubmitOptions, SubmitResult } from "../../src/submit/run.js";

const CONFIG = loadConfig("tests/fixtures/valid.shipkit.yml");

function fakeDeps(seen: SubmitOptions[]): ToolDeps {
  return {
    submitDeps: () => ({}) as SubmitDeps,
    loadConfig: () => CONFIG,
    readRepoState: () => ({ branch: "bugfix/x/1-y", changedFiles: [], diffstat: "", commits: [] }),
    runSubmit: async (options: SubmitOptions) => {
      seen.push(options);
      return {
        code: 0, findings: [], warnings: [], body: "## Summary\n\ns\n",
        url: "https://example.com/pr/1", updated: false, committed: true, pushed: true,
      } satisfies SubmitResult;
    },
  };
}

async function connect(seen: SubmitOptions[]) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(fakeDeps(seen));
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("the MCP server", () => {
  it("offers exactly the three tools", async () => {
    const client = await connect([]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "shipkit_apply",
      "shipkit_brief",
      "shipkit_preview",
    ]);
  });

  // The description is the only thing that tells an agent when to reach for the tool. A
  // registered tool nobody knows to call is the problem this whole design exists to fix.
  it("describes every tool", async () => {
    const client = await connect([]);
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.description ?? "").not.toBe("");
    }
  });

  // The spec said a missing base should come back naming the plausible targets. It is a
  // required schema field instead, and the description carries the instruction: the choice
  // depends on release timing, so it belongs to the human, and handing an agent a list to
  // pick from invites it to pick. A schema error plus "ask" is the honest shape.
  it("tells the caller to ask which branch to target rather than choosing one", async () => {
    const client = await connect([]);
    const { tools } = await client.listTools();
    const brief = tools.find((t) => t.name === "shipkit_brief");
    expect(brief?.description ?? "").toContain("Ask");
  });

  it("requires repo and base on every tool", async () => {
    const client = await connect([]);
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.inputSchema.required).toContain("repo");
      expect(tool.inputSchema.required).toContain("base");
    }
  });

  it("routes a preview call through to the core in preview mode", async () => {
    const seen: SubmitOptions[] = [];
    const client = await connect(seen);

    await client.callTool({
      name: "shipkit_preview",
      arguments: {
        repo: "/repo", base: "develop",
        title: "[ABC-1] fix(x): y", commitMessage: "fix(x): y",
        sections: { Summary: "s" },
      },
    });

    expect(seen[0].mode).toBe("preview");
  });

  it("rejects a call that omits a required argument", async () => {
    const client = await connect([]);
    const result = await client.callTool({
      name: "shipkit_preview",
      arguments: { repo: "/repo" },
    });
    expect(result.isError).toBe(true);
  });
});
