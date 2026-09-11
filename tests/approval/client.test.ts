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
    await expect(requestApproval(REQUEST, { socketPath: socketPath() })).resolves.toEqual({
      outcome: "no-surface",
    });
  });

  it("sends the request and returns the decision", async () => {
    const path = socketPath();
    let seen = "";
    await listen(path, (line) => {
      seen = line;
      return response("approved");
    });

    await expect(requestApproval(REQUEST, { socketPath: path })).resolves.toEqual({
      outcome: "approved",
    });
    expect(JSON.parse(seen)).toEqual(REQUEST);
  });

  it("returns denied when a person denied", async () => {
    const path = socketPath();
    await listen(path, () => response("denied"));
    await expect(requestApproval(REQUEST, { socketPath: path })).resolves.toEqual({
      outcome: "denied",
    });
  });

  it("returns timed-out when the listener never answers", async () => {
    const path = socketPath();
    await listen(path, () => null);
    await expect(
      requestApproval(REQUEST, { socketPath: path, timeoutMs: 120 }),
    ).resolves.toEqual({ outcome: "timed-out" });
  });

  // `pending` means the person has not decided yet. From the caller's side that
  // is the same situation as running out of time, and collapsing them keeps the
  // caller from having to handle a state it cannot act on.
  it("treats a pending response as timed-out", async () => {
    const path = socketPath();
    await listen(path, () => response("pending"));
    await expect(requestApproval(REQUEST, { socketPath: path })).resolves.toEqual({
      outcome: "timed-out",
    });
  });

  // Anything it cannot understand fails closed. An approval is permission to push, and a
  // garbled line is not permission — but `detail` still carries `decodeResponse`'s own
  // message, so a decode failure is not reported identically to an actual denial.
  it("returns denied for a malformed response, with the parse failure as detail", async () => {
    const path = socketPath();
    await listen(path, () => "{\n");
    const result = await requestApproval(REQUEST, { socketPath: path });
    expect(result.outcome).toBe("denied");
    expect(result.detail).toContain("Cannot parse");
  });

  it("returns denied for a response about a different request, naming the mismatch", async () => {
    const path = socketPath();
    await listen(path, () => response("approved", "b".repeat(64)));
    const result = await requestApproval(REQUEST, { socketPath: path });
    expect(result.outcome).toBe("denied");
    expect(result.detail).toBe("The approval response is for a different request");
  });

  // The one case this finding exists for: a version disagreement must not collapse into an
  // indistinguishable "denied" — the detail has to name both protocol numbers so the reader
  // learns a version is stale rather than believing a person refused.
  it("returns denied with a detail naming both protocol versions when the listener speaks a different one", async () => {
    const path = socketPath();
    await listen(path, () =>
      `${JSON.stringify({ protocol: 99, fingerprint: FP, decision: "approved" })}\n`,
    );
    const result = await requestApproval(REQUEST, { socketPath: path });
    expect(result.outcome).toBe("denied");
    expect(result.detail).toBe(
      `The approval surface speaks protocol 99; this shipkit speaks ${PROTOCOL_VERSION}`,
    );
  });

  it("never throws, whatever the listener does", async () => {
    const path = socketPath();
    await listen(path, () => {
      throw new Error("listener exploded");
    });
    await expect(
      requestApproval(REQUEST, { socketPath: path, timeoutMs: 120 }),
    ).resolves.toEqual(expect.objectContaining({ outcome: expect.any(String) }));
  });

  // A listener that accepted the connection and then hung up without ever
  // writing an answer is not the same situation as nobody being home: an
  // application is present, it just didn't say yes. `no-surface` under the
  // `echo` policy can let a push through on the caller's own acknowledgement;
  // `denied` never can. Collapsing this into `no-surface` would let a
  // listener dodge the decision entirely just by closing early.
  it("returns denied when the listener closes the connection without answering", async () => {
    const path = socketPath();
    const server = createServer((socket) => {
      // Drain and discard whatever the client sends. Without this the
      // client's request sits unread and the socket's readable side never
      // reaches "end", which would leave the connection half-open and hang
      // `server.close()` in `afterEach` — a quirk of Node streams, not of
      // the client under test.
      socket.resume();
      socket.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(path, () => resolve()));

    await expect(requestApproval(REQUEST, { socketPath: path })).resolves.toEqual({
      outcome: "denied",
    });
  });

  // `timeoutMs` is a promise made to the caller, not just an upper bound
  // vitest's own budget happens to cover. A client that waited far longer
  // than asked (or timed out far sooner) would still pass a test that only
  // checked the eventual outcome, so this measures the actual elapsed time.
  it("times out close to the requested timeoutMs, not merely eventually", async () => {
    const path = socketPath();
    await listen(path, () => null);

    const start = Date.now();
    await expect(
      requestApproval(REQUEST, { socketPath: path, timeoutMs: 120 }),
    ).resolves.toEqual({ outcome: "timed-out" });
    const elapsed = Date.now() - start;

    // Comfortably over 120ms to absorb scheduler jitter, comfortably under a
    // second so a timer hardcoded to something else (e.g. 3000ms) still fails.
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(500);
  });
});
