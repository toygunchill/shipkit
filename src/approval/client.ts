import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ApprovalAnswer } from "./policy.js";
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
 * permission. When decoding failed, `detail` carries why — in particular a
 * protocol version disagreement, which would otherwise be indistinguishable
 * from an actual denial.
 */
export function requestApproval(
  request: ApprovalRequest,
  options: { socketPath?: string; timeoutMs?: number } = {},
): Promise<ApprovalAnswer> {
  const path = options.socketPath ?? defaultSocketPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<ApprovalAnswer>((resolve) => {
    let settled = false;
    let buffer = "";

    const socket = createConnection({ path });

    const finish = (answer: ApprovalAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };

    const timer = setTimeout(() => finish({ outcome: "timed-out" }), timeoutMs);
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
        finish({ outcome: response.decision === "pending" ? "timed-out" : response.decision });
      } catch (error) {
        // decodeResponse only ever throws ProtocolError, whose message already names the
        // exact disagreement (a stale protocol version, a malformed line, an answer for a
        // different request) — carried through as `detail` rather than swallowed, so the
        // one case that most needs telling apart from an actual denial is not lost.
        finish({ outcome: "denied", detail: error instanceof Error ? error.message : String(error) });
      }
    });

    // ENOENT when the file is not there, ECONNREFUSED when it is stale. Both
    // mean the same thing to the caller: nobody is home.
    socket.on("error", () => finish({ outcome: "no-surface" }));

    // Closed without a full line. Not an answer, so not permission.
    socket.on("close", () => finish({ outcome: "denied" }));
  });
}
