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
