import { describe, expect, it } from "vitest";
import {
  decodeResponse,
  encodeRequest,
  PROTOCOL_VERSION,
  ProtocolError,
  type ApprovalRequest,
} from "../../src/approval/protocol.js";

const FP = "a".repeat(64);

const REQUEST: ApprovalRequest = {
  protocol: PROTOCOL_VERSION,
  fingerprint: FP,
  repo: "/Users/x/example-app",
  branch: "bugfix/squad/31087-invoice",
  base: "release/3.76.0",
  head: "a44dcf5d9f8a0c59fb282d667cfab5e1e809d6bd",
  title: "fix(invoice): default citizenship from passenger info",
  commitMessage: "fix(invoice): default citizenship from passenger info",
  diffstat: "12 files changed, 148 insertions(+), 37 deletions(-)",
  warnings: [{ check: "blocking-label", message: "Label(s) in test will block the merge gate" }],
};

describe("encodeRequest", () => {
  it("emits exactly one newline-terminated line", () => {
    const line = encodeRequest(REQUEST);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd().split("\n")).toHaveLength(1);
  });

  it("round-trips through JSON unchanged", () => {
    expect(JSON.parse(encodeRequest(REQUEST))).toEqual(REQUEST);
  });

  // A multi-line commit message is ordinary and would break line framing if it
  // were not escaped by the JSON encoder.
  it("keeps a multi-line commit message on one line", () => {
    const multi = { ...REQUEST, commitMessage: "subject\n\nbody line one\nbody line two" };
    const line = encodeRequest(multi);
    expect(line.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(line).commitMessage).toBe(multi.commitMessage);
  });
});

describe("decodeResponse", () => {
  const ok = JSON.stringify({ protocol: PROTOCOL_VERSION, fingerprint: FP, decision: "approved" });

  it("reads a well-formed response", () => {
    expect(decodeResponse(ok, FP).decision).toBe("approved");
  });

  it("accepts denied and pending", () => {
    for (const decision of ["denied", "pending"] as const) {
      const line = JSON.stringify({ protocol: PROTOCOL_VERSION, fingerprint: FP, decision });
      expect(decodeResponse(line, FP).decision).toBe(decision);
    }
  });

  it("throws ProtocolError for unparseable input", () => {
    expect(() => decodeResponse("{", FP)).toThrow(ProtocolError);
  });

  it("throws ProtocolError for an unknown decision", () => {
    const line = JSON.stringify({ protocol: PROTOCOL_VERSION, fingerprint: FP, decision: "maybe" });
    expect(() => decodeResponse(line, FP)).toThrow(ProtocolError);
  });

  // A reply about some other request is not an answer to this one. Treating it
  // as one is how an approval for a situation nobody looked at gets used.
  it("throws ProtocolError when the fingerprint is not the expected one", () => {
    const line = JSON.stringify({
      protocol: PROTOCOL_VERSION,
      fingerprint: "b".repeat(64),
      decision: "approved",
    });
    expect(() => decodeResponse(line, FP)).toThrow(ProtocolError);
  });

  it("names both versions when they disagree", () => {
    const line = JSON.stringify({ protocol: 99, fingerprint: FP, decision: "approved" });
    expect(() => decodeResponse(line, FP)).toThrow(/99/);
    expect(() => decodeResponse(line, FP)).toThrow(new RegExp(String(PROTOCOL_VERSION)));
  });

  // When both version and fingerprint are wrong, version error is reported because
  // version disagreement explains fingerprint mismatch. Swapping the check order
  // would report fingerprint instead, sending the reader after a symptom.
  it("reports version disagreement over fingerprint mismatch when both are wrong", () => {
    const line = JSON.stringify({
      protocol: 99,
      fingerprint: "b".repeat(64),
      decision: "approved",
    });
    expect(() => decodeResponse(line, FP)).toThrow(/99/);
    expect(() => decodeResponse(line, FP)).toThrow(new RegExp(String(PROTOCOL_VERSION)));
    expect(() => decodeResponse(line, FP)).not.toThrow(/different request/);
  });
});
