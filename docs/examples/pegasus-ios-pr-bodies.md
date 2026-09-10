# Worked examples — example-app PR bodies

The canonical skeleton, used verbatim by 51 of the 78 most recent merged PRs that have
a body:

```
## Summary
---
## Screenshots / Screen Recordings
---
## What to Test
---
## Issues Addressed
---
## Analysis JIRA Issue
```

Eleven of those 78 omit **What to Test**. That is the gap shipkit closes.

Bodies are written in English throughout, including section content.

---

## House style

| Section | Does | Does not |
|---|---|---|
| Summary | 5–6 lines: what was wrong, what changed, and anything a reviewer would otherwise ask. Written for someone who has not opened the diff | Restate the diff, name types and methods, quote commit hashes, or walk through the implementation |
| Screenshots | Before/after, or a plain sentence saying why there is nothing to show | Sit empty with the placeholder comment still in it |
| What to Test | The handful of checks a QA engineer needs, in their language, plus the obvious regressions | Enumerate every edge case, or say "test the payment screen" |
| Issues Addressed | Links at Story/Bug level — the parent when the title carries a subtask, the title's own key when it is already a Story or Bug | Link a Development subtask, or guess at a neighbouring key |

Three examples follow, spanning the change shapes this repository actually sees. Each
is a real change, so the wording can be checked against the diff.

---

# Example 1 — Small behavioural fix

*Basis: `[ABC-31087] fix(invoice): default citizenship from passenger info` — 1 file,
+17/−2.*

## Summary

Add Invoice always defaulted citizenship to **Turkish**, so a foreign passenger was
shown a form asking for a TCKN. Citizenship now follows the passenger: a national ID
on file means Turkish and the TCKN field is shown, no national ID means foreign and
the field is hidden. Clearing the form applies the same rule rather than falling back
to Turkish. This matches how passenger information already behaves, and Android.

---

## Screenshots / Screen Recordings

| Before | After |
|---|---|
| _Turkish selected for a passenger with no national ID_ | _Foreign selected, TCKN field hidden_ |

---

## What to Test

**Screen:** Payment → Add Invoice → Individual

- Passenger **with** a national ID → Turkish selected, TCKN field visible.
- Passenger **without** one → Foreign selected, TCKN field hidden.
- Switch to Corporate and back to Individual → the default follows the passenger again.
- **Regression:** TCKN is only submitted for Individual + Turkish. Corporate invoice flow unchanged.

---

## Issues Addressed

- [ABC-31086](https://jira.example.com/browse/ABC-31086)

---

## Analysis JIRA Issue

> ⚠️ This section is **auto-populated by CI**.
> No manual action is required.

---
---

# Example 2 — UI regression fix

*Basis: `[ABC-31454] feat(credit-card-fields): adopt Brand Identity floating-label inputs`.*

## Summary

The Brand Identity rework changed how the floating label is built, and two
behaviours regressed with it: on focus the label cross-faded into place instead of
sliding up, and tapping the label no longer focused the field. Both are restored.
The input box now also keeps a single height in both states, so the trailing icons
stop shifting as the label moves.

---

## Screenshots / Screen Recordings

| Before | After |
|---|---|
| _Label cross-fades on focus_ | _Label slides up_ |

---

## What to Test

**Screen:** Payment → Pay by Credit Card

- Tap an empty field → the label **slides** up; no fade, no jump.
- Fill a field, dismiss focus, then tap the small label → the field focuses.
- Expiry Date (label floats even when empty) → tapping the label focuses it.
- Box height and the trailing icons (scan, CVV info, clear) stay put as focus changes.
- **Regression:** clear button appears only when focused with text; the divider shows
  only when both clear and an accessory are visible; error state and the password
  field's reveal toggle are unchanged.

---

## Issues Addressed

- [ABC-31444](https://jira.example.com/browse/ABC-31444)

---

## Analysis JIRA Issue

> ⚠️ This section is **auto-populated by CI**.
> No manual action is required.

---
---

# Example 3 — Large removal

*Basis: `[ABC-31789] feat(remove-non-booking-ife): remove non-booking ife sales entry
points` — 46 files, +15/−3924.*

## Summary

IFE is now sold only inside the booking flow. Removes the non-booking entry points —
main menu, Search PNR, and Travel Assistant — along with the legacy IFE selection
screen. Booking IFE sales, the reissue availability check, and IFE in analytics,
summaries and check-in are deliberately untouched. Roughly 3,900 lines removed across
46 files.

---

## Screenshots / Screen Recordings

Nothing to show — the change only removes UI. Verification is that the entry points
below are gone and the retained flows still work.

---

## What to Test

**Gone**
- No IFE entry in the main menu, in PNR search results, or in Travel Assistant.

**Still works**
- **Booking:** the IFE card still appears in Meal & Other SSR, can be added to the cart, and the payment completes.
- **Reissue:** changing flights on a PNR that already has IFE reaches the summary without crashing.
- **Check-in and summaries:** a purchased IFE still shows in the payment summary, check-in summary, and Travel Assistant flight details.

**Regression**
- Other SSRs (seat, meal, baggage, flex, insurance) are unaffected in booking and check-in.

---

## Issues Addressed

- [ABC-31789](https://jira.example.com/browse/ABC-31789)

---

## Analysis JIRA Issue

> ⚠️ This section is **auto-populated by CI**.
> No manual action is required.
