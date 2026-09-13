# shipkit tech-task Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** shipkit notices an out-of-scope UIKit→SwiftUI conversion, advises opening a technical item, and can open it on request.

**Architecture:** A pure `src/advice/` module detects the conversion signal from changed files. A new `advice` channel — deliberately *not* a `Warning`, which would gate the push — carries it into `brief` and `submit`. A separate `shipkit tech-task` command assembles a Jira create payload from repository config plus values derived from the developer's own recent issues, and refuses rather than guessing when a derivation is not clear.

**Tech Stack:** Node 25, TypeScript strict ESM (local imports carry `.js`), zod, vitest, commander.

**Spec:** `docs/superpowers/specs/2026-09-13-shipkit-tech-task-design.md` — read the "What was measured" table before writing any field name; every value in it came from the live Jira and none is a guess.

## Global Constraints

- Touch only this repository. Never another repo, never a pull request, never a push.
- **No test may perform a Jira write, invoke `gh`, `git push`, or make any network call.** The Jira call is behind an injected seam, as `vcs` and `jira` already are.
- **Do not call the Jira API during development.** The measurements are in the spec; that is what it is for.
- Never run `shipkit submit`, `node dist/cli.js mcp`, or any MCP tool against this repository.
- Local imports end in `.js`. Match the surrounding code's comment density and naming.
- `npm test` stays green — 555 passing before this plan — and `npm run check` clean.
- **Advice never changes an exit code and never reaches `shouldRequestApproval`.** If it did, every conversion would gate the push under `pr.approval: human`, which is the opposite of the decision this feature was designed around.

## The governing principle

Repeated from the spec because every task in this plan can violate it: **a confidently wrong value is worse than an absent one.** A missing field is named and a human supplies it; a wrong one is silently carried into a ticket nobody re-reads. Two rounds of `shipkit init` were spent learning this — `forbidden` banning `N/A`, then banning the checklist people tick. Where a derivation is not clear, refuse and say what the candidates were.

## File Structure

| File | Responsibility |
|---|---|
| `src/advice/types.ts` | `Advice`, distinct from `Warning` and never mixed with it |
| `src/advice/uikit.ts` | Detect the UIKit→SwiftUI signal from changed files |
| `src/jira/techtask.ts` | Assemble the create payload; pure |
| `src/jira/derive.ts` | Derive team, sprint and portfolio child from the developer's issues; pure over fetched data |
| `src/jira/create.ts` | The one adapter that POSTs, behind a seam |
| `src/config/schema.ts` | The optional `techTask` block |
| `src/cli.ts` | `tech-task` |

---

### Task 1: The advice channel

**Files:** Create `src/advice/types.ts`; Test `tests/advice/types.test.ts`

**Interfaces — Produces:**
```ts
export type Advice = { topic: string; message: string };
```

`Advice` is a separate type from `Warning` on purpose, and the test below is what stops the two being merged by a later well-meaning refactor.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { shouldRequestApproval } from "../../src/approval/policy.js";
import type { Advice } from "../../src/advice/types.js";

describe("advice", () => {
  // The whole design rests on this: advice must never gate a push. Under
  // `pr.approval: human` any unacknowledged warning asks a person, so advice
  // modelled as a Warning would prompt on every conversion.
  it("is not a warning, and cannot be passed as one", () => {
    const advice: Advice = { topic: "uikit-to-swiftui", message: "…" };
    expect(shouldRequestApproval({ policy: "human", warnings: [], acknowledge: [] })).toBe(false);
    expect(Object.keys(advice).sort()).toEqual(["message", "topic"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run tests/advice/types.test.ts`, module missing.
- [ ] **Step 3: Write `src/advice/types.ts`**, with a comment saying why the field names differ from `Warning`'s `check`/`message` — a different name is what makes a mistaken assignment a type error.
- [ ] **Step 4: Run the tests** — PASS.
- [ ] **Step 5: Commit** — `feat(advice): a channel that informs without gating`

---

### Task 2: Detecting the conversion

**Files:** Create `src/advice/uikit.ts`; Test `tests/advice/uikit.test.ts`

**Interfaces:**
- Consumes: `Advice` from Task 1.
- Produces:
```ts
export type ChangedFile = { path: string; status: "added" | "modified" | "deleted"; before: string; after: string };
export type Conversion = { files: string[]; deletedInterfaceFiles: string[] };
export function detectConversion(files: ChangedFile[]): Conversion | undefined;
```

Return `undefined` when there is no signal. **Be conservative** — the spec's reasoning is that a noisy advisor is one nobody reads, and unlike a warning this has no gate to make it matter. Prefer missing a conversion to inventing one.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { detectConversion, type ChangedFile } from "../../src/advice/uikit.js";

const f = (over: Partial<ChangedFile>): ChangedFile => ({
  path: "A.swift", status: "modified", before: "", after: "", ...over,
});

describe("detectConversion", () => {
  it("sees a controller that became a SwiftUI view", () => {
    const got = detectConversion([
      f({ path: "Trip/SummaryVC.swift",
          before: "final class SummaryVC: UIViewController {\n  @IBOutlet var label: UILabel!\n}",
          after: "struct SummaryView: View {\n  @State private var trip: Trip?\n  var body: some View { Text(\"x\") }\n}" }),
    ]);
    expect(got?.files).toEqual(["Trip/SummaryVC.swift"]);
  });

  it("counts a deleted interface file as part of the same conversion", () => {
    const got = detectConversion([
      f({ path: "Trip/Summary.xib", status: "deleted", before: "<xml/>" }),
      f({ path: "Trip/SummaryView.swift", status: "added",
          after: "struct SummaryView: View { var body: some View { Text(\"x\") } }" }),
    ]);
    expect(got?.deletedInterfaceFiles).toEqual(["Trip/Summary.xib"]);
  });

  it("says nothing about a SwiftUI file that was always SwiftUI", () => {
    expect(detectConversion([
      f({ path: "New.swift", status: "added", after: "struct New: View { var body: some View { EmptyView() } }" }),
    ])).toBeUndefined();
  });

  it("says nothing when UIKit is merely still present", () => {
    expect(detectConversion([
      f({ before: "class A: UIViewController {}", after: "class A: UIViewController { func x() {} }" }),
    ])).toBeUndefined();
  });

  it("says nothing when a UIHostingController is added, which is bridging, not converting", () => {
    expect(detectConversion([
      f({ before: "class A: UIViewController {}",
          after: "class A: UIViewController { let host = UIHostingController(rootView: EmptyView()) }" }),
    ])).toBeUndefined();
  });

  it("ignores a non-Swift file that happens to contain the words", () => {
    expect(detectConversion([
      f({ path: "notes.md", before: "we use UIViewController", after: "we use some View now" }),
    ])).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement.** A `.swift` file counts when it *loses* a UIKit marker (`UIViewController`, `UIView`, `@IBOutlet`, `@IBAction`) **and** *gains* a SwiftUI one (`var body:`, `some View`, `@State`, `@ObservedObject`). A deleted `.xib`/`.storyboard` counts only alongside at least one converted or added SwiftUI file in the same change. `UIHostingController` in the after-text disqualifies a file: that is UIKit hosting SwiftUI, which is the ordinary bridging pattern and not a conversion.
- [ ] **Step 4: Run the tests** — PASS.
- [ ] **Step 5: Confirm the tests discriminate.** Drop the `UIHostingController` exclusion and show that test failing; restore, verified with a saved copy and `diff` (`git diff --quiet` is vacuous for a new file). One change at a time.
- [ ] **Step 6: Commit** — `feat(advice): notice UIKit becoming SwiftUI, conservatively`

---

### Task 3: The `techTask` config block

**Files:** Modify `src/config/schema.ts`; Test `tests/config/techtask.test.ts`

**Interfaces — Produces:** an optional `techTask` on `ShipkitConfig`:
```ts
techTask?: {
  project: string;
  issueType: string;
  epic?: string;
  summaryPattern: string;          // must contain "{subject}"
  fields?: Record<string, unknown>;
};
```

Optional, because every repository that has a `.shipkit.yml` today has no `techTask` and must keep loading unchanged.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema.js";

const base = {
  pr: { titlePattern: "^.+$", sections: [{ name: "Summary", required: true }] },
  branch: { pattern: "^.+$" },
  jira: { baseUrl: "https://x.example.com", keyPattern: "A-\\d+" },
};

describe("techTask config", () => {
  it("is optional, so every existing config keeps loading", () => {
    expect(() => configSchema.parse(base)).not.toThrow();
    expect(configSchema.parse(base).techTask).toBeUndefined();
  });

  it("accepts the measured shape, cascading field and all", () => {
    const parsed = configSchema.parse({
      ...base,
      techTask: {
        project: "DCP", issueType: "Story", epic: "ABC-12154",
        summaryPattern: "iOS - {subject} swift ui dönüşümü",
        fields: { customfield_10101: { value: "Commercial" } },
      },
    });
    expect(parsed.techTask?.epic).toBe("ABC-12154");
  });

  // A pattern with no placeholder yields the same summary for every ticket,
  // which is how a backlog fills with indistinguishable rows.
  it("refuses a summary pattern that cannot carry a subject", () => {
    expect(() =>
      configSchema.parse({ ...base, techTask: { project: "D", issueType: "Story", summaryPattern: "iOS - conversion" } }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement.** Add the block with a `refine` on `summaryPattern` requiring `{subject}`. Comment the two field ids with their human names — `customfield_10101` is "Portfolio / Servis Bilgisi", `customfield_10102` is "Digital Team" — because a bare id in a config file is unreadable a month later.
- [ ] **Step 4: Run the tests** — PASS.
- [ ] **Step 5: Commit** — `feat(config): an optional techTask block`

---

### Task 4: Deriving what the config cannot hold

**Files:** Create `src/jira/derive.ts`; Test `tests/jira/derive.test.ts`

**Interfaces — Produces:**
```ts
export type IssueFieldSample = { team?: string; portfolioChild?: string };
export type Derived<T> = { value: T } | { unresolved: string; candidates: string[] };
export function deriveTeam(sample: IssueFieldSample[]): Derived<string>;
export function derivePortfolioChild(sample: IssueFieldSample[]): Derived<string>;
export function pickSprint(sprints: { id: number; name: string }[], team: string): Derived<number>;
```

Pure over already-fetched data; the fetching is Task 5's.

**The measured facts these encode** — from the spec, do not re-derive them:
- Team varies per developer and is usually unanimous on their own issues.
- Cross-team work exists: one issue in a Squad A sprint carried Squad B. So a **majority** is required, not a plurality.
- The portfolio child has *no* majority on one of four teams — Squad D, which splits four ways at 22/18/11/7. (An earlier draft said two of four and named Squad B's 36/20; that is 36 of 59, which is 61% and a majority. The spec carries the correction.) Refusing on the Squad D shape is the expected outcome, not an edge case. Note also that these are *team sprint* distributions while the derivation reads the developer's own issues; the one personal sample measured is 68% "Only Digital".
- Four sprints were active on one board at once, and six teams exist while only four had a sprint.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { deriveTeam, derivePortfolioChild, pickSprint } from "../../src/jira/derive.js";

const teams = (...names: string[]) => names.map((team) => ({ team }));

describe("deriveTeam", () => {
  it("takes a clear majority", () => {
    expect(deriveTeam(teams("Squad B", "Squad B", "Squad B", "Squad A"))).toEqual({ value: "Squad B" });
  });

  // Measured: one issue in a Squad A sprint carried Squad B. People move.
  it("refuses a plurality that is not a majority, and says what it saw", () => {
    const got = deriveTeam(teams("Squad B", "Squad B", "Squad D", "Squad D", "Squad C"));
    expect(got).toHaveProperty("unresolved");
    expect((got as { candidates: string[] }).candidates).toContain("Squad B");
  });

  it("refuses an empty sample rather than inventing a team", () => {
    expect(deriveTeam([])).toHaveProperty("unresolved");
  });
});

describe("derivePortfolioChild", () => {
  it("refuses the Squad D shape, which has no majority", () => {
    const sample = [
      ...Array(22).fill({ portfolioChild: "Portfolio A" }),
      ...Array(18).fill({ portfolioChild: "Portfolio C" }),
      ...Array(11).fill({ portfolioChild: "Portfolio D" }),
      ...Array(7).fill({ portfolioChild: "Digital MCP Tool" }),
    ];
    expect(derivePortfolioChild(sample)).toHaveProperty("unresolved");
  });

  it("takes the Squad A shape, which is 55 of 60", () => {
    const sample = [
      ...Array(55).fill({ portfolioChild: "Portfolio A" }),
      ...Array(5).fill({ portfolioChild: "Example Diğer" }),
    ];
    expect(derivePortfolioChild(sample)).toEqual({ value: "Portfolio A" });
  });
});

describe("pickSprint", () => {
  const active = [
    { id: 1251, name: "Squad D Sprint 45" },
    { id: 1249, name: "Squad C Sprint 45" },
    { id: 1243, name: "Squad A Sprint 45" },
    { id: 1234, name: "Squad B Sprint 45" },
  ];

  it("matches the sprint belonging to the team", () => {
    expect(pickSprint(active, "Squad A")).toEqual({ value: 1243 });
  });

  // Six teams exist; four had a sprint when this was measured.
  it("refuses when the team has no active sprint", () => {
    expect(pickSprint(active, "Squad F")).toHaveProperty("unresolved");
  });

  it("refuses when two sprints could match rather than taking the first", () => {
    const ambiguous = [{ id: 1, name: "Squad A Sprint 45" }, { id: 2, name: "Squad A Hotfix 45" }];
    expect(pickSprint(ambiguous, "Squad A")).toHaveProperty("unresolved");
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement.** Majority means strictly more than half of the entries that carry a value. State the threshold as a named constant with the measurement behind it in a comment. `unresolved` carries a sentence a person can act on; `candidates` carries what was actually seen, commonest first.
- [ ] **Step 4: Run the tests** — PASS.
- [ ] **Step 5: Confirm the tests discriminate.** Change majority to plurality and show the Squad D and the not-a-majority tests failing; restore, verified with `diff`.
- [ ] **Step 6: Commit** — `feat(jira): derive the team, refuse to guess the rest`

---

### Task 5: Assembling the payload, and the command

**Files:** Create `src/jira/techtask.ts`, `src/jira/create.ts`; Modify `src/cli.ts`; Test `tests/jira/techtask.test.ts`

**Interfaces — Produces:**
```ts
export type TechTaskInput = {
  config: NonNullable<ShipkitConfig["techTask"]>;
  subject: string;
  team: string;
  sprintId?: number;
  portfolioChild: string;
};
export function buildCreatePayload(input: TechTaskInput): Record<string, unknown>;
export type IssueCreator = (payload: Record<string, unknown>, token: string) => Promise<{ key: string }>;
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { buildCreatePayload } from "../../src/jira/techtask.js";

const config = {
  project: "DCP", issueType: "Story", epic: "ABC-12154",
  summaryPattern: "iOS - {subject} swift ui dönüşümü",
  fields: { customfield_10101: { value: "Commercial" } },
};

const input = { config, subject: "Seyahat özeti", team: "Squad B", sprintId: 1234, portfolioChild: "Portfolio B" };

describe("buildCreatePayload", () => {
  it("writes the summary the team's own tickets use", () => {
    expect((buildCreatePayload(input) as any).fields.summary).toBe("iOS - Seyahat özeti swift ui dönüşümü");
  });

  // Measured: customfield_10101 is a cascading select. A bare {value} is rejected.
  it("nests the portfolio child under its parent", () => {
    expect((buildCreatePayload(input) as any).fields.customfield_10101).toEqual({
      value: "Commercial",
      child: { value: "Portfolio B" },
    });
  });

  it("sets the team and the epic and the sprint", () => {
    const f = (buildCreatePayload(input) as any).fields;
    expect(f.customfield_10102).toEqual({ value: "Squad B" });
    expect(f.customfield_10006).toBe("ABC-12154");
    expect(f.customfield_10005).toBe(1234);
  });

  // Measured: description empty, labels absent on every one of these.
  it("sends no description and no labels", () => {
    const f = (buildCreatePayload(input) as any).fields;
    expect(f.description).toBeUndefined();
    expect(f.labels).toBeUndefined();
  });

  it("omits the sprint rather than sending a null when there is none", () => {
    const f = (buildCreatePayload({ ...input, sprintId: undefined }) as any).fields;
    expect("customfield_10005" in f).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement `buildCreatePayload`** — pure, no network. Then `src/jira/create.ts` with a single `createIssue` behind an injected `Fetcher`, mirroring how `src/jira/client.ts` already does its GET. **No test calls it.**
- [ ] **Step 4: Wire `tech-task` into `src/cli.ts`.** It reads config, requires `techTask` to be present (and says what to add when it is not), derives team, sprint and portfolio child, and on any `unresolved` prints the sentence and the candidates and exits 2 **without creating anything**. `--team`, `--sprint` and `--portfolio` override a derivation. `--dry-run` prints the payload and creates nothing.
- [ ] **Step 5: Prove the refusal path by running it.** Build, then run `node dist/cli.js tech-task --subject "x" --dry-run` in a scratch directory whose config has no `techTask`. It must name what to add and exit non-zero. Put the real output in your report.
- [ ] **Step 6: Full verification and commit** — `npm test`, `npm run check`, then `feat(jira): open the technical item, or say why it cannot`

---

## Done when

- A UIKit→SwiftUI conversion produces advice in `brief` and `submit`, and the exit code is unchanged by it.
- Advice is impossible to pass where a `Warning` is expected.
- `tech-task` builds the measured payload, including the cascading portfolio field.
- Every derivation refuses rather than guessing, and names what it saw.
- No test writes to Jira, calls `gh`, or touches the network. `npm test` and `npm run check` green.

## Next

- Routing the create through the approval surface, so a person sees the fields before anything exists. The surface is built; this is the wiring.
- Conversions other than UIKit→SwiftUI. The mechanism generalises; nothing else has been measured.
