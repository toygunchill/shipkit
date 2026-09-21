# Approval surface, core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a human decision, made against a rendering of the warnings, satisfy `shipkit_apply`'s gate — and let a team require it.

**Architecture:** A pure core — fingerprint, protocol, policy — plus one adapter that speaks a Unix socket. `runSubmit` gains a `requestApproval` dependency; the existing echo gate is untouched under the default policy, and with nothing listening the behaviour is exactly today's. The approval is bound to a hash of the situation and re-derived from fresh facts before anything is pushed.

**Tech Stack:** Node 25, TypeScript strict ESM, `node:net`, `node:crypto`, zod, vitest.

**Spec:** `docs/superpowers/specs/2026-09-11-shipkit-approval-design.md`

**Scope:** this plan is the Node half. The Swift menu-bar application is a separate plan against the same spec, and this one produces the contract it builds to — the protocol, and a checked-in fingerprint fixture.

## Global Constraints

- Node 25 + TypeScript strict, ESM — every local import carries a `.js` extension though the sources are `.ts`.
- `console` belongs to `src/cli.ts` alone. Nothing else under `src/` may write to it, and nothing the MCP server can reach may write to stdout: it is the protocol channel.
- Typed errors (`ConfigError`, `ResponseError`, `VcsError`, `JiraError`) are the only errors crossing a module boundary. No `process.exit` from library code.
- Reasons, not messages. A refusal's wording differs per interface — the CLI has `--yes`, MCP has `acknowledge: [...]`, and now a repository may have neither. The core returns a reason and each caller words it.
- `pr.approval` defaults to `echo`. Every existing repository must behave exactly as it does today.
- With nothing listening on the socket, `echo` behaves exactly as today. This is what keeps the application optional.
- No test may execute a `git` or `gh` mutation against this repository, and no test may call `gh` at all. A test may drive real `git` and a real Unix socket inside a directory from `mkdtempSync`.
- **Never run `shipkit submit`, `node dist/cli.js mcp`, or any MCP tool against this repository.** It holds real work.
- Touch only this repository. Never `acme/example-app` or any pull request.
- Baseline: 273 passing tests, `npm run check` clean. Both must hold at the end of every task.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/approval/fingerprint.ts` | The canonical rendering of a situation, and its hash | 1 |
| `tests/fixtures/fingerprint-vectors.json` | The cross-language contract | 1 |
| `src/approval/protocol.ts` | Request and response shapes, encoding, version check | 2 |
| `src/approval/policy.ts` | Whether to ask, and whether the gate opens | 3 |
| `src/config/schema.ts` | `pr.approval` | 4 |
| `src/vcs/git.ts` | `readHeadSha` | 4 |
| `src/approval/client.ts` | Connect, send, await, time out | 5 |
| `src/submit/run.ts` | The gate consults policy; approval is re-derived before acting | 6 |
| `src/cli.ts`, `src/mcp/server.ts` | Wire the real adapter | 6 |
| `src/secrets/keychain.ts` | Read a secret through `security` | 7 |

Tasks 1–3 are pure and independent of each other. Task 4 is two small additions batched because they are the same shape of work and both are prerequisites for Task 6. Task 7 is independent of everything else and could land first; it is last because it is the smallest.

---

### Task 1: The fingerprint, and the fixture that pins it

The echo gate's real property is that ids are checked against what pre-flight produces *now*. A human decision must keep it, so an approval is bound to a hash of the situation and the hash is re-derived before anything happens.

Two implementations will compute this hash — this one, and the Swift application's, which rejects a request whose fingerprint does not match the fields it was sent. That check is what makes the displayed facts provably the hashed ones. It also means a silent disagreement between the two would be invisible until someone tried to approve something, so the canonical form is length-prefixed rather than escaped, and the fixture is checked in.

**Files:**
- Create: `src/approval/fingerprint.ts`
- Create: `tests/fixtures/fingerprint-vectors.json`
- Test: `tests/approval/fingerprint.test.ts`

**Interfaces:**
- Consumes: `Warning` from `src/preflight/types.js` — `{ check: string; message: string }`.
- Produces:
  - `type Situation = { repo: string; branch: string; base: string; head: string; warnings: Warning[] }`
  - `function canonical(situation: Situation): string`
  - `function fingerprint(situation: Situation): string` — lowercase hex SHA-256 of the canonical form's UTF-8 bytes.

- [ ] **Step 1: Write the failing test**

`tests/approval/fingerprint.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonical, fingerprint, type Situation } from "../../src/approval/fingerprint.js";

const BASE: Situation = {
  repo: "/Users/x/example-app",
  branch: "bugfix/squadb/31087-invoice",
  base: "release/3.76.0",
  head: "a44dcf5d9f8a0c59fb282d667cfab5e1e809d6bd",
  warnings: [
    { check: "approvals-dismissed", message: "Pushing will dismiss 4 approval(s) on #881" },
    { check: "blocking-label", message: 'Label(s) in test will block the merge gate' },
  ],
};

describe("canonical", () => {
  // Length prefixes, not escaping. Two implementations have to agree byte for
  // byte, and a delimiter that can appear inside a message is a disagreement
  // waiting for the first warning that contains one.
  it("prefixes every field with its UTF-8 byte length", () => {
    const form = canonical({ ...BASE, warnings: [] });
    expect(form.split("\n")[0]).toBe("shipkit-approval-v1");
    expect(form).toContain(`${Buffer.byteLength(BASE.repo, "utf8")}:${BASE.repo}`);
  });

  it("counts bytes, not characters", () => {
    const form = canonical({ ...BASE, branch: "bugfix/ödeme", warnings: [] });
    // "bugfix/ödeme" is 12 characters and 13 bytes.
    expect(form).toContain("13:bugfix/ödeme");
  });

  it("states how many warnings follow", () => {
    expect(canonical(BASE)).toContain("\n2\n");
  });

  it("survives a message containing a newline and a colon", () => {
    const nasty = { check: "x", message: "a:1\n5:fake" };
    const form = canonical({ ...BASE, warnings: [nasty] });
    expect(form).toContain(`${Buffer.byteLength(nasty.message, "utf8")}:${nasty.message}`);
  });
});

describe("fingerprint", () => {
  it("is a lowercase hex sha-256", () => {
    expect(fingerprint(BASE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the head commit changes", () => {
    expect(fingerprint({ ...BASE, head: "b".repeat(40) })).not.toBe(fingerprint(BASE));
  });

  // The reason messages are hashed and not only ids: a fifth approval landing
  // while the request waits leaves the id set identical and the situation
  // different.
  it("changes when a warning's message changes but its id does not", () => {
    const fewer = BASE.warnings.map((w) =>
      w.check === "approvals-dismissed"
        ? { ...w, message: "Pushing will dismiss 5 approval(s) on #881" }
        : w,
    );
    expect(fingerprint({ ...BASE, warnings: fewer })).not.toBe(fingerprint(BASE));
  });

  it("changes when a warning is added", () => {
    const more = [...BASE.warnings, { check: "untracked-files", message: "one file" }];
    expect(fingerprint({ ...BASE, warnings: more })).not.toBe(fingerprint(BASE));
  });

  // Order is taken as given rather than sorted. preflight pushes its checks in a
  // fixed order, so the same situation always renders the same way; sorting
  // would need a byte-wise comparator agreed across two languages for no gain.
  it("distinguishes a different order, and preflight never produces one", () => {
    const swapped = [BASE.warnings[1], BASE.warnings[0]];
    expect(fingerprint({ ...BASE, warnings: swapped })).not.toBe(fingerprint(BASE));
  });

  it("is stable across calls", () => {
    expect(fingerprint(BASE)).toBe(fingerprint(structuredClone(BASE)));
  });
});

describe("the shared fixture", () => {
  // The Swift application computes this hash too, and a disagreement is
  // invisible until someone tries to approve something. This file is the
  // contract; both test suites read it.
  it("matches every recorded vector", () => {
    const vectors = JSON.parse(
      readFileSync("tests/fixtures/fingerprint-vectors.json", "utf8"),
    ) as { name: string; situation: Situation; fingerprint: string }[];

    expect(vectors.length).toBeGreaterThanOrEqual(4);
    for (const vector of vectors) {
      expect(fingerprint(vector.situation), vector.name).toBe(vector.fingerprint);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/approval/fingerprint.test.ts`
Expected: FAIL — cannot resolve `../../src/approval/fingerprint.js`.

- [ ] **Step 3: Write `src/approval/fingerprint.ts`**

```ts
import { createHash } from "node:crypto";
import type { Warning } from "../preflight/types.js";

/** Everything an approval is bound to. */
export type Situation = {
  repo: string;
  branch: string;
  base: string;
  head: string;
  warnings: Warning[];
};

const VERSION = "shipkit-approval-v1";

/**
 * Renders a situation so that two implementations in two languages produce
 * identical bytes.
 *
 * Every value is prefixed with its UTF-8 byte length rather than escaped. A
 * delimiter that can occur inside a warning message is a disagreement waiting
 * for the first message that contains one, and escaping rules are exactly the
 * kind of detail two implementations get subtly different.
 *
 * Warning order is taken as given. `preflight` pushes its checks in a fixed
 * order, so the same situation always renders the same way, and sorting would
 * need a byte-wise comparator agreed across both languages for nothing.
 */
export function canonical(situation: Situation): string {
  const field = (value: string) => `${Buffer.byteLength(value, "utf8")}:${value}`;
  const lines = [
    VERSION,
    field(situation.repo),
    field(situation.branch),
    field(situation.base),
    field(situation.head),
    String(situation.warnings.length),
  ];
  for (const warning of situation.warnings) {
    lines.push(field(warning.check), field(warning.message));
  }
  return lines.join("\n");
}

/** Lowercase hex SHA-256 of the canonical form's UTF-8 bytes. */
export function fingerprint(situation: Situation): string {
  return createHash("sha256").update(canonical(situation), "utf8").digest("hex");
}
```

- [ ] **Step 4: Generate the fixture from the implementation, then read it back**

Write `tests/fixtures/fingerprint-vectors.json` by hand as four situations with their hashes left empty, then fill the hashes by running the implementation once:

```bash
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const { fingerprint } = await import("./dist/approval/fingerprint.js");
const path = "tests/fixtures/fingerprint-vectors.json";
const vectors = JSON.parse(readFileSync(path, "utf8"));
for (const v of vectors) v.fingerprint = fingerprint(v.situation);
writeFileSync(path, JSON.stringify(vectors, null, 2) + "\n");
console.log(vectors.map((v) => `${v.name}  ${v.fingerprint}`).join("\n"));
'
```

The four situations, chosen so the Swift side exercises the parts most likely to diverge:

```json
[
  {
    "name": "no warnings",
    "situation": {
      "repo": "/Users/x/example-app",
      "branch": "bugfix/squadb/31087-invoice",
      "base": "develop",
      "head": "a44dcf5d9f8a0c59fb282d667cfab5e1e809d6bd",
      "warnings": []
    },
    "fingerprint": ""
  },
  {
    "name": "two warnings",
    "situation": {
      "repo": "/Users/x/example-app",
      "branch": "bugfix/squadb/31087-invoice",
      "base": "release/3.76.0",
      "head": "a44dcf5d9f8a0c59fb282d667cfab5e1e809d6bd",
      "warnings": [
        { "check": "approvals-dismissed", "message": "Pushing will dismiss 4 approval(s) on #881" },
        { "check": "blocking-label", "message": "Label(s) in test will block the merge gate" }
      ]
    },
    "fingerprint": ""
  },
  {
    "name": "non-ascii in every field",
    "situation": {
      "repo": "/Users/toygun/Belgeler/example-app",
      "branch": "bugfix/ödeme/31087-fatura",
      "base": "release/3.76.0",
      "head": "b44dcf5d9f8a0c59fb282d667cfab5e1e809d6bd",
      "warnings": [
        { "check": "foreign-commits", "message": "Şube ABC-27975 taşıyor — ABC-31087 değil" }
      ]
    },
    "fingerprint": ""
  },
  {
    "name": "a message that looks like the encoding",
    "situation": {
      "repo": "/r",
      "branch": "b",
      "base": "d",
      "head": "c44dcf5d9f8a0c59fb282d667cfab5e1e809d6bd",
      "warnings": [{ "check": "x", "message": "a:1\n5:fake" }]
    },
    "fingerprint": ""
  }
]
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run build && npx vitest run tests/approval/fingerprint.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 6: Commit**

```bash
git add src/approval tests/approval tests/fixtures/fingerprint-vectors.json
git commit -m "feat(approval): bind an approval to a hash of the situation"
```

---

### Task 2: The protocol

One request per connection, one response, then close. Newline-delimited JSON, readable with `nc` when something goes wrong — worth more than compactness for a protocol carrying this much weight.

**Files:**
- Create: `src/approval/protocol.ts`
- Test: `tests/approval/protocol.test.ts`

**Interfaces:**
- Consumes: `Warning` from `src/preflight/types.js`.
- Produces:
  - `const PROTOCOL_VERSION = 1`
  - `class ProtocolError extends Error`
  - `type ApprovalRequest = { protocol: number; fingerprint: string; repo: string; branch: string; base: string; head: string; title: string; commitMessage: string; diffstat: string; warnings: Warning[] }`
  - `type ApprovalResponse = { protocol: number; fingerprint: string; decision: "approved" | "denied" | "pending" }`
  - `function encodeRequest(request: ApprovalRequest): string` — one line, newline-terminated.
  - `function decodeResponse(line: string, expectedFingerprint: string): ApprovalResponse` — throws `ProtocolError` for unparseable input, a failed shape, a version mismatch, or a fingerprint that is not the expected one.

- [ ] **Step 1: Write the failing test**

`tests/approval/protocol.test.ts`:

```ts
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
  branch: "bugfix/squadb/31087-invoice",
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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/approval/protocol.test.ts`
Expected: FAIL — cannot resolve `../../src/approval/protocol.js`.

- [ ] **Step 3: Write `src/approval/protocol.ts`**

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/approval/protocol.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/approval/protocol.ts tests/approval/protocol.test.ts
git commit -m "feat(approval): the request and response on the wire"
```

---

### Task 3: The policy

Two pure questions: should an approval be sought, and does the gate open. Both return reasons rather than messages — the wording of a refusal differs per interface, and this project already learned that the hard way when a CLI flag leaked into an MCP caller's output.

**Files:**
- Create: `src/approval/policy.ts`
- Test: `tests/approval/policy.test.ts`

**Interfaces:**
- Consumes: `Warning` from `src/preflight/types.js`, `Acknowledgement` from `src/submit/run.js`.
- Produces:
  - `type ApprovalPolicy = "echo" | "human"`
  - `type ApprovalOutcome = "approved" | "denied" | "timed-out" | "no-surface"`
  - `function unacknowledged(warnings: Warning[], acknowledge: Acknowledgement): Warning[]`
  - `function shouldRequestApproval(input: { policy: ApprovalPolicy; warnings: Warning[]; acknowledge: Acknowledgement }): boolean`
  - `type GateReason = "unacknowledged" | "denied" | "timed-out" | "no-surface" | "human-required"`
  - `type GateResult = { open: true } | { open: false; reason: GateReason; unacknowledged: Warning[] }`
  - `function gate(input: { policy: ApprovalPolicy; warnings: Warning[]; acknowledge: Acknowledgement; outcome?: ApprovalOutcome }): GateResult`

- [ ] **Step 1: Write the failing test**

`tests/approval/policy.test.ts`:

```ts
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

  it("refuses when a person denied", () => {
    const result = gate({ policy: "echo", warnings: W, acknowledge: [], outcome: "denied" });
    expect(result.open).toBe(false);
    expect(result).toMatchObject({ reason: "denied" });
  });

  it("refuses when the wait ran out", () => {
    const result = gate({ policy: "echo", warnings: W, acknowledge: [], outcome: "timed-out" });
    expect(result).toMatchObject({ open: false, reason: "timed-out" });
  });

  // The property that keeps the application optional: with nothing listening,
  // echo falls back to exactly today's refusal.
  it("falls back to the echo refusal when no surface is running", () => {
    const result = gate({ policy: "echo", warnings: W, acknowledge: [], outcome: "no-surface" });
    expect(result).toMatchObject({ open: false, reason: "unacknowledged" });
    expect(result.open === false && result.unacknowledged).toHaveLength(2);
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/approval/policy.test.ts`
Expected: FAIL — cannot resolve `../../src/approval/policy.js`.

- [ ] **Step 3: Write `src/approval/policy.ts`**

```ts
import type { Warning } from "../preflight/types.js";
import type { Acknowledgement } from "../submit/run.js";

export type ApprovalPolicy = "echo" | "human";

/** What came back from asking a person, including not being able to ask. */
export type ApprovalOutcome = "approved" | "denied" | "timed-out" | "no-surface";

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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/approval/policy.test.ts`
Expected: PASS — 16 tests.

- [ ] **Step 5: Commit**

```bash
git add src/approval/policy.ts tests/approval/policy.test.ts
git commit -m "feat(approval): decide whether to ask, and whether the gate opens"
```

---

### Task 4: `pr.approval`, and the head commit

Two small additions, both prerequisites for the wiring in Task 6, batched because they are the same shape of work: one field on a schema, one command on an adapter.

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `src/vcs/git.ts`
- Modify: `docs/examples/example.shipkit.yml`
- Test: `tests/config/schema.test.ts`, `tests/vcs/git.args.test.ts`

**Interfaces:**
- Produces:
  - `config.pr.approval: "echo" | "human"`, defaulting to `"echo"`.
  - `config.pr.approvalTimeoutSeconds: number`, a positive integer defaulting to `120`.
  - `function readHeadSha(cwd?: string): string` in `src/vcs/git.js` — the full 40-character commit id of `HEAD`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/config/schema.test.ts`:

```ts
describe("pr.approval", () => {
  // Every repository that exists today has no approval key, and none of them may
  // change behaviour because this landed.
  it("defaults to echo when the key is absent", () => {
    expect(loadConfig("tests/fixtures/valid.shipkit.yml").pr.approval).toBe("echo");
  });

  it("accepts human", () => {
    expect(loadConfig("docs/examples/example.shipkit.yml").pr.approval).toBe("human");
  });

  it("defaults the wait to 120 seconds", () => {
    expect(loadConfig("tests/fixtures/valid.shipkit.yml").pr.approvalTimeoutSeconds).toBe(120);
  });

  it("refuses a wait that is not a positive whole number of seconds", () => {
    const path = writeConfig(`
pr:
  titlePattern: '^x'
  approvalTimeoutSeconds: 0
  sections:
    - name: Summary
      required: true
branch:
  pattern: '^y'
jira:
  baseUrl: https://example.invalid/jira
  keyPattern: 'ABC-\\d+'
`);
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  it("refuses anything else", () => {
    const path = writeConfig(`
pr:
  titlePattern: '^x'
  approval: sometimes
  sections:
    - name: Summary
      required: true
branch:
  pattern: '^y'
jira:
  baseUrl: https://example.invalid/jira
  keyPattern: 'ABC-\\d+'
`);
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });
});
```

If `tests/config/schema.test.ts` has no `writeConfig` helper, add one that writes the given YAML to a file under `mkdtempSync` and returns the path.

Add to `tests/vcs/git.args.test.ts`:

```ts
describe("readHeadSha", () => {
  it("asks git for the full commit id of HEAD", () => {
    execFileSyncMock.mockImplementation(() => "a44dcf5d9f8a0c59fb282d667cfab5e1e809d6bd\n");
    expect(readHeadSha("/some/repo")).toBe("a44dcf5d9f8a0c59fb282d667cfab5e1e809d6bd");
    expect(calls()).toEqual([["rev-parse", "HEAD"]]);
  });

  // `--short` or `--abbrev-ref` here would put an abbreviation into the
  // fingerprint, and two abbreviations of the same commit can differ in length
  // as a repository grows.
  it("does not abbreviate", () => {
    execFileSyncMock.mockImplementation(() => "a44dcf5d9f8a0c59fb282d667cfab5e1e809d6bd\n");
    readHeadSha("/some/repo");
    expect(calls()[0]).not.toContain("--short");
    expect(calls()[0]).not.toContain("--abbrev-ref");
  });
});
```

Update the import at the top of `tests/vcs/git.args.test.ts` to include `readHeadSha`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/config/schema.test.ts tests/vcs/git.args.test.ts`
Expected: FAIL — `pr.approval` is `undefined` and `readHeadSha` does not exist.

- [ ] **Step 3: Add the config key**

In `src/config/schema.ts`, inside the `pr` object:

```ts
    // Whether a person has to see the pre-flight warnings before a push. `echo`
    // is every repository that exists today: the caller acknowledging the
    // warning ids is enough. `human` requires a decision from the approval
    // surface, and an echoed id no longer suffices.
    approval: z.enum(["echo", "human"]).default("echo"),
    // How long to wait for that decision. Long enough that someone at their desk
    // has time to read three warnings and click; short enough that an agent's
    // tool call does not sit past its own timeout. On expiry the run refuses and
    // names the fingerprint, so calling again resumes the same question rather
    // than asking a new one.
    approvalTimeoutSeconds: z.number().int().positive().default(120),
```

- [ ] **Step 4: Add the adapter**

In `src/vcs/git.ts`:

```ts
/** The full commit id of `HEAD`, unabbreviated because it goes into a fingerprint. */
export function readHeadSha(cwd: string = process.cwd()): string {
  return git(["rev-parse", "HEAD"], cwd).trim();
}
```

- [ ] **Step 5: Set the policy in the example config**

In `docs/examples/example.shipkit.yml`, under `pr:`:

```yaml
  # A push here can dismiss four approvals or ship another squad's commits, and
  # both have happened. An agent echoing the warning ids back is evidence it read
  # them; it is not evidence anyone agreed.
  approval: human
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `rm -rf dist && npm test` then `npm run check`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/config/schema.ts src/vcs/git.ts docs/examples/example.shipkit.yml tests
git commit -m "feat(config): add pr.approval, and read the head commit"
```

---

### Task 5: The socket client

The only part of this plan that touches the outside world. Everything it can be told — the path, the timeout — is a parameter, so the tests drive a real socket in a temporary directory rather than a fake of one.

**Files:**
- Create: `src/approval/client.ts`
- Test: `tests/approval/client.test.ts`

**Interfaces:**
- Consumes: `ApprovalRequest`, `encodeRequest`, `decodeResponse`, `ProtocolError` from `src/approval/protocol.js`; `ApprovalOutcome` from `src/approval/policy.js`.
- Produces:
  - `function defaultSocketPath(): string` — `SHIPKIT_APPROVAL_SOCKET` when set, otherwise `~/Library/Application Support/shipkit/approvals.sock`.
  - `function requestApproval(request: ApprovalRequest, options?: { socketPath?: string; timeoutMs?: number }): Promise<ApprovalOutcome>`
  - Never throws. Every failure becomes an outcome: a missing listener and a refused connection are `"no-surface"`, a timeout or a `pending` response is `"timed-out"`, and a malformed or mismatched response is `"denied"`.

- [ ] **Step 1: Write the failing test**

`tests/approval/client.test.ts`:

```ts
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

/** A listener that replies with whatever `reply` returns, or never replies. */
function listen(path: string, reply: (line: string) => string | null): Promise<void> {
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const answer = reply(buffer.slice(0, newline));
      if (answer !== null) socket.end(answer);
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
    await expect(requestApproval(REQUEST, { socketPath: socketPath() })).resolves.toBe(
      "no-surface",
    );
  });

  it("sends the request and returns the decision", async () => {
    const path = socketPath();
    let seen = "";
    await listen(path, (line) => {
      seen = line;
      return response("approved");
    });

    await expect(requestApproval(REQUEST, { socketPath: path })).resolves.toBe("approved");
    expect(JSON.parse(seen)).toEqual(REQUEST);
  });

  it("returns denied when a person denied", async () => {
    const path = socketPath();
    await listen(path, () => response("denied"));
    await expect(requestApproval(REQUEST, { socketPath: path })).resolves.toBe("denied");
  });

  it("returns timed-out when the listener never answers", async () => {
    const path = socketPath();
    await listen(path, () => null);
    await expect(requestApproval(REQUEST, { socketPath: path, timeoutMs: 120 })).resolves.toBe(
      "timed-out",
    );
  });

  // `pending` means the person has not decided yet. From the caller's side that
  // is the same situation as running out of time, and collapsing them keeps the
  // caller from having to handle a state it cannot act on.
  it("treats a pending response as timed-out", async () => {
    const path = socketPath();
    await listen(path, () => response("pending"));
    await expect(requestApproval(REQUEST, { socketPath: path })).resolves.toBe("timed-out");
  });

  // Anything it cannot understand fails closed. An approval is permission to
  // push, and a garbled line is not permission.
  it("returns denied for a malformed response", async () => {
    const path = socketPath();
    await listen(path, () => "{\n");
    await expect(requestApproval(REQUEST, { socketPath: path })).resolves.toBe("denied");
  });

  it("returns denied for a response about a different request", async () => {
    const path = socketPath();
    await listen(path, () => response("approved", "b".repeat(64)));
    await expect(requestApproval(REQUEST, { socketPath: path })).resolves.toBe("denied");
  });

  it("returns denied when the listener speaks another protocol version", async () => {
    const path = socketPath();
    await listen(path, () =>
      `${JSON.stringify({ protocol: 99, fingerprint: FP, decision: "approved" })}\n`,
    );
    await expect(requestApproval(REQUEST, { socketPath: path })).resolves.toBe("denied");
  });

  it("never throws, whatever the listener does", async () => {
    const path = socketPath();
    await listen(path, () => {
      throw new Error("listener exploded");
    });
    await expect(requestApproval(REQUEST, { socketPath: path, timeoutMs: 120 })).resolves.toBeTypeOf(
      "string",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/approval/client.test.ts`
Expected: FAIL — cannot resolve `../../src/approval/client.js`.

- [ ] **Step 3: Write `src/approval/client.ts`**

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/approval/client.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Confirm the socket really is the thing being tested**

Run: `ls /tmp | grep shipkit-approval | wc -l` after the suite.
Expected: `0` — every temporary directory is removed by the `afterEach`.

- [ ] **Step 6: Commit**

```bash
git add src/approval/client.ts tests/approval/client.test.ts
git commit -m "feat(approval): ask the surface over a unix socket"
```

---

### Task 6: The gate consults the policy

Where it comes together. The existing acknowledgement path is untouched under `echo`; what changes is that a refusal may now first become a question, and an approval is re-derived from fresh facts before anything is pushed.

That re-derivation is the point of the whole design. Minutes can pass while a request waits. Reading the facts again and recomputing the fingerprint is what makes a human approval as situation-bound as an echoed id.

**Files:**
- Modify: `src/submit/run.ts`
- Modify: `src/cli.ts`
- Modify: `src/mcp/server.ts`
- Test: `tests/submit/run.test.ts`

**Interfaces:**
- Consumes: `fingerprint`/`Situation` (Task 1), `ApprovalRequest`/`PROTOCOL_VERSION` (Task 2), `gate`/`shouldRequestApproval`/`ApprovalOutcome` (Task 3), `readHeadSha` (Task 4), `requestApproval` (Task 5).
- Produces:
  - `SubmitDeps` gains two members:
    - `readHeadSha: () => string`
    - `requestApproval: (request: ApprovalRequest, timeoutMs: number) => Promise<ApprovalOutcome>`
  - `SubmitResult` gains `approval?: ApprovalOutcome` — what the person said, when they were asked — and `approvalFingerprint?: string`, the situation the question was about. A timed-out run names it so calling again resumes the same question instead of asking a new one.

- [ ] **Step 1: Write the failing test**

Add to `tests/submit/run.test.ts`. `makeDeps` gains `readHeadSha: () => "a".repeat(40)` and `requestApproval: async () => "no-surface" as const /* extra args ignored */` in its defaults, poisoned entries in the poison branch, recorded entries in the recorder, and both names in `DOMAIN_DEPS`.

```ts
describe("the approval surface", () => {
  const warned = { readUntrackedFiles: () => [".env.local"] };

  it("does not ask when there is nothing to warn about", async () => {
    const { deps, calls } = makeDeps({});
    await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: "all" }, deps);
    expect(calls.some((c) => c.fn === "requestApproval")).toBe(false);
  });

  it("does not ask under echo when the ids cover the warnings", async () => {
    const { deps, calls } = makeDeps(warned);
    await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: "all" }, deps);
    expect(calls.some((c) => c.fn === "requestApproval")).toBe(false);
  });

  it("asks under echo when they do not, and proceeds when approved", async () => {
    const { deps, calls } = makeDeps({ ...warned, requestApproval: async () => "approved" as const });
    const result = await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: [] }, deps);
    expect(result.code).toBe(0);
    expect(result.approval).toBe("approved");
    expect(calls.some((c) => c.fn === "commitAll")).toBe(true);
  });

  it("refuses and mutates nothing when denied", async () => {
    const { deps, calls } = makeDeps({ ...warned, requestApproval: async () => "denied" as const });
    const result = await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: [] }, deps);
    expect(result.code).toBe(2);
    expect(calls.some((c) => c.fn === "commitAll")).toBe(false);
  });

  it("refuses and mutates nothing when the wait runs out", async () => {
    const { deps, calls } = makeDeps({ ...warned, requestApproval: async () => "timed-out" as const });
    const result = await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: [] }, deps);
    expect(result.code).toBe(2);
    expect(calls.some((c) => c.fn === "commitAll")).toBe(false);
  });

  // The property that keeps the application optional.
  it("falls back to today's refusal under echo with nothing listening", async () => {
    const { deps, err } = makeDeps({ ...warned, requestApproval: async () => "no-surface" as const /* extra args ignored */ });
    const result = await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: [] }, deps);
    expect(result.code).toBe(2);
    expect(err.join("\n")).toContain("untracked-files");
  });

  it("sends the situation, not a summary of it", async () => {
    let sent: ApprovalRequest | undefined;
    const { deps } = makeDeps({
      ...warned,
      requestApproval: async (request: ApprovalRequest, timeoutMs: number) => {
        sent = request;
        expect(timeoutMs).toBe(120_000);
        return "denied" as const;
      },
    });

    await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: [] }, deps);

    expect(sent?.head).toBe("a".repeat(40));
    expect(sent?.base).toBe(OPTIONS.base);
    expect(sent?.warnings.map((w) => w.check)).toContain("untracked-files");
    expect(sent?.commitMessage).toBe(VALID_RESPONSE.commitMessage);
    // The fingerprint must be the one the situation hashes to, not an
    // independent value the surface would have no way to check.
    expect(sent?.fingerprint).toBe(
      fingerprint({
        repo: sent!.repo,
        branch: sent!.branch,
        base: sent!.base,
        head: sent!.head,
        warnings: sent!.warnings,
      }),
    );
  });

  // Minutes can pass while a request waits. An approval that survives a
  // situation changing underneath it is worth nothing.
  it("re-derives the facts after approval and refuses when they changed", async () => {
    let reads = 0;
    const { deps, calls } = makeDeps({
      ...warned,
      requestApproval: async () => "approved" as const,
      // The first read is the one hashed into the request; by the second, a
      // blocking label has appeared on the pull request.
      findPullRequest: () => {
        reads += 1;
        return reads === 1
          ? NO_PR
          : {
              number: 7,
              url: "https://github.com/x/y/pull/7",
              baseRefName: "develop",
              labels: ["in test"],
              approvals: [],
            };
      },
      loadConfig: () => loadConfig("tests/fixtures/blocking-labels.shipkit.yml"),
    });

    const result = await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: [] }, deps);

    expect(result.code).toBe(2);
    expect(result.warnings.map((w) => w.check)).toContain("blocking-label");
    expect(calls.some((c) => c.fn === "commitAll")).toBe(false);
  });

  it("proceeds when the facts are unchanged", async () => {
    const { deps, calls } = makeDeps({ ...warned, requestApproval: async () => "approved" as const });
    const result = await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: [] }, deps);
    expect(result.code).toBe(0);
    expect(calls.some((c) => c.fn === "commitAll")).toBe(true);
  });

  it("never asks in preview mode", async () => {
    const { deps, calls } = makeDeps(warned);
    await runSubmit({ ...OPTIONS, mode: "preview", acknowledge: [] }, deps);
    expect(calls.some((c) => c.fn === "requestApproval")).toBe(false);
  });
});

describe("the human policy", () => {
  const humanConfig = () => {
    const config = loadConfig("tests/fixtures/valid.shipkit.yml");
    return { ...config, pr: { ...config.pr, approval: "human" as const } };
  };
  const warned = { readUntrackedFiles: () => [".env.local"], loadConfig: humanConfig };

  it("asks even when every id was echoed", async () => {
    const { deps, calls } = makeDeps({ ...warned, requestApproval: async () => "approved" as const });
    await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: "all" }, deps);
    expect(calls.some((c) => c.fn === "requestApproval")).toBe(true);
  });

  // Otherwise the policy is decorative: an agent, or a --yes, would walk past it.
  it("refuses an echoed acknowledgement with nothing listening", async () => {
    const { deps, calls } = makeDeps({ ...warned, requestApproval: async () => "no-surface" as const /* extra args ignored */ });
    const result = await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: "all" }, deps);
    expect(result.code).toBe(2);
    expect(calls.some((c) => c.fn === "commitAll")).toBe(false);
  });

  it("says the surface is not running rather than naming ids to acknowledge", async () => {
    const { deps, err } = makeDeps({ ...warned, requestApproval: async () => "no-surface" as const /* extra args ignored */ });
    await runSubmit({ ...OPTIONS, mode: "apply", acknowledge: "all" }, deps);
    expect(err.join("\n")).toMatch(/approval surface/i);
  });
});
```

Add `import { fingerprint } from "../../src/approval/fingerprint.js";` and `import type { ApprovalRequest } from "../../src/approval/protocol.js";` to the file's imports.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/submit/run.test.ts`
Expected: FAIL — `requestApproval` is not a member of `SubmitDeps`.

- [ ] **Step 3: Extend `SubmitDeps` and `SubmitResult` in `src/submit/run.ts`**

```ts
  readRepoRoot: () => string;
  readHeadSha: () => string;
  realpath: (path: string) => string;
  requestApproval: (request: ApprovalRequest, timeoutMs: number) => Promise<ApprovalOutcome>;
```

and on `SubmitResult`:

```ts
  /** What the person said, when one was asked. Absent when nobody was. */
  approval?: ApprovalOutcome;
  /**
   * The situation the question was about. Present whenever one was asked, and
   * the reason a timed-out call can be resumed: the surface keys its journal by
   * this, so calling again with the same situation finds the decision waiting
   * rather than starting over.
   */
  approvalFingerprint?: string;
```

Imports:

```ts
import { fingerprint, type Situation } from "../approval/fingerprint.js";
import { gate, shouldRequestApproval, type ApprovalOutcome } from "../approval/policy.js";
import { PROTOCOL_VERSION, type ApprovalRequest } from "../approval/protocol.js";
```

- [ ] **Step 4: Replace the gate**

The block that currently computes `unacknowledged` and returns on it becomes:

```ts
    // Reading the facts is what makes a situation; both the question and the
    // check after the answer are built from the same helper so they cannot drift.
    const situationOf = (facts: { head: string; warnings: Warning[] }): Situation => ({
      repo: repoRoot,
      branch,
      base: options.base,
      head: facts.head,
      warnings: facts.warnings,
    });

    let approval: ApprovalOutcome | undefined;
    let approvalFingerprint: string | undefined;

    if (shouldRequestApproval({ policy: config.pr.approval, warnings, acknowledge: options.acknowledge })) {
      const head = deps.readHeadSha();
      const situation = situationOf({ head, warnings });
      approvalFingerprint = fingerprint(situation);
      approval = await deps.requestApproval({
        protocol: PROTOCOL_VERSION,
        fingerprint: approvalFingerprint,
        repo: situation.repo,
        branch: situation.branch,
        base: situation.base,
        head: situation.head,
        title: response.title,
        commitMessage: response.commitMessage,
        diffstat: repo.diffstat,
        warnings,
      }, config.pr.approvalTimeoutSeconds * 1000);

      // Minutes can pass while a person decides. An approval that survives the
      // situation changing underneath it is worth nothing, so the facts are read
      // again and hashed again before anything is pushed. This is the same
      // property the echoed ids have — checked against what pre-flight produces
      // now, not what it produced when the question was asked.
      if (approval === "approved") {
        const freshHead = deps.readHeadSha();
        const freshPr = deps.findPullRequest(branch);
        const freshWarnings = preflight({
          branch,
          base: options.base,
          commits: deps.readRepoState(options.base).commits,
          ticketKey,
          issueVerified,
          pullRequest: freshPr,
          untrackedFiles: deps
            .readUntrackedFiles()
            .filter((file) => !responseInRepo || file !== relativeToRoot),
          config,
        }).warnings;

        if (
          fingerprint(situationOf({ head: freshHead, warnings: freshWarnings })) !==
          approvalFingerprint
        ) {
          const message =
            "The situation changed while the approval was pending; asking again from the start.";
          deps.err(message);
          for (const warning of freshWarnings) {
            deps.err(`${warning.check}: ${warning.message}`);
          }
          return {
            code: 2,
            findings: [],
            warnings: freshWarnings,
            body,
            message,
            approval,
            approvalFingerprint,
            committed: false,
            pushed: false,
          };
        }
      }
    }

    const decision = gate({
      policy: config.pr.approval,
      warnings,
      acknowledge: options.acknowledge,
      outcome: approval,
    });

    if (!decision.open) {
      // Neutral on purpose: the remedy differs per interface, and now per
      // policy too. src/cli.ts appends "Re-run with --yes" when that would
      // help, and src/mcp/result.ts appends its acknowledge guidance.
      const message = refusalMessage(decision, approvalFingerprint);
      deps.err(message);
      return {
        code: 2,
        findings: [],
        warnings,
        body,
        message,
        approval,
        approvalFingerprint,
        committed: false,
        pushed: false,
      };
    }
```

The wait is configurable, and `src/cli.ts` and `src/mcp/server.ts` both build
their dependency object before any config is loaded — neither has one to close
over. So the timeout travels as a second argument rather than a captured value:

```ts
  requestApproval: (request: ApprovalRequest, timeoutMs: number) => Promise<ApprovalOutcome>;
```

`runSubmit` passes `config.pr.approvalTimeoutSeconds * 1000`, and both real
adapters are `(request, timeoutMs) => requestApproval(request, { timeoutMs })`.

with, above `runSubmit`:

```ts
/** One sentence per reason, naming the situation rather than any interface's remedy. */
function refusalMessage(
  decision: Extract<GateResult, { open: false }>,
  approvalFingerprint?: string,
): string {
  switch (decision.reason) {
    case "unacknowledged":
      return `Refusing to proceed. Unacknowledged: ${decision.unacknowledged
        .map((warning) => warning.check)
        .join(", ")}`;
    case "denied":
      return "Refusing to proceed. The push was denied.";
    case "timed-out":
      // Naming the fingerprint is what makes this resumable. The surface keys
      // its journal by it, so the same call made again finds the decision
      // waiting instead of asking a second time.
      return (
        "Refusing to proceed. No decision arrived before the wait ran out. " +
        `Call again to resume the same request (${approvalFingerprint ?? "unknown"}).`
      );
    case "no-surface":
      return "Refusing to proceed. This repository requires an approval, and the approval surface is not running.";
    case "human-required":
      return "Refusing to proceed. This repository requires an approval from a person.";
  }
}
```

Import `GateResult` and `Warning` alongside the others.

- [ ] **Step 5: Wire the real adapter in `src/cli.ts`**

```ts
import { requestApproval } from "./approval/client.js";
import { readHeadSha } from "./vcs/git.js";
```

and in `realSubmitDeps`:

```ts
  readHeadSha: () => readHeadSha(cwd),
  requestApproval: (request, timeoutMs) => requestApproval(request, { timeoutMs }),
```

- [ ] **Step 6: Wire the real adapter in `src/mcp/server.ts`**

In `submitDeps(repo)`:

```ts
      readHeadSha: () => readHeadSha(repo),
      requestApproval: (request, timeoutMs) => requestApproval(request, { timeoutMs }),
```

with the matching imports.

- [ ] **Step 7: Run the tests**

Run: `rm -rf dist && npm test` then `npm run check`
Expected: PASS, no type errors. `tests/cli.submit.test.ts` must pass unchanged.

- [ ] **Step 8: Commit**

```bash
git add src/submit/run.ts src/cli.ts src/mcp/server.ts tests/submit/run.test.ts
git commit -m "feat(submit): let a person's decision open the gate"
```

---

### Task 7: The Jira token, out of the environment

An MCP server is spawned by the agent, and an agent launched from the Dock does not source a shell profile. So `SHIPKIT_JIRA_TOKEN` may simply not be there, `resolveIssue` returns nothing, and `issue-unverified` fires on every run — which is how a warning becomes one nobody reads.

**Files:**
- Create: `src/secrets/keychain.ts`
- Modify: `src/cli-support.ts`
- Test: `tests/secrets/keychain.test.ts`, `tests/cli-support.test.ts`

**Interfaces:**
- Produces:
  - `type SecurityRunner = (args: string[]) => string`
  - `function readKeychainSecret(account: string, run?: SecurityRunner): string | undefined` — `undefined` when the item is absent or `security` fails for any reason. Never throws.
  - `function jiraToken(run?: SecurityRunner): string | undefined` — the environment first, then the Keychain.

- [ ] **Step 1: Write the failing test**

`tests/secrets/keychain.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jiraToken, readKeychainSecret } from "../../src/secrets/keychain.js";

const original = process.env.SHIPKIT_JIRA_TOKEN;
beforeEach(() => {
  delete process.env.SHIPKIT_JIRA_TOKEN;
});
afterEach(() => {
  if (original === undefined) delete process.env.SHIPKIT_JIRA_TOKEN;
  else process.env.SHIPKIT_JIRA_TOKEN = original;
});

describe("readKeychainSecret", () => {
  it("asks security for the shipkit item and trims the answer", () => {
    const seen: string[][] = [];
    const value = readKeychainSecret("jira", (args) => {
      seen.push(args);
      return "s3cret\n";
    });
    expect(value).toBe("s3cret");
    expect(seen).toEqual([["find-generic-password", "-s", "shipkit", "-a", "jira", "-w"]]);
  });

  // `security` exits non-zero when the item is absent, which is the ordinary
  // case on a machine where nobody has saved a token. It is not an error.
  it("returns undefined when the item is missing", () => {
    expect(
      readKeychainSecret("jira", () => {
        throw new Error("The specified item could not be found in the keychain.");
      }),
    ).toBeUndefined();
  });

  it("returns undefined for an empty answer", () => {
    expect(readKeychainSecret("jira", () => "\n")).toBeUndefined();
  });
});

describe("jiraToken", () => {
  it("prefers the environment, so CI and overrides keep working", () => {
    process.env.SHIPKIT_JIRA_TOKEN = "from-env";
    expect(jiraToken(() => "from-keychain")).toBe("from-env");
  });

  it("falls back to the keychain", () => {
    expect(jiraToken(() => "from-keychain")).toBe("from-keychain");
  });

  it("treats an empty environment variable as absent", () => {
    process.env.SHIPKIT_JIRA_TOKEN = "";
    expect(jiraToken(() => "from-keychain")).toBe("from-keychain");
  });

  it("is undefined when neither has it", () => {
    expect(
      jiraToken(() => {
        throw new Error("not found");
      }),
    ).toBeUndefined();
  });
});
```

Add to `tests/cli-support.test.ts`:

```ts
it("resolves an issue using a keychain token when the environment has none", async () => {
  delete process.env.SHIPKIT_JIRA_TOKEN;
  let seenToken = "";
  const issue = await resolveIssue(
    "ABC-1",
    { jira: { baseUrl: "https://example.invalid/jira" } },
    async (_url: string, token: string) => {
      seenToken = token;
      return { key: "ABC-1", fields: { issuetype: { name: "Story" }, summary: "s" } };
    },
    () => "from-keychain",
  );
  expect(seenToken).toBe("from-keychain");
  expect(issue?.key).toBe("ABC-1");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/secrets/keychain.test.ts`
Expected: FAIL — cannot resolve `../../src/secrets/keychain.js`.

- [ ] **Step 3: Write `src/secrets/keychain.ts`**

```ts
import { execFileSync } from "node:child_process";

/** The seam that keeps `security` out of the tests. */
export type SecurityRunner = (args: string[]) => string;

const defaultRunner: SecurityRunner = (args) =>
  execFileSync("/usr/bin/security", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

/**
 * Reads a secret shipkit stored in the login keychain.
 *
 * Never throws. `security` exits non-zero when the item is absent, which is the
 * ordinary state of a machine where nobody has saved a token — an error type
 * here would make the common case look like a fault.
 */
export function readKeychainSecret(
  account: string,
  run: SecurityRunner = defaultRunner,
): string | undefined {
  let raw: string;
  try {
    raw = run(["find-generic-password", "-s", "shipkit", "-a", account, "-w"]);
  } catch {
    return undefined;
  }
  const value = raw.trim();
  return value.length > 0 ? value : undefined;
}

/**
 * The environment first, so CI and a deliberate override keep working, then the
 * keychain — which is where the token lives on a machine whose agent was
 * launched from the Dock and never saw a shell profile.
 */
export function jiraToken(run: SecurityRunner = defaultRunner): string | undefined {
  const fromEnv = process.env.SHIPKIT_JIRA_TOKEN;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return readKeychainSecret("jira", run);
}
```

- [ ] **Step 4: Use it in `src/cli-support.ts`**

`resolveIssue` gains two optional seams so the new path is testable, defaulting to the real ones:

```ts
export async function resolveIssue(
  key: string | undefined,
  config: { jira: { baseUrl: string } },
  fetcher: Fetcher = defaultFetcher,
  readToken: () => string | undefined = jiraToken,
): Promise<IssueFacts | undefined> {
  if (key === undefined) return undefined;
  const token = readToken();
  if (token === undefined || token.length === 0) return undefined;
  return fetchIssue(config.jira.baseUrl, key, token, fetcher);
}
```

If `fetchIssue` does not already take a fetcher, keep its current call and drop the `fetcher` parameter — the token seam is the one this task needs.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `rm -rf dist && npm test` then `npm run check`
Expected: PASS, no type errors.

- [ ] **Step 6: Check by hand that the real path works**

Run:

```bash
security add-generic-password -s shipkit -a jira -w "probe-value" -U
node --input-type=module -e '
const { jiraToken } = await import("./dist/secrets/keychain.js");
console.log(jiraToken());
'
security delete-generic-password -s shipkit -a jira
```

Expected: `probe-value`, then the item is removed. Record the real output in the report. This is the one part of the task a fake cannot prove.

- [ ] **Step 7: Commit**

```bash
git add src/secrets tests/secrets src/cli-support.ts tests/cli-support.test.ts
git commit -m "feat(secrets): read the Jira token from the keychain"
```

---

## Done when

- `npm test` passes from a clean checkout and `npm run check` reports no type errors.
- A repository with no `approval` key behaves exactly as it did before this plan, whether or not anything is listening.
- Under `human`, neither an echoed id nor `--yes` reaches a mutating call without a decision from the surface.
- An approval whose situation changed between question and answer does not push.
- `tests/fixtures/fingerprint-vectors.json` exists and both its shape and its hashes are asserted.
- No test calls `gh`, starts a stdio server, or mutates this repository.
- `git status` is clean after the suite runs.

## Next

- **The menu-bar application.** Its own plan against the same spec: the listener, the fingerprint recomputation that makes the displayed facts provably the hashed ones, the ten-minute journal keyed by fingerprint, the popover, and the Keychain writes. `tests/fixtures/fingerprint-vectors.json` is the contract it builds to.
- **The refusal wording per interface.** `src/cli.ts` appends `--yes` guidance today on any warnings refusal; under `human` that flag cannot help and the line should not appear. Small, and it belongs with the application, since that is when `human` first becomes usable.
