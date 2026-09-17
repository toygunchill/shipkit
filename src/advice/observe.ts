/**
 * The rule that makes the advisory channel safe to call from anywhere: a failed
 * observation is no observation, never a failed run.
 *
 * `readPushChangedFiles` builds a scratch index and runs `git add --all` against the real
 * working tree, which is a great deal more machinery than reading a diffstat. It fails on
 * repositories where nothing is wrong with the change: a `.gitattributes` clean filter
 * marked `required` whose binary is missing (git-lfs not installed), or a single file the
 * process cannot read. Both were reproduced.
 *
 * Before the advisory channel existed, that read only ran inside the `shouldRequestApproval`
 * branch, so a repository on the default `echo` policy never reached it. The channel put it
 * on the path of every `brief`, every `preview` and every `submit` — and an unguarded call
 * there turns an observation shipkit merely wanted to mention into `code: 2` with nothing
 * committed, no brief printed, or `isError: true` over MCP. Advice informs and never gates,
 * so this is the one place that promise has to be kept at run time.
 *
 * The catch is deliberately total, matching `readBlob`'s in src/vcs/git.ts. A `VcsError` is
 * the expected shape, but `mkdtempSync` and `rmSync` throw plain `Error`s that would escape
 * `runSubmit`'s typed catch entirely and reach a person as a stack trace — and any failure
 * of an optional observation is the same thing regardless of its type: no observation.
 *
 * Silent on purpose. There is nothing for a reader to do about it, the run is unaffected,
 * and a line of git plumbing on stderr under every ordinary `brief` is how a channel stops
 * being read at all.
 *
 * The empty array, not `undefined`: `detectConversion([])` already answers "nothing to say",
 * and `assembleBrief` already emits no `advice` key for that, so one value means one
 * behaviour at all three call sites.
 */

import type { AddedLine } from "../vcs/types.js";
import type { ChangedFile } from "./uikit.js";

export function observedChangedFiles(read: () => ChangedFile[]): ChangedFile[] {
  try {
    return read();
  } catch {
    return [];
  }
}

/**
 * The same guard for the lines a push adds.
 *
 * `comment-lines` gates where the advice above only informs, so the trade is worth stating:
 * a read that fails means the check cannot fire, and a push goes out unasked. That is the
 * lesser harm. The alternative — treating a broken scratch index as grounds to refuse — puts
 * a repository with git-lfs missing in a state where nothing can be pushed at all, to enforce
 * a rule about comments.
 */
export function observedAddedLines(read: () => AddedLine[]): AddedLine[] {
  try {
    return read();
  } catch {
    return [];
  }
}
