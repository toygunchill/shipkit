import { describe, expect, it } from "vitest";
import { shouldRequestApproval } from "../../src/approval/policy.js";
import type { Warning } from "../../src/preflight/types.js";
import type { Advice } from "../../src/advice/types.js";

describe("advice", () => {
  // The whole design rests on this: advice must never gate a push. Under
  // `pr.approval: human` any unacknowledged warning asks a person, so advice
  // modelled as a Warning would prompt on every conversion it merely wanted
  // to mention.
  //
  // `@ts-expect-error` is the assertion, not decoration: it fails compilation
  // if the assignment ever becomes legal, so `npm run check` is what holds the
  // two types apart. Comparing field names instead would pass just as happily
  // on the day someone gives Advice a `check`.
  it("cannot be passed where a warning is expected", () => {
    const advice: Advice = { topic: "uikit-to-swiftui", message: "…" };
    // @ts-expect-error Advice has no `check`, and must never acquire one.
    const asWarning: Warning = advice;
    void asWarning;
    expect(advice.topic).toBe("uikit-to-swiftui");
  });

  it("leaves the approval gate shut when there are no warnings", () => {
    expect(shouldRequestApproval({ policy: "human", warnings: [], acknowledge: [] })).toBe(false);
  });
});
