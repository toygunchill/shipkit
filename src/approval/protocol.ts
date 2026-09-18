import { z } from "zod";
import type { Warning } from "../preflight/types.js";

export const PROTOCOL_VERSION = 1;

export class ProtocolError extends Error {}

export type ApprovalRequest = {
  protocol: number;
  fingerprint: string;
  repo: string;
  branch: string;
  base: string;
  head: string;
  title: string;
  commitMessage: string;
  diffstat: string;
  warnings: Warning[];
};

const responseSchema = z.object({
  protocol: z.number(),
  fingerprint: z.string().min(1),
  decision: z.enum(["approved", "denied", "pending"]),
});

export type ApprovalResponse = z.infer<typeof responseSchema>;

/** One request per connection, on one line. JSON escapes any newline a commit message carries. */
export function encodeRequest(request: ApprovalRequest): string {
  return `${JSON.stringify(request)}\n`;
}

export function decodeResponse(line: string, expectedFingerprint: string): ApprovalResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ProtocolError(`Cannot parse the approval response: ${detail}`);
  }

  const result = responseSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new ProtocolError(`Malformed approval response: ${detail}`);
  }

  // Version before fingerprint: a version disagreement explains a fingerprint
  // mismatch, and reporting the symptom would send the reader the wrong way.
  if (result.data.protocol !== PROTOCOL_VERSION) {
    throw new ProtocolError(
      `The approval surface speaks protocol ${result.data.protocol}; this shipkit speaks ${PROTOCOL_VERSION}`,
    );
  }

  // A reply about some other request is not an answer to this one.
  if (result.data.fingerprint !== expectedFingerprint) {
    throw new ProtocolError("The approval response is for a different request");
  }

  return result.data;
}

/**
 * A review offered to the menu bar while `shipkit review` is also serving its page.
 *
 * `kind` is what tells this apart from an approval on the wire. The convention is already
 * there and already tested: an approval request carries no `kind`, a Keychain token request
 * carries `kind: "token"`. So a third kind needs no version bump and no compatibility story.
 *
 * The diff is deliberately not here. A popover is the wrong shape for four hundred files,
 * the page is one click away, and `files` carries what the panel actually needs — a row per
 * file with a button that opens it where a person can read it properly.
 */
export type OfferedItem = {
  kind: string;
  id: string;
  message: string;
  severity: "refuses" | "warns" | "informs";
};

export type OfferedFile = {
  path: string;
  status: string;
  /** Where to put the cursor when the editor opens. 1 when nothing better is known. */
  line: number;
};

export type ReviewOffer = {
  protocol: number;
  kind: "review";
  fingerprint: string;
  repo: string;
  /** The checkout's absolute path. The panel's editor button resolves against it. */
  root: string;
  /** shipkit's own review page, token and all. The panel's primary action opens it. */
  url: string;
  branch: string;
  base: string;
  /** Empty when the review is running without an agent's answer. */
  commitMessage: string;
  diffstat: string;
  items: OfferedItem[];
  files: OfferedFile[];
};

const selectedItemSchema = z.object({
  // The same five kinds `FixRequestKind` has. `comment` cannot come from the panel today —
  // the offer carries no diff for anyone to write on — but the two lists are one contract,
  // and letting them drift would mean a selection this shipkit writes is one it could not
  // then read back.
  kind: z.enum(["warning", "finding", "readiness", "advice", "comment"]),
  id: z.string().min(1),
  message: z.string(),
  note: z.string(),
});

const reviewResponseSchema = z.object({
  protocol: z.number(),
  kind: z.literal("review"),
  fingerprint: z.string().min(1),
  /**
   * `selected` carries items; `nothing` is a person saying they read it and it is fine.
   *
   * Two answers rather than one with an empty list, because the difference is what the
   * command does next: an empty selection clears whatever was pending, and that is a
   * decision, not the absence of one.
   */
  answer: z.enum(["selected", "nothing"]),
  items: z.array(selectedItemSchema),
});

export type ReviewResponse = z.infer<typeof reviewResponseSchema>;

export function encodeReviewOffer(offer: ReviewOffer): string {
  return `${JSON.stringify(offer)}\n`;
}

export function decodeReviewResponse(line: string, expectedFingerprint: string): ReviewResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ProtocolError(`Cannot parse the review response: ${detail}`);
  }

  const result = reviewResponseSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new ProtocolError(`Malformed review response: ${detail}`);
  }

  // Version before fingerprint, for the reason `decodeResponse` gives: a version
  // disagreement explains a fingerprint mismatch, and reporting the symptom would send the
  // reader the wrong way.
  if (result.data.protocol !== PROTOCOL_VERSION) {
    throw new ProtocolError(
      `The approval surface speaks protocol ${result.data.protocol}; this shipkit speaks ${PROTOCOL_VERSION}`,
    );
  }

  if (result.data.fingerprint !== expectedFingerprint) {
    throw new ProtocolError("The review response is for a different review");
  }

  // An answer of `nothing` that carries items is a surface contradicting itself, and the two
  // readings lead opposite ways — write these, or clear what is pending. Refused rather than
  // guessed.
  if (result.data.answer === "nothing" && result.data.items.length > 0) {
    throw new ProtocolError("The review response says nothing was selected but carries items");
  }

  return result.data;
}
