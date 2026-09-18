import { randomBytes } from "node:crypto";
import { reviewFingerprint } from "../approval/fingerprint.js";
import { PROTOCOL_VERSION, type ReviewOffer } from "../approval/protocol.js";
import type { ReviewOfferOutcome } from "../approval/client.js";
import type { Advice } from "../advice/types.js";
import { assessChange, assessReadiness } from "../assess/change.js";
import { repoRelative } from "../assess/paths.js";
import { extractIssueKeysFromBody, firstIssueKey, isValidBase } from "../cli-support.js";
import { ConfigError } from "../config/load.js";
import type { ShipkitConfig } from "../config/schema.js";
import { JiraError } from "../jira/client.js";
import type { IssueFacts } from "../jira/types.js";
import type { Warning } from "../preflight/types.js";
import type { ReadinessRule } from "../readiness/types.js";
import { ResponseError, type SubmitResponse } from "../submit/response.js";
import { validate } from "../validate/rules.js";
import type { Finding } from "../validate/types.js";
import { VcsError } from "../vcs/git.js";
import type { PushFileDiff } from "../vcs/git.js";
import type { AddedLine, PullRequestState, RepoState } from "../vcs/types.js";
import type { ChangedFile } from "../advice/uikit.js";
import {
  FIX_REQUEST_PATH,
  FixRequestError,
  type ArchiveOutcome,
  type FixRequest,
  type FixRequestItem,
} from "./fixrequest.js";
import { reviewItems, type ReviewItem } from "./items.js";
import { renderPage } from "./page.js";
import { createHandler, type Listening, type ReviewHandler } from "./server.js";

/**
 * How long an abandoned review may hold a port. Ten minutes is long enough to read four
 * hundred files of diff and short enough that a tab closed without a decision does not leave
 * a process running until the machine is rebooted. The printed line says so, because a wait
 * whose length a person cannot see is one they will not trust.
 */
export const REVIEW_TIMEOUT_MS = 10 * 60 * 1000;

export type ReviewOptions = {
  base: string;
  config: string;
  /** The agent's answer, when there is one. Without it, nothing has been drafted or answered. */
  responsePath?: string | undefined;
  /** A fixed port, when the caller wants a stable URL. 0 asks the kernel for a free one. */
  port: number;
  /** False for `--no-open`: print the URL and wait, rather than launching a browser. */
  open: boolean;
};

export type ReviewResult = {
  code: 0 | 1 | 2;
  findings: Finding[];
  warnings: Warning[];
  advice: Advice[];
  items: ReviewItem[];
  /** What the person chose. Absent when the wait ran out before anyone answered. */
  selected?: FixRequestItem[];
  /** Where the selection was written. Absent when nothing was selected. */
  path?: string;
  /** A refusal or a failure, explained in one line. */
  message?: string;
};

export type ReviewDeps = {
  loadConfig: (path: string) => ShipkitConfig;
  loadResponse: (path: string) => SubmitResponse;
  renderBody: (sections: Record<string, string>, config: ShipkitConfig) => string;
  currentBranch: () => string;
  resolveIssue: (key: string, config: ShipkitConfig) => Promise<IssueFacts | undefined>;
  loadReadiness?: (() => ReadinessRule[] | undefined) | undefined;
  readRepoState: (base: string) => RepoState;
  readPushDiffstat: (base: string, exclude: string[]) => string;
  readPushAddedLines: (base: string, exclude: string[]) => AddedLine[];
  readPushChangedFiles: (base: string, exclude: string[]) => ChangedFile[];
  readPushChangedPaths?: ((base: string, exclude: string[]) => string[]) | undefined;
  readPushDiff: (base: string, exclude: string[]) => PushFileDiff[];
  readUntrackedFiles: () => string[];
  readRepoRoot: () => string;
  realpath: (path: string) => string;
  findPullRequest: (branch: string) => PullRequestState | null;
  /** Root-relative paths of selection files already lying in the repository. */
  fixRequestExclusions: () => string[];
  writeFixRequest: (request: FixRequest) => string;
  /**
   * Moves aside the selection already lying in the repository, if there is one.
   *
   * Reached when a person ticks nothing and presses send — which is how they say "I have
   * read this and it is fine now". Without it the previous selection stayed armed, and the
   * message said "No fix request was written", which is true and reads as "nothing is
   * pending": the next brief re-issued instructions the person had just decided were done,
   * under a header saying a person chose them.
   */
  clearFixRequest?: (() => ArchiveOutcome) | undefined;
  /** Anything worth telling the reader that is not a finding — read after the assessment. */
  notes?: (() => string[]) | undefined;
  /** Binds the handler to a loopback socket. Injected so no test opens a port. */
  listen: (handler: ReviewHandler, port: number) => Promise<Listening>;
  /**
   * Offers the same review to the menu bar, so it can be answered from either surface.
   *
   * Optional: most people run this with no application installed, and the page is a complete
   * answer on its own. Returns a `cancel` the winning surface uses to close the losing one —
   * the application notices the peer going away and withdraws the review from the panel.
   */
  offerReview?:
    | ((offer: ReviewOffer) => { answer: Promise<ReviewOfferOutcome>; cancel: () => void })
    | undefined;
  openBrowser?: ((url: string) => void) | undefined;
  openEditor?: ((path: string, line: number) => void) | undefined;
  now: () => Date;
  /** The wait. Injected so no test sits through ten minutes of it. */
  wait: (ms: number) => Promise<void>;
  out: (line: string) => void;
  err: (line: string) => void;
};

/**
 * Show the change and the findings, take one answer, write it down. Push nothing.
 *
 * Everything it knows, it learns from `assessReadiness` and `assessChange` — the same two
 * functions `runSubmit` learns it from, so a page that showed a different set of problems
 * than the submit will enforce is not something this code can express. What it adds is the
 * diff, the page, and the loopback surface.
 *
 * There is no commit, no push and no `gh pr create` anywhere in this file, and nothing it
 * calls can perform one: the dependency list has no mutating member to give it.
 */
export async function runReview(
  options: ReviewOptions,
  deps: ReviewDeps,
): Promise<ReviewResult> {
  const empty = { findings: [], warnings: [], advice: [], items: [] };

  if (!isValidBase(options.base)) {
    const message = `Refusing to use ${JSON.stringify(options.base)} as a base branch`;
    deps.err(message);
    return { ...empty, code: 2, message };
  }

  try {
    const config = deps.loadConfig(options.config);
    const branch = deps.currentBranch();

    // Without a response there is no title, no body and no readiness answers — which is a
    // reviewable state, not an error. A person can look at what the change does and at what
    // pre-flight says about pushing it long before an agent has drafted anything.
    const response =
      options.responsePath === undefined ? undefined : deps.loadResponse(options.responsePath);

    let body: string | undefined;
    let findings: Finding[] = [];
    let ticketKey: string | undefined;
    let issueVerified = true;
    if (response !== undefined) {
      body = deps.renderBody(response.sections, config);
      const citedKeys = extractIssueKeysFromBody(body, config);
      const resolvedIssues = await Promise.all(
        citedKeys.map((key) => deps.resolveIssue(key, config)),
      );
      const issues = resolvedIssues.filter((issue): issue is IssueFacts => issue !== undefined);
      issueVerified = resolvedIssues.every((issue) => issue !== undefined);
      // Unlike `runSubmit`, a failing `validate` does not return here. The whole point of
      // this command is to put what is wrong in front of a person; stopping at the first
      // channel would show them the title problem and hide the four pre-flight warnings
      // underneath it.
      findings = validate({ title: response.title, body, config, branch, issues }).findings;
      ticketKey = firstIssueKey(response.title, config.jira.keyPattern) ?? citedKeys[0];
    }

    // Exactly the exclusion `runSubmit` computes, plus the selection files this command is
    // about to add to. Both are shipkit's own working files and neither is ever part of the
    // change — see src/review/fixrequest.ts for the measurement behind the archives.
    let responseRelative: string | undefined;
    if (options.responsePath !== undefined) {
      try {
        responseRelative = repoRelative(options.responsePath, deps);
      } catch {
        throw new ResponseError(
          `Cannot locate the response file at ${options.responsePath} — it was readable a moment ago`,
        );
      }
    }
    const exclude = [
      ...(responseRelative === undefined ? [] : [responseRelative]),
      ...deps.fixRequestExclusions(),
    ];

    const rules = deps.loadReadiness?.();
    const readiness =
      rules === undefined
        ? { findings: [], warnings: [], advice: [] }
        : assessReadiness({
            rules,
            base: options.base,
            exclude,
            answers: response?.readiness,
            readPushChangedPaths: deps.readPushChangedPaths,
          });

    const change = assessChange(
      { base: options.base, branch, exclude, ticketKey, issueVerified, config },
      deps,
    );

    const allFindings = [...findings, ...readiness.findings];
    const allWarnings = [...change.warnings, ...readiness.warnings];
    const allAdvice = [...change.advice, ...readiness.advice];
    const items = reviewItems({
      findings: allFindings,
      warnings: allWarnings,
      advice: allAdvice,
    });

    const files = deps.readPushDiff(options.base, exclude);
    const diffstat = deps.readPushDiffstat(options.base, exclude);

    // 32 random bytes, hex. The URL is printed to this terminal and handed to a browser, and
    // it is the only thing standing between a process on this machine and the page — so it
    // comes from the CSPRNG, not from a timestamp or a pid.
    const token = randomBytes(32).toString("hex");
    const page = renderPage({
      repo: repoName(deps.readRepoRoot()),
      branch,
      base: options.base,
      commitMessage: response?.commitMessage,
      diffstat,
      items,
      files,
      answered: response?.readiness !== undefined,
      notes: deps.notes?.() ?? [],
      token,
      waitMinutes: Math.round(REVIEW_TIMEOUT_MS / 60000),
    });

    let answered: FixRequestItem[] | undefined;
    let written: string | undefined;
    // Left uninitialised on purpose: a declaration with a value narrows to that value, and
    // TypeScript keeps the narrowing across the assignment the closure below makes.
    let cleared: ArchiveOutcome | undefined;
    let resolveAnswer: () => void = () => undefined;
    const answer = new Promise<void>((resolve) => {
      resolveAnswer = resolve;
    });

    /**
     * One answer, from whichever surface got there first.
     *
     * The disk work happens here, inside the request that carried the selection, rather than
     * after the wait returns. It used to happen after, which meant the page's "Sent to
     * shipkit. You can close this tab." was printed before anything had been written — and
     * when the write failed the person had already closed the tab. A throw from here reaches
     * the page's handler, which answers 500 with the reason and leaves the review answerable.
     *
     * The menu bar has no such retry: it sends its answer and the connection closes, so it
     * cannot be told that a write failed afterwards. That is why the panel's confirmation
     * says the selection was sent rather than saved, and why a failure from that path is
     * printed here — the person is at the terminal that started the review.
     */
    const accept = (selection: FixRequestItem[]): void => {
      if (selection.length > 0) {
        written = deps.writeFixRequest({
          version: 1,
          createdAt: deps.now().toISOString(),
          base: options.base,
          branch,
          items: selection,
        });
      } else {
        cleared = deps.clearFixRequest?.() ?? { kind: "none" };
      }
      answered = selection;
      resolveAnswer();
    };

    const handler = createHandler({
      token,
      page,
      submit: accept,
      openEditor: deps.openEditor,
      openable: new Set(files.map((file) => file.path)),
    });

    const server = await deps.listen(handler, options.port);
    const url = `${server.origin}/?token=${token}`;

    // Built from the same `items` and `files` the page draws, and hashed over exactly the
    // fields the panel displays: what the person sees is what was bound, so a panel cannot
    // show one review and answer a different one.
    const root = deps.readRepoRoot();
    const situation = {
      repo: repoName(root),
      root,
      branch,
      base: options.base,
      commitMessage: response?.commitMessage ?? "",
      diffstat,
      items: items.map((item) => ({
        kind: item.kind,
        id: item.id,
        message: item.message,
        severity: item.severity,
      })),
      files: files.map((file) => ({ path: file.path, status: file.status, line: file.line })),
    };
    const offer: ReviewOffer = {
      protocol: PROTOCOL_VERSION,
      kind: "review",
      fingerprint: reviewFingerprint(situation),
      ...situation,
    };
    const offered = deps.offerReview?.(offer);

    try {
      deps.out(url);
      deps.err(
        `Waiting up to ${Math.round(REVIEW_TIMEOUT_MS / 60000)} minutes for one answer. ` +
          "Nothing is committed, pushed, or sent anywhere.",
      );
      if (options.open) deps.openBrowser?.(url);

      // Deliberately not part of the race below. The panel's answer goes through the very
      // `accept` the page's does, and `accept` resolves the promise the race is already
      // waiting on — so adding this promise would only add a second way to end the review,
      // one that fires on *any* settlement including "there is no application installed",
      // which is the ordinary case and would end every review the moment it started.
      //
      // Everything that is not an answer is reported and otherwise ignored: the page is
      // still open and still able to answer, so one broken surface must not end a review
      // the other could finish.
      void offered?.answer.then((outcome) => {
        if (outcome.outcome === "failed") {
          deps.err(`The menu bar could not answer this review: ${outcome.detail}`);
          return;
        }
        if (outcome.outcome !== "answered") return;
        try {
          accept(outcome.response.answer === "nothing" ? [] : outcome.response.items);
        } catch (error) {
          deps.err(
            "The selection sent from the menu bar could not be written: " +
              `${error instanceof Error ? error.message : String(error)}. ` +
              "The page is still open; answering there reports the failure where you can act on it.",
          );
        }
      });

      await Promise.race([answer, deps.wait(REVIEW_TIMEOUT_MS)]);
    } finally {
      // Closes the losing surface. When the page won, the application sees its peer go away
      // and withdraws the review from the panel without asking anyone anything.
      offered?.cancel();
      await server.close();
    }

    if (answered === undefined) {
      // A wait that ran out is not a person saying "this is fine" — nobody said anything —
      // so a selection already lying here is left exactly as it was. Named, though: silence
      // plus "nothing was written" reads as "nothing is pending", and the next brief would
      // then carry instructions this run gave no hint about.
      const pending = deps.fixRequestExclusions().includes(FIX_REQUEST_PATH);
      const message =
        "No answer arrived before the wait ran out. Nothing was written; run shipkit review again." +
        (pending
          ? ` An earlier selection is still waiting in ${FIX_REQUEST_PATH} and the next shipkit brief will carry it.`
          : "");
      deps.err(message);
      return { ...empty, code: 2, findings: allFindings, warnings: allWarnings, advice: allAdvice, items, message };
    }

    if (answered.length === 0) {
      // Writing an empty selection was rejected: `brief` would then carry a `fixRequest`
      // saying a person chose nothing, which is noise dressed as instruction. What an empty
      // selection *does* mean is that whatever was asked for before is settled, so any
      // earlier selection is cleared here rather than left armed.
      const message =
        cleared?.kind === "moved"
          ? `Nothing was selected. The earlier selection was cleared and kept at ${cleared.path}.`
          : cleared?.kind === "failed"
            ? `Nothing was selected, and the earlier selection could not be cleared: ${cleared.detail}. ` +
              `Delete ${FIX_REQUEST_PATH}, or the next shipkit brief will carry it anyway.`
            : "Nothing was selected. No fix request was written.";
      deps.err(message);
      return {
        ...empty,
        code: 0,
        findings: allFindings,
        warnings: allWarnings,
        advice: allAdvice,
        items,
        selected: answered,
        message,
      };
    }

    // Written inside `submit`, above, so the page's confirmation follows the write rather
    // than preceding it. `answered.length > 0` here is exactly the branch that wrote.
    const path = written as string;
    deps.out(path);
    deps.err(
      `${answered.length} item${answered.length === 1 ? "" : "s"} written. ` +
        "The next shipkit brief will carry them to the agent.",
    );
    return {
      code: 0,
      findings: allFindings,
      warnings: allWarnings,
      advice: allAdvice,
      items,
      selected: answered,
      path,
    };
  } catch (error) {
    if (
      error instanceof ConfigError ||
      error instanceof ResponseError ||
      error instanceof VcsError ||
      error instanceof JiraError ||
      error instanceof FixRequestError
    ) {
      deps.err(error.message);
      return { ...empty, code: 2, message: error.message };
    }
    throw error;
  }
}

/** What a person calls the repository: the directory name, not the absolute path. */
function repoName(root: string): string {
  const parts = root.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? root;
}
