import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ApprovalAnswer } from "./policy.js";
import {
  decodeResponse,
  decodeReviewResponse,
  encodeRequest,
  encodeReviewOffer,
  type ApprovalRequest,
  type ReviewOffer,
  type ReviewResponse,
} from "./protocol.js";

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

/**
 * What the menu bar said about a review, or why it said nothing.
 *
 * `no-surface` is not a failure: most people run `shipkit review` with no application
 * installed, and the page is a complete answer on its own. `withdrawn` is the ordinary end of
 * the losing surface — the page was answered first, so this connection was closed.
 */
export type ReviewOfferOutcome =
  | { outcome: "answered"; response: ReviewResponse }
  | { outcome: "no-surface" }
  | { outcome: "withdrawn" }
  | { outcome: "failed"; detail: string };

/**
 * Offers a running review to the menu bar and waits for an answer.
 *
 * Never throws, and never times out on its own. The timeout belongs to `runReview`, which is
 * already racing this against the page and against its own ten minutes; a second timer here
 * would be a second deadline nobody set and nobody could see.
 *
 * Returns a `cancel` so the winning surface can close the losing one. The application
 * notices the peer going away and withdraws the review from the panel without asking anyone
 * anything — see docs/superpowers/specs/2026-09-18-shipkit-review-on-the-panel.md.
 */
export function offerReview(
  offer: ReviewOffer,
  options: { socketPath?: string } = {},
): { answer: Promise<ReviewOfferOutcome>; cancel: () => void } {
  const path = options.socketPath ?? defaultSocketPath();
  let cancel = (): void => undefined;

  const answer = new Promise<ReviewOfferOutcome>((resolve) => {
    let settled = false;
    let buffer = "";
    let cancelled = false;

    const socket = createConnection({ path });

    const finish = (result: ReviewOfferOutcome) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    cancel = () => {
      cancelled = true;
      finish({ outcome: "withdrawn" });
    };

    socket.on("connect", () => {
      socket.write(encodeReviewOffer(offer));
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        finish({
          outcome: "answered",
          response: decodeReviewResponse(buffer.slice(0, newline), offer.fingerprint),
        });
      } catch (error) {
        finish({ outcome: "failed", detail: error instanceof Error ? error.message : String(error) });
      }
    });

    // ENOENT when there is no socket, ECONNREFUSED when it is stale. Both mean nobody is
    // home, which is the ordinary case and not a failure.
    socket.on("error", () => finish({ outcome: "no-surface" }));

    // Closed without a full line. Either the application went away, or this very call closed
    // it because the page won — and those want different words, since only one of them is
    // something going wrong.
    socket.on("close", () =>
      finish(cancelled ? { outcome: "withdrawn" } : { outcome: "failed", detail: "the approval surface closed the connection" }),
    );
  });

  return { answer, cancel };
}
