import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requestApproval } from "../../src/approval/client.js";
import { PROTOCOL_VERSION, type ApprovalRequest } from "../../src/approval/protocol.js";

const FP = "a".repeat(64);

const REQUEST: ApprovalRequest = {
  protocol: PROTOCOL_VERSION,
  fingerprint: FP,
  repo: "/Users/x/example-app",
  branch: "bugfix/squadb/31087-invoice",
  base: "release/3.76.0",
  head: "a44dcf5d9f8a0c59fb282d667cfab5e1e809d6bd",
  title: "fix(invoice): default citizenship",
  commitMessage: "fix(invoice): default citizenship",
  diffstat: "12 files changed",
  warnings: [{ check: "blocking-label", message: "in test" }],
};

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function socketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "shipkit-approval-"));
  dirs.push(dir);
  return join(dir, "approvals.sock");
}

/**
 * A listener that replies with whatever `reply` returns, or never replies.
 *
 * `reply` can throw (one test uses this to simulate a listener that explodes).
 * An exception raised inside a socket `data` handler is uncaught by Node and
 * would take the whole test process down, which would not exercise the
 * client under test at all. So the throw is caught here and treated as the
 * listener misbehaving by dropping the connection — the client still has to
 * produce an outcome rather than reject.
 */
function listen(path: string, reply: (line: string) => string | null): Promise<void> {
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const answer = reply(buffer.slice(0, newline));
        if (answer !== null) socket.end(answer);
      } catch {
        socket.destroy();
      }
    });
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(path, () => resolve()));
}

function response(decision: string, fingerprint = FP): string {
  return `${JSON.stringify({ protocol: PROTOCOL_VERSION, fingerprint, decision })}\n`;
}

describe("requestApproval", () => {
  it("returns no-surface when nothing is listening", async () => {
    await expect(requestApproval(REQUEST, { socketPath: socketPath() })).resolves.toBe(
      "no-surface",
    );
  });

  it("sends the request and returns the decision", async () => {
    const path = socketPath();
    let seen = "";
    await listen(path, (line) => {
      seen = line;
      return response("approved");
    });

    await expect(requestApproval(REQUEST, { socketPath: path })).resolves.toBe("approved");
    expect(JSON.parse(seen)).toEqual(REQUEST);
  });

  it("returns denied when a person denied", async () => {
    const path = socketPath();
    await listen(path, () => response("denied"));
    await expect(requestApproval(REQUEST, { socketPath: path })).resolves.toBe("denied");
  });

  it("returns timed-out when the listener never answers", async () => {
    const path = socketPath();
    await listen(path, () => null);
    await expect(requestApproval(REQUEST, { socketPath: path, timeoutMs: 120 })).resolves.toBe(
      "timed-out",
    );
  });

  // `pending` means the person has not decided yet. From the caller's side that
  // is the same situation as running out of time, and collapsing them keeps the
  // caller from having to handle a state it cannot act on.
  it("treats a pending response as timed-out", async () => {
    const path = socketPath();
    await listen(path, () => response("pending"));
    await expect(requestApproval(REQUEST, { socketPath: path })).resolves.toBe("timed-out");
  });

  // Anything it cannot understand fails closed. An approval is permission to
  // push, and a garbled line is not permission.
  it("returns denied for a malformed response", async () => {
    const path = socketPath();
    await listen(path, () => "{\n");
    await expect(requestApproval(REQUEST, { socketPath: path })).resolves.toBe("denied");
  });

  it("returns denied for a response about a different request", async () => {
    const path = socketPath();
    await listen(path, () => response("approved", "b".repeat(64)));
    await expect(requestApproval(REQUEST, { socketPath: path })).resolves.toBe("denied");
  });

  it("returns denied when the listener speaks another protocol version", async () => {
    const path = socketPath();
    await listen(path, () =>
      `${JSON.stringify({ protocol: 99, fingerprint: FP, decision: "approved" })}\n`,
    );
    await expect(requestApproval(REQUEST, { socketPath: path })).resolves.toBe("denied");
  });

  it("never throws, whatever the listener does", async () => {
    const path = socketPath();
    await listen(path, () => {
      throw new Error("listener exploded");
    });
    await expect(requestApproval(REQUEST, { socketPath: path, timeoutMs: 120 })).resolves.toBeTypeOf(
      "string",
    );
  });
});
