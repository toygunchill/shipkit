/**
 * Something shipkit noticed and thinks is worth doing, which it will not insist on.
 *
 * Deliberately not a `Warning`, and deliberately not shaped like one. Any
 * unacknowledged warning makes `shouldRequestApproval` return true, and under
 * `pr.approval: human` that asks a person every time — so advice modelled as a
 * warning would gate every push carrying the thing it merely wanted to mention.
 *
 * The field is `topic` rather than `check` for the same reason the type is
 * separate: it makes handing advice to something expecting a warning a type
 * error rather than a behaviour change nobody notices until a push is blocked.
 */
export type Advice = {
  /** What the advice is about, e.g. `uikit-to-swiftui`. Stable, so callers can suppress one kind. */
  topic: string;
  /** Written for the person who has just finished the work and is about to push. */
  message: string;
};
