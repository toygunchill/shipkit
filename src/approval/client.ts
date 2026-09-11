import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ApprovalOutcome } from "./policy.js";
import { decodeResponse, encodeRequest, type ApprovalRequest } from "./protocol.js";

const DEFAULT_TIMEOUT_MS = 120_000;

/** `SHIPKIT_APPROVAL_SOCKET` first, so tests and unusual setups have a way in. */
export function defaultSocketPath(): string {
  const override = process.env.SHIPKIT_APPROVAL_SOCKET;
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), "Library", "Application Support", "shipkit", "approvals.sock");
}

/**
 * Asks the approval surface about one situation and waits for an answer.
 *
 * Never throws. Every failure is an outcome the caller can act on: nothing
 * listening is `no-surface`, which under the default policy is not a failure at
 * all; running out of time is `timed-out`; and anything it cannot understand is
 * `denied`, because an approval is permission to push and a garbled line is not
 * permission.
 */
export function requestApproval(
  request: ApprovalRequest,
  options: { socketPath?: string; timeoutMs?: number } = {},
): Promise<ApprovalOutcome> {
  const path = options.socketPath ?? defaultSocketPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<ApprovalOutcome>((resolve) => {
    let settled = false;
    let buffer = "";

    const socket = createConnection({ path });

    const finish = (outcome: ApprovalOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };

    const timer = setTimeout(() => finish("timed-out"), timeoutMs);
    // The timer must not hold the process open on its own; the socket is what
    // this call is waiting for.
    timer.unref?.();

    socket.on("connect", () => {
      socket.write(encodeRequest(request));
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const response = decodeResponse(buffer.slice(0, newline), request.fingerprint);
        finish(response.decision === "pending" ? "timed-out" : response.decision);
      } catch {
        finish("denied");
      }
    });

    // ENOENT when the file is not there, ECONNREFUSED when it is stale. Both
    // mean the same thing to the caller: nobody is home.
    socket.on("error", () => finish("no-surface"));

    // Closed without a full line. Not an answer, so not permission.
    socket.on("close", () => finish("denied"));
  });
}
