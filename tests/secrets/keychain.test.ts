import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jiraToken, readSocketSecret } from "../../src/secrets/keychain.js";
import { PROTOCOL_VERSION } from "../../src/approval/protocol.js";

const original = process.env.SHIPKIT_JIRA_TOKEN;
beforeEach(() => {
  delete process.env.SHIPKIT_JIRA_TOKEN;
});
afterEach(() => {
  if (original === undefined) delete process.env.SHIPKIT_JIRA_TOKEN;
  else process.env.SHIPKIT_JIRA_TOKEN = original;
});

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function socketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "shipkit-secrets-"));
  dirs.push(dir);
  return join(dir, "approvals.sock");
}

/**
 * A listener that replies with whatever `reply` returns for the line it receives,
 * or never replies when `reply` returns null. Mirrors the fake listener in
 * tests/approval/client.test.ts.
 */
function listen(path: string, reply: (line: string) => string | null): Promise<void> {
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const answer = reply(buffer.slice(0, newline));
      if (answer !== null) socket.end(answer);
    });
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(path, () => resolve()));
}

function tokenResponse(secret: string | null): string {
  return `${JSON.stringify({ protocol: PROTOCOL_VERSION, kind: "token", secret })}\n`;
}

describe("readSocketSecret", () => {
  it("returns undefined when nothing is listening", async () => {
    await expect(
      readSocketSecret("jira", { socketPath: socketPath() }),
    ).resolves.toBeUndefined();
  });

  it("sends a request carrying kind:\"token\" and the account, and returns the secret", async () => {
    const path = socketPath();
    let seen = "";
    await listen(path, (line) => {
      seen = line;
      return tokenResponse("s3cret");
    });

    await expect(readSocketSecret("jira", { socketPath: path })).resolves.toBe("s3cret");

    const request = JSON.parse(seen);
    expect(request).toEqual({ protocol: PROTOCOL_VERSION, kind: "token", account: "jira" });
  });

  it("returns undefined when the reply's secret is null", async () => {
    const path = socketPath();
    await listen(path, () => tokenResponse(null));
    await expect(readSocketSecret("jira", { socketPath: path })).resolves.toBeUndefined();
  });

  it("returns undefined for a garbage reply", async () => {
    const path = socketPath();
    await listen(path, () => "not json at all\n");
    await expect(readSocketSecret("jira", { socketPath: path })).resolves.toBeUndefined();
  });

  it("returns undefined for a reply missing the expected shape", async () => {
    const path = socketPath();
    await listen(path, () => `${JSON.stringify({ protocol: PROTOCOL_VERSION })}\n`);
    await expect(readSocketSecret("jira", { socketPath: path })).resolves.toBeUndefined();
  });

  it("returns undefined promptly, not hanging, when the listener never answers", async () => {
    const path = socketPath();
    await listen(path, () => null);

    const start = Date.now();
    await expect(
      readSocketSecret("jira", { socketPath: path, timeoutMs: 120 }),
    ).resolves.toBeUndefined();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
  });

  it("returns undefined when the listener closes without answering", async () => {
    const path = socketPath();
    const server = createServer((socket) => {
      socket.resume();
      socket.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(path, () => resolve()));

    await expect(readSocketSecret("jira", { socketPath: path })).resolves.toBeUndefined();
  });
});

describe("jiraToken", () => {
  it("prefers the environment, so CI and overrides keep working, even with a listener present", async () => {
    process.env.SHIPKIT_JIRA_TOKEN = "from-env";
    const path = socketPath();
    await listen(path, () => tokenResponse("from-socket"));

    await expect(jiraToken({ socketPath: path })).resolves.toBe("from-env");
  });

  it("falls back to the socket when the environment is unset", async () => {
    const path = socketPath();
    await listen(path, () => tokenResponse("from-socket"));
    await expect(jiraToken({ socketPath: path })).resolves.toBe("from-socket");
  });

  it("treats an empty environment variable as absent", async () => {
    process.env.SHIPKIT_JIRA_TOKEN = "";
    const path = socketPath();
    await listen(path, () => tokenResponse("from-socket"));
    await expect(jiraToken({ socketPath: path })).resolves.toBe("from-socket");
  });

  // SHIPKIT_JIRA_TOKEN=" " is not a token either. Reaching Jira with it would fail the
  // fetch and, upstream in runSubmit, turn into a JiraError that aborts the whole submit —
  // instead of degrading to issue-unverified the way a genuinely unset variable does.
  it("treats a whitespace-only environment variable as absent", async () => {
    process.env.SHIPKIT_JIRA_TOKEN = "   ";
    const path = socketPath();
    await listen(path, () => tokenResponse("from-socket"));
    await expect(jiraToken({ socketPath: path })).resolves.toBe("from-socket");
  });

  it("is undefined when neither the environment nor the socket has one", async () => {
    await expect(jiraToken({ socketPath: socketPath() })).resolves.toBeUndefined();
  });
});
