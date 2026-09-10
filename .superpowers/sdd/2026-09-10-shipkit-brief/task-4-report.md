# Task 4 Report: The Two Deferred Rules

## Summary

Successfully implemented two new validation rules in `src/validate/rules.ts`: `branch-pattern` and `issue-level`. Both rules are optional inputs that integrate seamlessly with existing validation logic without breaking any existing functionality.

## Implementation Details

### Files Changed

1. **src/validate/rules.ts**
   - Added import: `import type { IssueFacts } from "../jira/types.js"`
   - Extended `ValidateInput` type with two optional fields:
     - `branch?: string` — when present, checked against `config.branch.pattern`
     - `issues?: IssueFacts[]` — facts for the keys cited in the issues section
   - Added `STORY_LEVEL` constant (`Set(["Story", "Bug"])`)
   - Updated function signature to destructure the new optional parameters
   - Implemented `branch-pattern` rule: validates branch name against configured pattern
   - Implemented `issue-level` rule: enforces story/bug-level citations when `config.jira.linkPolicy === "story"`

2. **tests/validate/rules.test.ts**
   - Added 6 new tests in two describe blocks at top-level (as required):
     - `branch-pattern` describe block (3 tests)
     - `issue-level` describe block (3 tests)

### Implementation Notes

The variable name `issues` in the original code was renamed to `issuesText` to avoid conflict with the new `issues` parameter introduced through destructuring. This keeps variable scope clear and prevents shadowing.

The `issue-level` rule correctly implements the "target a level, don't climb" behavior:
- Accepts Story/Bug issues cited directly
- Only reports findings for non-Story/Bug issues that have parents
- Accepts any issue type that has no parent (already at top of chain)
- Names the parent in the finding message for correction

## TDD Evidence

### RED Phase

Command: `npx vitest run tests/validate/rules.test.ts`

Initial test output (before implementation):
```
FAIL  tests/validate/rules.test.ts > branch-pattern > reports a branch that does not match
  AssertionError: expected [] to include 'branch-pattern'

FAIL  tests/validate/rules.test.ts > issue-level > rejects a Development subtask and names its parent
  AssertionError: expected undefined to be defined

Test Files  1 failed (1)
Tests  2 failed | 15 passed (17)
```

The two targeted tests failed as expected because the rules were not yet implemented.

### GREEN Phase

Command: `npx vitest run tests/validate/rules.test.ts`

After implementation:
```
✓ tests/validate/rules.test.ts (17 tests) 3ms

Test Files  1 passed (1)
Tests  17 passed (17)
```

All 17 tests pass, including the 6 new ones.

### Full Suite Verification

Command: `npx vitest run`

```
Test Files  8 passed (8)
Tests  54 passed (54)
```

All existing tests continue to pass. No regression.

## Test Coverage

The new rules are tested comprehensively:

**branch-pattern tests:**
1. ✓ Accepts branch matching the configured pattern
2. ✓ Reports branch that does not match
3. ✓ Stays silent when no branch is supplied

**issue-level tests:**
1. ✓ Accepts Story cited directly
2. ✓ Rejects Development subtask and names its parent
3. ✓ Accepts issue with no parent whatever its type

## Self-Review Findings

**Completeness:**
- ✓ Both rule IDs match the spec exactly: `branch-pattern` and `issue-level`
- ✓ Both inputs are optional as required
- ✓ Existing callers continue to work unchanged
- ✓ Tests appended at top-level of `tests/validate/rules.test.ts` as instructed
- ✓ Function remains pure and synchronous — no I/O, no `await`

**Code Quality:**
- ✓ No TypeScript errors (`strict: true`)
- ✓ ESM imports use `.js` extensions
- ✓ STORY_LEVEL is a `Set` for O(1) membership testing
- ✓ Rule messages are clear and actionable
- ✓ Destructuring parameters makes intent clear

**Logic Verification:**
- ✓ `branch-pattern`: Correctly tests the branch string against the pattern regex from config
- ✓ `issue-level`: Correctly implements non-climb logic:
  - Only flags non-Story/Bug issues that have a parent
  - Accepts orphan issues of any type
  - Accepts Story/Bug issues regardless of parent status
  - Message includes parent key for user guidance

**Architecture:**
- ✓ No breaking changes to existing function contract
- ✓ Optional parameters follow TypeScript best practices
- ✓ Reuses config and findings infrastructure consistently
- ✓ Validation remains single-pass and deterministic

## Concerns

None. The implementation follows the specification exactly, passes all tests, and integrates cleanly with the existing codebase.

## Commit

```
8fc7d43 feat(validate): enforce branch pattern and issue level
```

Two files modified, 78 insertions, 3 deletions (the 3 deletions come from renaming `issues` to `issuesText` in the existing code).

---

## Fix Report: Test Discrimination Strengthening

**Issue Identified:** The original three `issue-level` test cases all involved issues with no parent, which meant a buggy implementation that only checked for parent existence (without the type check) would incorrectly pass all tests. This would allow a regression where correctly-cited Bug issues with parents would be incorrectly flagged.

### New Test Case Added

Added to `tests/validate/rules.test.ts` in the `issue-level` describe block:

```ts
it("accepts a Bug cited directly even if it has a parent", () => {
  const bugWithParent = {
    key: "ABC-31086", type: "Bug", summary: "b",
    parent: { key: "ABC-31000", type: "Epic", summary: "e" },
  };
  const result = validate({ title: TITLE, body: goodBody, config, issues: [bugWithParent] });
  expect(result.findings.map((f) => f.rule)).not.toContain("issue-level");
});
```

This test ensures that a Bug issue (which is in STORY_LEVEL) is accepted even when it has a parent, directly testing the type check logic.

### Discrimination Evidence

**Test 1 — Buggy Implementation (type check removed):**

File: `src/validate/rules.ts` lines 63-75, modified to:
```ts
if (config.jira.linkPolicy === "story") {
  for (const issue of issues ?? []) {
    if (issue.parent !== undefined) {  // Type check removed!
      findings.push({
        rule: "issue-level",
        message: `${issue.key} is a ${issue.type}; cite its parent ${issue.parent.key} ` +
          `(${issue.parent.type}) instead`,
        section: config.jira.section,
      });
    }
  }
}
```

Command: `npx vitest run tests/validate/rules.test.ts`

Result: **FAIL**
```
❯ tests/validate/rules.test.ts (18 tests | 1 failed) 6ms
  × issue-level > accepts a Bug cited directly even if it has a parent 3ms
    → expected [ 'issue-level' ] to not include 'issue-level'

FAIL  tests/validate/rules.test.ts > issue-level > accepts a Bug cited directly even if it has a parent
AssertionError: expected [ 'issue-level' ] to not include 'issue-level'

Test Files  1 failed (1)
Tests  1 failed | 17 passed (18)
```

The new test correctly catches the bug: it would falsely report a Bug issue that has a parent.

**Test 2 — Correct Implementation (type check restored):**

Restored the line:
```ts
if (!STORY_LEVEL.has(issue.type) && issue.parent !== undefined) {
```

Command: `npx vitest run tests/validate/rules.test.ts`

Result: **PASS**
```
✓ tests/validate/rules.test.ts (18 tests) 3ms

Test Files  1 passed (1)
Tests  18 passed (18)
```

All 18 tests pass, including the new discriminating test.

### Full Suite Verification

Command: `npx vitest run`

Result: **PASS**
```
Test Files  8 passed (8)
Tests  55 passed (55)
```

### Commit

```
7a06f2c test(validate): add discriminating test for issue-level rule
```

One file modified, 9 insertions.

### Summary

The new test case successfully discriminates between the correct implementation and the buggy implementation. The original three test cases were insufficient because they all tested scenarios where no parent existed. The new test ensures that the type check (`!STORY_LEVEL.has(issue.type)`) cannot be removed without causing test failure. This prevents future regressions where Story or Bug issues with parents would be incorrectly flagged.
