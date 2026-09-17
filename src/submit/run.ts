import { observedAddedLines } from "../advice/observe.js";
import type { Advice } from "../advice/types.js";
import type { ChangedFile } from "../advice/uikit.js";
import { assessChange, assessReadiness } from "../assess/change.js";
import { repoRelative } from "../assess/paths.js";
import { changedFields, fingerprint, sortWarnings, type Situation } from "../approval/fingerprint.js";
import {
  gate,
  shouldRequestApproval,
  type ApprovalAnswer,
  type ApprovalOutcome,
  type GateReason,
  type GateResult,
} from "../approval/policy.js";
import { PROTOCOL_VERSION, type ApprovalRequest } from "../approval/protocol.js";
import { extractIssueKeysFromBody, firstIssueKey, isValidBase } from "../cli-support.js";
import { ConfigError } from "../config/load.js";
import type { ShipkitConfig } from "../config/schema.js";
import { JiraError } from "../jira/client.js";
import type { IssueFacts } from "../jira/types.js";
import { preflight } from "../preflight/checks.js";
import type { Warning } from "../preflight/types.js";
import type { ReadinessRule } from "../readiness/types.js";
import { validate } from "../validate/rules.js";
import type { Finding } from "../validate/types.js";
import { VcsError, type RepoState } from "../vcs/git.js";
import type { AddedLine, PullRequestState } from "../vcs/types.js";
import type { ArchiveOutcome } from "../review/fixrequest.js";
import { ResponseError, type SubmitResponse } from "./response.js";

export type Acknowledgement = "all" | string[];

export type SubmitOptions = {
  base: string;
  config: string;
  response: SubmitResponse;
  /** Where the response was read from. Omitted when it never came from a file. */
  responsePath?: string;
  mode: "preview" | "apply";
  /** "all" is the CLI's --yes. An array names the check ids the caller has seen. */
  acknowledge: Acknowledgement;
};

export type SubmitResult = {
  code: 0 | 1 | 2;
  findings: Finding[];
  warnings: Warning[];
  /**
   * What shipkit noticed and will not insist on. Absent on the two refusals that return
   * before it is read, and an empty array on every run that had nothing to say.
   *
   * Structurally separate from `warnings`, and that separation is the feature: advice
   * never reaches `shouldRequestApproval`, never reaches `gate`, and never reaches the
   * fingerprint, so a push carrying a conversion is neither blocked nor sent to a person
   * under `pr.approval: human`. tests/advice/types.test.ts holds the two types apart at
   * compile time; this field is where that promise is kept at run time.
   *
   * A readiness rule of severity `advise` whose answer was `fail` arrives here too, by the
   * same route and with the same guarantees.
   */
  advice?: Advice[];
  /** The rendered body, once there is one. Absent when the run failed before rendering. */
  body?: string;
  /** Set when a pull request was opened or updated. */
  url?: string;
  /** True when `url` names a pull request that already existed. */
  updated?: boolean;
  /** A refusal or failure explained in one line. Absent on success. */
  message?: string;
  committed: boolean;
  pushed: boolean;
  /** What the person said, when one was asked. Absent when nobody was. */
  approval?: ApprovalOutcome;
  /**
   * The situation the question was about. Present whenever one was asked, and
   * the reason a timed-out call can be resumed: the surface keys its journal by
   * this, so calling again with the same situation finds the decision waiting
   * rather than starting over.
   */
  approvalFingerprint?: string;
  /**
   * Why the gate refused, when it did. Each interface words its own remedy from
   * this rather than guessing one from `code` and `warnings.length` — a guess
   * that cannot tell "unacknowledged" (where --yes / acknowledge would help)
   * apart from "denied", "timed-out", "no-surface" or "human-required" (where
   * it would not).
   */
  refusal?: GateReason;
};

/**
 * One member per adapter the sequence calls, plus two output sinks. Pure functions used by
 * the sequence (`isValidBase`, `firstIssueKey`, `extractIssueKeysFromBody`, `validate`,
 * `preflight`) are imported directly above instead of injected — they take no dependency
 * worth faking, and every test in tests/submit/run.test.ts exercises the real ones.
 *
 * `resolveIssue` is called once per key the response body cites (via
 * `extractIssueKeysFromBody`), never with an undefined key — so its "no key" short-circuit
 * (see cli-support.ts) never triggers here; only its "no token" short-circuit can produce an
 * `undefined` for a call made from this module.
 */
export type SubmitDeps = {
  loadConfig: (path: string) => ShipkitConfig;
  renderBody: (sections: Record<string, string>, config: ShipkitConfig) => string;
  currentBranch: () => string;
  resolveIssue: (key: string, config: ShipkitConfig) => Promise<IssueFacts | undefined>;
  readRepoState: (base: string) => RepoState;
  /**
   * What the push will deliver, not what is already committed. Takes the same
   * `exclude` that `commitAll` is given, because the size of the change a person
   * approves has to be the size of the change that lands.
   */
  readPushDiffstat: (base: string, exclude: string[]) => string;
  /**
   * The `.swift`/`.xib`/`.storyboard` files the push will deliver, with the text on both
   * sides, for `detectConversion`. Takes the same `exclude` as `commitAll` and
   * `readPushDiffstat` for the same reason: the observation has to be about the change
   * that lands, and it has to see uncommitted work, since `commitAll` stages after the
   * gate.
   */
  readPushChangedFiles: (base: string, exclude: string[]) => ChangedFile[];
  /**
   * Every line the push will add, for the `comment-lines` check. Same `exclude`, and same
   * reason, as the two reads above: the question is about the change that lands, and it
   * has to see uncommitted work because `commitAll` stages after the gate.
   */
  readPushAddedLines: (base: string, exclude: string[]) => AddedLine[];
  /**
   * Every path this push will deliver, of every type, for filtering readiness rules by
   * `appliesTo`. Same `exclude`, and the same uncommitted-work reading, as the three reads
   * above — a filter that cannot see uncommitted work excuses every rule on exactly the
   * run that has everything to check.
   *
   * Optional, like `loadReadiness` below, and for the same reason: a caller that supplies
   * neither is a caller with no readiness rules, and every `.shipkit.yml` in existence
   * before this feature is such a caller. A caller that supplies rules but not this read
   * is not silently excused — `applicable` then carries every rule rather than none.
   */
  readPushChangedPaths?: (base: string, exclude: string[]) => string[];
  /**
   * This repository's readiness rules, or `undefined` when it configures none.
   *
   * A closure rather than a path, so the pure core never touches the filesystem: src/cli.ts
   * and src/mcp/server.ts each build it from the config path they already hold, and a
   * broken rules file throws `ConfigError` out of it — caught below and reported like any
   * other bad input, never quietly turning enforcement off.
   */
  loadReadiness?: () => ReadinessRule[] | undefined;
  findPullRequest: (branch: string) => PullRequestState | null;
  readUntrackedFiles: () => string[];
  /**
   * Root-relative paths of the review selection files lying in this repository —
   * `.shipkit/fix-request.json` and anything already archived beside it. They get exactly
   * the treatment the response file gets, for the same reason: they are shipkit's own
   * working files and are never part of the change.
   *
   * Optional, like `loadReadiness`: a caller that supplies none is a caller with no review
   * selection, which is every caller that existed before `shipkit review` did, and every run
   * in a repository nobody has reviewed. Such a run passes exactly the exclusions it always
   * did.
   */
  fixRequestExclusions?: () => string[];
  /**
   * Moves a consumed selection aside, so a stale one cannot haunt the next run. Called only
   * once the push has landed — a submit that refuses must leave the selection where it is,
   * because the work it asks for has not been done yet.
   */
  archiveFixRequest?: () => ArchiveOutcome;
  readRepoRoot: () => string;
  readHeadSha: () => string;
  realpath: (path: string) => string;
  requestApproval: (request: ApprovalRequest, timeoutMs: number) => Promise<ApprovalAnswer>;
  commitAll: (message: string, exclude: string[]) => void;
  pushBranch: (branch: string) => void;
  createPullRequest: (input: { title: string; body: string; base: string; head: string }) => string;
  out: (line: string) => void;
  err: (line: string) => void;
};

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
      // Naming how to start it is the difference between a refusal someone can
      // act on and one they can only be annoyed by: this is the reason a person
      // is most likely to meet first, and the app is not something they can be
      // expected to guess the existence of.
      return (
        "Refusing to proceed. This repository requires an approval, and the " +
        "approval surface is not running. Start it with ./scripts/app.sh && " +
        "open apps/menubar/build/shipkit.app, then call again."
      );
    case "human-required":
      return "Refusing to proceed. This repository requires an approval from a person.";
  }
}

/**
 * Validate the agent's answer, warn about what pushing will disturb, then commit, push and
 * open the pull request — in that order. Returns a structured result — including the exit
 * code the CLI sets `process.exitCode` to — rather than setting `process.exitCode` itself,
 * and writes through `deps.out`/`deps.err` rather than `console` so the whole sequence,
 * including the parts that mutate the repository, can be driven by fakes in tests instead of
 * a real git checkout.
 */
export async function runSubmit(options: SubmitOptions, deps: SubmitDeps): Promise<SubmitResult> {
  if (!isValidBase(options.base)) {
    const message = `Refusing to use ${JSON.stringify(options.base)} as a base branch`;
    deps.err(message);
    return { code: 2, findings: [], warnings: [], message, committed: false, pushed: false };
  }

  // Tracks how far the mutating tail got before a VcsError escaped, so the error report can
  // say what state the repository was actually left in — a local commit is cheap to keep,
  // amend, or drop, but only telling the reader it exists lets them make that call instead of
  // discovering it themselves the next time `commitAll` fails on "nothing to commit".
  let committed = false;
  let pushed = false;
  // Hoisted for the same reason as `committed`/`pushed`: a typed error thrown by the mutating
  // tail (after both have been computed) must still be able to report the body that was
  // rendered and the warnings that were accepted, rather than the catch claiming neither ever
  // existed.
  let body: string | undefined;
  let warnings: Warning[] = [];
  // Hoisted for the same reason, and returned from every exit below that has read it — an
  // observation the run made and then dropped on the way out is the failure this whole
  // change exists to close.
  let advice: Advice[] = [];

  try {
    const config = deps.loadConfig(options.config);
    const response = options.response;
    body = deps.renderBody(response.sections, config);
    const branch = deps.currentBranch();

    // `issue-level` checks the keys the body *cites* (the same source of truth `check`
    // uses), not the branch's key — see the report for why the branch cannot be trusted
    // to carry one at all under configs like docs/examples/example-app.shipkit.yml.
    const citedKeys = extractIssueKeysFromBody(body, config);
    const resolvedIssues = await Promise.all(
      citedKeys.map((key) => deps.resolveIssue(key, config)),
    );
    const issues = resolvedIssues.filter((issue): issue is IssueFacts => issue !== undefined);
    // "Every cited key was resolved." Vacuously true when nothing was cited — there is then
    // nothing for issue-level to have skipped, so issue-unverified (below) has nothing to warn
    // about either, regardless of what ticketKey (the title's key) turns out to be.
    const issueVerified = resolvedIssues.every((issue) => issue !== undefined);

    const result = validate({
      title: response.title,
      body,
      config,
      branch,
      issues,
    });
    if (!result.ok) {
      for (const finding of result.findings) {
        deps.err(`${finding.rule}: ${finding.message}`);
      }
      return {
        code: 1,
        findings: result.findings,
        warnings: [],
        body,
        committed: false,
        pushed: false,
      };
    }

    // This change's identity, which foreign-commits compares the branch's commits against.
    // The title first, when it carries a key — that is the most explicit statement of what
    // the work is. Otherwise the first key the body cites.
    //
    // Neither source can be assumed. The branch cannot carry a key at all under the
    // reference config, whose branch.pattern admits no uppercase. And the title need not
    // either: that repository's own workflow derives the ticket tag from the branch and
    // prepends it when the pull request opens, so requiring authors to write one produced
    // titles carrying two, and the pattern dropped it. The body is the one place a key is
    // always present, because issue-key-missing refuses a body without one.
    const ticketKey =
      firstIssueKey(response.title, config.jira.keyPattern) ?? citedKeys[0];

    // The response file is shipkit's own input, never part of the change, so it is excluded
    // from staging rather than merely reported — and dropped from the warning too, since a
    // warning that fires on every single run is one nobody reads. Everything else untracked
    // is the author's to judge, which is what the warning is for.
    //
    // Paths here are repository-root-relative, which is what the pathspec needs and what
    // `readUntrackedFiles` returns. `repoRelative` (src/assess/paths.ts) holds the realpath
    // and separator rules and the reasons for both; a response file written outside the
    // repository comes back `undefined` and is not excluded at all, because git rejects an
    // out-of-tree pathspec outright and staging can never reach it anyway.
    let relativeToRoot: string | undefined;
    if (options.responsePath !== undefined) {
      try {
        relativeToRoot = repoRelative(options.responsePath, deps);
      } catch {
        // The file was readable a moment ago (whoever built `options.response` read it), so
        // failing here means it vanished underneath us. Report it the way every other bad
        // input is reported rather than letting an ENOENT escape the typed-error catch below
        // and crash with a stack trace.
        throw new ResponseError(
          `Cannot locate the response file at ${options.responsePath} — it was readable a moment ago`,
        );
      }
    }
    // The review selection joins it, when a person has made one. Same status, same
    // treatment, and in every place the exclusion is passed rather than only at the commit.
    const exclude = [
      ...(relativeToRoot === undefined ? [] : [relativeToRoot]),
      ...(deps.fixRequestExclusions?.() ?? []),
    ];

    // The team's readiness rules, carried to the agent by `brief` and answered in the
    // response. Read here — as soon as `exclude` exists, and before the repository state or
    // the forge is consulted — so that all three of its channels land where they belong:
    // findings refuse alongside validation's, and for the same reason they refuse *here*,
    // which is that a refusal about the form of an answer has no business waiting on
    // `gh pr list` to succeed; warnings join pre-flight's below, before
    // `shouldRequestApproval` and before the situation the fingerprint is taken over; and
    // advice joins the advisory channel further down.
    // In preview as well as apply: a rule the agent only learns about from `apply` arrives
    // after the body it should have shaped is already written.
    //
    // `check` has no part in this on purpose. It validates a title and a body file and
    // there is no response file for it to read an answer from, so it stays form-only — a
    // reader looking for readiness enforcement there is looking in the one command that
    // structurally cannot have it.
    const rules = deps.loadReadiness?.();
    let readinessWarnings: Warning[] = [];
    let readinessAdvice: Advice[] = [];
    if (rules !== undefined) {
      // The same three steps `shipkit review` takes, in the same function — see
      // src/assess/change.ts. Two readings of "which rules does this change owe an answer
      // for" would drift, and the page a person ticks boxes on has to be about the submit
      // that will follow it.
      const readiness = assessReadiness({
        rules,
        base: options.base,
        exclude,
        answers: response.readiness,
        readPushChangedPaths: deps.readPushChangedPaths,
      });
      readinessWarnings = readiness.warnings;
      readinessAdvice = readiness.advice;

      // Merged with validation's findings because the two refuse alike. In practice
      // `result.findings` is empty by the time control reaches here — a failing `validate`
      // returns above, before the repository is touched at all — and the merge is written
      // out anyway so that the two channels cannot drift into being handled differently.
      const findings = [...result.findings, ...readiness.findings];
      if (findings.length > 0) {
        for (const finding of findings) {
          deps.err(`${finding.rule}: ${finding.message}`);
        }
        return { code: 1, findings, warnings: [], body, committed: false, pushed: false };
      }
    }


    // The repository state, the forge, the working tree, pre-flight over all three, and the
    // conversion observation — in one function, because `shipkit review` has to show a
    // person exactly the set of problems this run is about to enforce. See
    // src/assess/change.ts.
    //
    // The advisory read moved one step earlier than it used to sit: it now happens inside
    // this call, before the warnings are printed rather than after. Nothing downstream
    // consults `advice` — it is not in `gate`, not in `shouldRequestApproval`, not in the
    // `Situation`, and not on the wire to the approval surface — so the only thing that
    // changed is which line of stderr appears first.
    const assessment = assessChange(
      { base: options.base, branch, exclude, ticketKey, issueVerified, config },
      deps,
    );
    const repo = assessment.repo;
    // Reassigned below when a re-derivation runs and the situation is unchanged: the
    // open-or-update decision at the end of this function must act on the pull request
    // as it stands now, not as it stood when the person was first asked.
    let existingPr = assessment.pullRequest;

    warnings = [
      ...assessment.warnings,
      // Appended rather than interleaved: `sortWarnings` puts them in canonical order for
      // the fingerprint and the panel, so position here decides only the order they are
      // printed in — pre-flight's findings about the push first, then the answers about the
      // work.
      ...readinessWarnings,
    ];

    if (warnings.length > 0) {
      for (const warning of warnings) {
        deps.err(`${warning.check}: ${warning.message}`);
      }
    }

    // Set before the gate, so `preview` carries it too: preview is where the agent asks what
    // pushing would do, and an observation it only ever learns from `apply` arrives after
    // the body it should have shaped is already written.
    advice = [...assessment.advice, ...readinessAdvice];
    // `err`, like the warnings above, because `out` is where the pull-request URL goes and
    // a caller piping stdout is reading that.
    for (const item of advice) deps.err(item.message);

    if (options.mode === "preview") {
      return { code: 0, findings: [], warnings, advice, body, committed: false, pushed: false };
    }

    let approval: ApprovalOutcome | undefined;
    let approvalFingerprint: string | undefined;
    // Set only when the surface's answer could not be taken at face value — chiefly a
    // protocol version disagreement, which `requestApproval` maps to a plain "denied"
    // outcome but carries the real reason in `detail` so it is not lost entirely.
    let approvalDetail: string | undefined;

    if (shouldRequestApproval({ policy: config.pr.approval, warnings, acknowledge: options.acknowledge })) {
      // repoRoot is not in scope here — it is only read above inside the
      // `options.responsePath !== undefined` branch. It cannot be hoisted above this
      // branch either: an existing test asserts readRepoRoot is never called when the
      // response came from no file, and hoisting would call it on every run.
      const repoPath = deps.realpath(deps.readRepoRoot());

      // Reading the facts is what makes a situation; both the question and the check
      // after the answer are built from the same helper so they cannot drift.
      const situationOf = (facts: {
        head: string;
        diffstat: string;
        warnings: Warning[];
      }): Situation => ({
        repo: repoPath,
        branch,
        base: options.base,
        head: facts.head,
        title: response.title,
        commitMessage: response.commitMessage,
        diffstat: facts.diffstat,
        warnings: facts.warnings,
      });

      const head = deps.readHeadSha();
      // Not `repo.diffstat`. That is `base...HEAD`, committed work only, and
      // `commitAll` below stages the whole working tree — so on a branch whose work
      // is still uncommitted it is the empty string, and the panel renders a blank
      // line where the size of the change belongs. The same `exclude` the commit
      // gets, so the stat cannot name a file the commit will leave out.
      const situation = situationOf({
        head,
        diffstat: deps.readPushDiffstat(options.base, exclude),
        warnings,
      });
      approvalFingerprint = fingerprint(situation);
      const answer = await deps.requestApproval(
        {
          protocol: PROTOCOL_VERSION,
          fingerprint: approvalFingerprint,
          repo: situation.repo,
          branch: situation.branch,
          base: situation.base,
          head: situation.head,
          title: response.title,
          commitMessage: response.commitMessage,
          // `situation.diffstat`, never a second reading of it: the wire carries
          // exactly the string that was hashed, so what the panel renders is
          // provably what the fingerprint was taken over.
          diffstat: situation.diffstat,
          // In canonical order, so what a person is shown can never diverge from what
          // was hashed — preflight emits these in check-order, not alphabetical.
          warnings: sortWarnings(warnings),
        },
        config.pr.approvalTimeoutSeconds * 1000,
      );
      approval = answer.outcome;
      approvalDetail = answer.detail;

      // Minutes can pass while a person decides. An approval that survives the
      // situation changing underneath it is worth nothing, so the facts are read
      // again and hashed again before anything is pushed. This is the same
      // property the echoed ids have — checked against what pre-flight produces
      // now, not what it produced when the question was asked.
      if (approval === "approved") {
        // Deliberately not `assessChange`. That function reads the advisory channel too, and
        // this re-derivation exists only to re-hash the facts the fingerprint binds — an
        // extra scratch-index read here would cost a second `git add --all` over the whole
        // tree to produce advice nobody looks at after an approval.
        const freshHead = deps.readHeadSha();
        const freshPr = deps.findPullRequest(branch);
        const freshRepo = deps.readRepoState(options.base);
        const freshWarnings = [
          ...preflight({
            branch,
            base: options.base,
            commits: freshRepo.commits,
            ticketKey,
            issueVerified,
            pullRequest: freshPr,
            untrackedFiles: deps
              .readUntrackedFiles()
              .filter((file) => !exclude.includes(file)),
            addedLines: observedAddedLines(() =>
              deps.readPushAddedLines(options.base, exclude),
            ),
            config,
          }).warnings,
          // The same readiness warnings, not a second evaluation. Everything else here is
          // deliberately re-read, because a situation that changed underneath an approval no
          // longer satisfies it — but the readiness answers are fixed input from the
          // response, and re-deriving which rules apply could surface a newly-applicable
          // rule whose answer is missing. That is a finding, and a finding after a person
          // has approved has nowhere to go: the run is past the point where it can refuse
          // for form. A change to the tree still moves `diffstat` and is caught there.
          ...readinessWarnings,
        ];

        const freshSituation = situationOf({
          head: freshHead,
          // Read again, like everything else here. A file written into the
          // working tree while the person was deciding is a file the push will
          // now carry, and the whole point of re-hashing is that a situation
          // which changed underneath an approval no longer satisfies it.
          diffstat: deps.readPushDiffstat(options.base, exclude),
          warnings: freshWarnings,
        });

        if (fingerprint(freshSituation) !== approvalFingerprint) {
          // Named, not just flagged: "the situation changed" gives a person on a
          // repository that churns nothing to act on, and the retry it invites fails
          // the same way forever. `changedFields` points at what actually moved —
          // usually `diffstat`, which is the one a stray autosave or watcher output
          // touches — without dumping both situations into the message.
          const fields = changedFields(situation, freshSituation);
          const message =
            `The situation changed while the approval was pending (${fields.join(", ")} changed); ` +
            "asking again from the start.";
          deps.err(message);
          for (const warning of freshWarnings) {
            deps.err(`${warning.check}: ${warning.message}`);
          }
          return {
            code: 2,
            findings: [],
            warnings: freshWarnings,
            advice,
            body,
            message,
            approval,
            approvalFingerprint,
            committed: false,
            pushed: false,
          };
        }

        // The re-derivation is authoritative: the open-or-update decision below must
        // act on the pull request as it stands now, not on the one read before the
        // person was asked. A pull request that opened during the wait — with no new
        // warning of its own, so the fingerprint above still matched — must still be
        // updated rather than collided with by an errant createPullRequest.
        existingPr = freshPr;
      }
    }

    const decision = gate({
      policy: config.pr.approval,
      warnings,
      acknowledge: options.acknowledge,
      outcome: approval,
    });

    if (!decision.open) {
      // Neutral on purpose: the remedy differs per interface, and now per policy too.
      // src/cli.ts appends "Re-run with --yes" when that would help, and
      // src/mcp/result.ts appends its own acknowledge guidance.
      const base = refusalMessage(decision, approvalFingerprint);
      // `approvalDetail` is what turns "the push was denied" into a named version
      // disagreement — without it, a stale protocol version is indistinguishable from a
      // person having said no.
      const message = approvalDetail !== undefined ? `${base} (${approvalDetail})` : base;
      deps.err(message);
      return {
        code: 2,
        findings: [],
        warnings,
        advice,
        body,
        message,
        approval,
        approvalFingerprint,
        refusal: decision.reason,
        committed: false,
        pushed: false,
      };
    }

    deps.commitAll(response.commitMessage, exclude);
    committed = true;
    deps.pushBranch(branch);
    pushed = true;

    // Here, and not at the two `code: 0` returns below, because the push is the moment the
    // work a person asked for actually leaves the machine. A `gh pr create` that fails after
    // this point still leaves that work pushed, and a selection carried into the *next*
    // brief would ask the agent to fix what it has already fixed.
    //
    // Every refusal above returns before `commitAll`, so a submit that refuses leaves the
    // selection exactly where `shipkit review` put it.
    const archived = deps.archiveFixRequest?.() ?? { kind: "none" as const };
    if (archived.kind === "moved") {
      deps.err(`The review selection was acted on and moved to ${archived.path}.`);
    } else if (archived.kind === "failed") {
      // Said out loud rather than swallowed. The push has landed, so this cannot fail the
      // run — but the selection is still sitting in the repository, and the next `brief`
      // will carry it again and ask the agent to redo work it has already done. A person
      // who is told can delete the file; a person who is not told cannot even see the loop.
      deps.err(
        `The push landed, but the review selection could not be moved aside: ${archived.detail}. ` +
          "Delete .shipkit/fix-request.json, or the next shipkit brief will ask for these fixes again.",
      );
    }

    // `gh pr create` refuses outright when an open pull request already exists for this head
    // branch — exactly the state approvals-dismissed/base-mismatch/blocking-label exist to
    // warn about. The push above is the job in that case; stop here instead of letting the
    // create call throw and report a false failure.
    if (existingPr !== null) {
      deps.out(existingPr.url);
      deps.err("Pushed to the existing pull request; it was updated, not opened.");
      return {
        code: 0,
        findings: [],
        warnings,
        advice,
        body,
        url: existingPr.url,
        updated: true,
        committed: true,
        pushed: true,
        approval,
        approvalFingerprint,
      };
    }

    const url = deps.createPullRequest({
      title: response.title,
      body,
      base: options.base,
      head: branch,
    });
    deps.out(url);
    return {
      code: 0,
      findings: [],
      warnings,
      advice,
      body,
      url,
      updated: false,
      committed: true,
      pushed: true,
      approval,
      approvalFingerprint,
    };
  } catch (error) {
    if (
      error instanceof ConfigError ||
      error instanceof ResponseError ||
      error instanceof VcsError ||
      error instanceof JiraError
    ) {
      deps.err(error.message);
      // Only a VcsError thrown by pushBranch or createPullRequest can land here with
      // `committed` true — readRepoState/findPullRequest failures happen before commitAll,
      // and the other error classes can't occur this late in the sequence at all. Guarding on
      // `error instanceof VcsError` anyway keeps the claim tied to the failure it actually
      // describes, not merely to which local ran last.
      if (error instanceof VcsError && committed) {
        deps.err(
          pushed
            ? "A commit was created and already pushed to the remote branch; no pull request was opened. It is yours to keep, amend, or drop."
            : "A commit was created locally and has not been pushed. It is yours to keep, amend, or drop.",
        );
      }
      return { code: 2, findings: [], warnings, advice, body, message: error.message, committed, pushed };
    }
    throw error;
  }
}
