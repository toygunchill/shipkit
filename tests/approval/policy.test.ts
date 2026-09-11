import { describe, expect, it } from "vitest";
import { gate, shouldRequestApproval, unacknowledged } from "../../src/approval/policy.js";
import type { Warning } from "../../src/preflight/types.js";

const W: Warning[] = [
  { check: "untracked-files", message: "one file" },
  { check: "blocking-label", message: "in test" },
];

describe("unacknowledged", () => {
  it("is empty for \"all\"", () => {
    expect(unacknowledged(W, "all")).toEqual([]);
  });

  it("names the ones not echoed back", () => {
    expect(unacknowledged(W, ["untracked-files"]).map((w) => w.check)).toEqual(["blocking-label"]);
  });

  it("ignores ids that are not among the warnings", () => {
    expect(unacknowledged(W, ["base-mismatch"])).toHaveLength(2);
  });
});

describe("shouldRequestApproval", () => {
  it("is false when there is nothing to warn about", () => {
    expect(shouldRequestApproval({ policy: "human", warnings: [], acknowledge: [] })).toBe(false);
  });

  it("is true under echo when the ids do not cover the warnings", () => {
    expect(shouldRequestApproval({ policy: "echo", warnings: W, acknowledge: [] })).toBe(true);
  });

  it("is false under echo when they do", () => {
    expect(shouldRequestApproval({ policy: "echo", warnings: W, acknowledge: "all" })).toBe(false);
  });

  // The whole point of the policy: under human, an agent echoing ids does not
  // remove the need for a person.
  it("is true under human even when every id was echoed", () => {
    expect(shouldRequestApproval({ policy: "human", warnings: W, acknowledge: "all" })).toBe(true);
  });
});

describe("gate", () => {
  it("opens when there are no warnings at all", () => {
    expect(gate({ policy: "human", warnings: [], acknowledge: [] })).toEqual({ open: true });
  });

  it("opens under echo when the ids cover the warnings", () => {
    expect(gate({ policy: "echo", warnings: W, acknowledge: "all" })).toEqual({ open: true });
  });

  it("refuses under echo when they do not, naming which", () => {
    const result = gate({ policy: "echo", warnings: W, acknowledge: ["untracked-files"] });
    expect(result).toEqual({
      open: false,
      reason: "unacknowledged",
      unacknowledged: [W[1]],
    });
  });

  it("opens when a person approved", () => {
    expect(gate({ policy: "human", warnings: W, acknowledge: [], outcome: "approved" })).toEqual({
      open: true,
    });
  });

  it("opens under echo when a person approved", () => {
    expect(gate({ policy: "echo", warnings: W, acknowledge: [], outcome: "approved" })).toEqual({
      open: true,
    });
  });

  it("refuses when a person denied", () => {
    const result = gate({ policy: "echo", warnings: W, acknowledge: [], outcome: "denied" });
    expect(result.open).toBe(false);
    expect(result).toMatchObject({ reason: "denied" });
  });

  it("refuses under human when a person denied", () => {
    const result = gate({ policy: "human", warnings: W, acknowledge: [], outcome: "denied" });
    expect(result.open).toBe(false);
    expect(result).toMatchObject({ reason: "denied" });
  });

  it("refuses when the wait ran out", () => {
    const result = gate({ policy: "echo", warnings: W, acknowledge: [], outcome: "timed-out" });
    expect(result).toMatchObject({ open: false, reason: "timed-out" });
  });

  it("refuses under human when the wait ran out", () => {
    const result = gate({ policy: "human", warnings: W, acknowledge: [], outcome: "timed-out" });
    expect(result).toMatchObject({ open: false, reason: "timed-out" });
  });

  // The property that keeps the application optional: with nothing listening,
  // echo falls back to exactly today's refusal.
  it("falls back to the echo refusal when no surface is running", () => {
    const result = gate({ policy: "echo", warnings: W, acknowledge: [], outcome: "no-surface" });
    expect(result).toMatchObject({ open: false, reason: "unacknowledged" });
    expect(result.open === false && result.unacknowledged).toHaveLength(2);
  });

  // The echo fallback also means that with nothing listening and the ids covering
  // the warnings, echo opens exactly as it did before any of this existed.
  it("opens under echo when no surface is running but the ids cover the warnings", () => {
    const result = gate({ policy: "echo", warnings: W, acknowledge: "all", outcome: "no-surface" });
    expect(result).toEqual({ open: true });
  });

  // And the same situation under human is a different refusal, because the
  // remedy is different: start the application, not echo more ids.
  it("says the surface is required when no surface is running under human", () => {
    const result = gate({ policy: "human", warnings: W, acknowledge: "all", outcome: "no-surface" });
    expect(result).toMatchObject({ open: false, reason: "no-surface" });
  });

  // An echoed id must not open the gate under human even when no approval was
  // sought — otherwise the policy is decorative.
  it("refuses under human when no approval was sought", () => {
    const result = gate({ policy: "human", warnings: W, acknowledge: "all" });
    expect(result).toMatchObject({ open: false, reason: "human-required" });
  });
});
