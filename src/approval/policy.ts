import type { Warning } from "../preflight/types.js";
import type { Acknowledgement } from "../submit/run.js";

export type ApprovalPolicy = "echo" | "human";

/** What came back from asking a person, including not being able to ask. */
export type ApprovalOutcome = "approved" | "denied" | "timed-out" | "no-surface";

/**
 * What `requestApproval` resolves with. `detail` carries the reason behind an outcome the
 * bare enum cannot explain on its own — chiefly a protocol version disagreement, which
 * `decodeResponse` reports precisely but which collapses to a plain "denied" outcome. Without
 * a place to carry it, the one thing the caller most needs to know — that a version is stale,
 * not that a person refused — is lost.
 */
export type ApprovalAnswer = { outcome: ApprovalOutcome; detail?: string };

export type GateReason =
  | "unacknowledged"
  | "denied"
  | "timed-out"
  | "no-surface"
  | "human-required";

export type GateResult =
  | { open: true }
  | { open: false; reason: GateReason; unacknowledged: Warning[] };

export function unacknowledged(warnings: Warning[], acknowledge: Acknowledgement): Warning[] {
  if (acknowledge === "all") return [];
  if (!Array.isArray(acknowledge)) return warnings;
  return warnings.filter((warning) => !acknowledge.includes(warning.check));
}

/**
 * Under `echo`, a person is asked only when the agent did not cover the
 * warnings itself. Under `human`, a person is always asked — echoed ids do not
 * remove the need for one, which is the entire difference between the two.
 */
export function shouldRequestApproval(input: {
  policy: ApprovalPolicy;
  warnings: Warning[];
  acknowledge: Acknowledgement;
}): boolean {
  if (input.warnings.length === 0) return false;
  if (input.policy === "human") return true;
  return unacknowledged(input.warnings, input.acknowledge).length > 0;
}

export function gate(input: {
  policy: ApprovalPolicy;
  warnings: Warning[];
  acknowledge: Acknowledgement;
  outcome?: ApprovalOutcome;
}): GateResult {
  if (input.warnings.length === 0) return { open: true };

  const open = unacknowledged(input.warnings, input.acknowledge);

  if (input.outcome === "approved") return { open: true };
  if (input.outcome === "denied") {
    return { open: false, reason: "denied", unacknowledged: open };
  }
  if (input.outcome === "timed-out") {
    return { open: false, reason: "timed-out", unacknowledged: open };
  }

  // Nothing was listening. Under echo that is not a failure: the agent's own
  // acknowledgement still decides, exactly as it did before any of this
  // existed. Under human it is, and the remedy is to start the application
  // rather than to echo more ids — a different refusal, because it needs a
  // different sentence.
  if (input.outcome === "no-surface") {
    if (input.policy === "human") {
      return { open: false, reason: "no-surface", unacknowledged: open };
    }
    return open.length > 0
      ? { open: false, reason: "unacknowledged", unacknowledged: open }
      : { open: true };
  }

  // No approval was sought.
  if (input.policy === "human") {
    return { open: false, reason: "human-required", unacknowledged: open };
  }
  return open.length > 0
    ? { open: false, reason: "unacknowledged", unacknowledged: open }
    : { open: true };
}
