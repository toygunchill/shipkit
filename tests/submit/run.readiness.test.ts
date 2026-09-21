import { describe, expect, it } from "vitest";
import { fingerprint, sortWarnings } from "../../src/approval/fingerprint.js";
import type { ApprovalRequest } from "../../src/approval/protocol.js";
import { loadConfig } from "../../src/config/load.js";
import type { ShipkitConfig } from "../../src/config/schema.js";
import type { IssueFacts } from "../../src/jira/types.js";
import type { ReadinessRule } from "../../src/readiness/types.js";
import { renderBody, type SubmitResponse } from "../../src/submit/response.js";
import { runSubmit, type SubmitDeps, type SubmitOptions } from "../../src/submit/run.js";
import type { PullRequestState } from "../../src/vcs/types.js";

const CONFIG = loadConfig("tests/fixtures/valid.shipkit.yml");
const HUMAN = loadConfig("tests/fixtures/human-approval.shipkit.yml");
const BRANCH = "bugfix/squad/31087-invoice";

const RESPONSE: SubmitResponse = {
  title: "[ABC-1] fix(x): y",
  commitMessage: "fix(x): y",
  sections: {
    Summary: "It was broken; now it is not.",
    "Screenshots / Screen Recordings": "Nothing to show — logic only.",
    "What to Test": "- one\n- two\n- three",
    "Issues Addressed": "- [ABC-1](https://jira.example.com/browse/ABC-1)",
  },
};

const OPTIONS: SubmitOptions = {
  base: "develop",
  config: "tests/fixtures/valid.shipkit.yml",
  response: RESPONSE,
  responsePath: "/repo/scratch/response.json",
  mode: "apply",
  acknowledge: "all",
};

const SCOPED: ReadinessRule = {
  id: "design-tokens",
  ask: "Do the colours use the right semantic token?",
  appliesTo: ["**/*.swift"],
  severity: "warn",
};
const ALWAYS: ReadinessRule = {
  id: "all-entry-paths",
  ask: "Does the new check hold on every entry path?",
  severity: "warn",
};
const ADVISORY: ReadinessRule = {
  id: "constants-deliberate",
  ask: "Are the magic values deliberate?",
  severity: "advise",
};
const BLOCKING: ReadinessRule = {
  id: "secrets",
  ask: "Any credential in the diff?",
  severity: "block",
};

type Call = { fn: string; args: unknown[] };

function makeDeps(overrides: Partial<SubmitDeps> = {}): {
  deps: SubmitDeps;
  calls: Call[];
  out: string[];
  err: string[];
} {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];

  function record<A extends unknown[], R>(fn: string, impl: (...args: A) => R): (...args: A) => R {
    return (...args: A) => {
      calls.push({ fn, args });
      return impl(...args);
    };
  }

  const defaults: SubmitDeps = {
    loadConfig: () => CONFIG,
    renderBody: (sections: Record<string, string>, config: ShipkitConfig) => renderBody(sections, config),
    currentBranch: () => BRANCH,
    resolveIssue: (key: string) => Promise.resolve({ key, type: "Story", summary: "" } as IssueFacts),
    readRepoState: () => ({ branch: BRANCH, changedFiles: [], diffstat: "", commits: [] }),
    readPushDiffstat: () => " a.swift | 2 +-\n 1 file changed",
    readPushChangedFiles: () => [],
    readPushAddedLines: () => [],
    readPushChangedPaths: () => ["Sources/Scenes/View.swift"],
    findPullRequest: () => null as PullRequestState | null,
    readUntrackedFiles: () => [],
    readRepoRoot: () => "/repo",
    realpath: (path: string) => path,
    readHeadSha: () => "a".repeat(40),
    requestApproval: async () => ({ outcome: "approved" as const }),
    commitAll: () => undefined,
    pushBranch: () => undefined,
    createPullRequest: () => "https://github.com/x/y/pull/1",
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };

  const merged: SubmitDeps = { ...defaults, ...overrides };
  const deps: SubmitDeps = {
    ...merged,
    readPushChangedPaths:
      merged.readPushChangedPaths === undefined
        ? undefined
        : record("readPushChangedPaths", merged.readPushChangedPaths),
    loadReadiness:
      merged.loadReadiness === undefined ? undefined : record("loadReadiness", merged.loadReadiness),
    commitAll: record("commitAll", merged.commitAll),
    pushBranch: record("pushBranch", merged.pushBranch),
    requestApproval: record("requestApproval", merged.requestApproval),
    createPullRequest: record("createPullRequest", merged.createPullRequest),
  };
  return { deps, calls, out, err };
}

function answered(answers: SubmitResponse["readiness"]): SubmitOptions {
  return { ...OPTIONS, response: { ...RESPONSE, ...(answers === undefined ? {} : { readiness: answers }) } };
}

describe("runSubmit without readiness rules", () => {
  // The compatibility claim, made rather than assumed: a repository with no `readiness:`
  // key is a repository where none of this machinery runs at all.
  it("never reads the changed paths when no rules are configured", async () => {
    const { deps, calls } = makeDeps({
      readPushChangedPaths: () => {
        throw new Error("must not be read when no rules are configured");
      },
    });

    const result = await runSubmit(OPTIONS, deps);

    expect(result.code).toBe(0);
    expect(calls.some((call) => call.fn === "readPushChangedPaths")).toBe(false);
  });

  it("runs unchanged when the caller supplies no loadReadiness at all", async () => {
    const { deps } = makeDeps({ loadReadiness: undefined });
    expect((await runSubmit(OPTIONS, deps)).code).toBe(0);
  });
});

describe("runSubmit with readiness rules", () => {
  it("refuses an applicable rule left unanswered, before anything is committed", async () => {
    const { deps, calls, err } = makeDeps({ loadReadiness: () => [SCOPED, ALWAYS] });

    const result = await runSubmit(answered([{ id: "design-tokens", status: "pass" }]), deps);

    expect(result.code).toBe(1);
    expect(result.findings.map((finding) => finding.rule)).toEqual(["readiness-unanswered"]);
    expect(result.findings[0]?.message).toContain("all-entry-paths");
    expect(err.join("\n")).toContain("readiness-unanswered");
    expect(calls.some((call) => call.fn === "commitAll")).toBe(false);
    expect(calls.some((call) => call.fn === "pushBranch")).toBe(false);
  });

  it("asks only about the rules the change touched", async () => {
    // The scoped rule is dropped because nothing matching it is in the push, so answering
    // the unscoped one alone is a complete answer.
    const { deps } = makeDeps({
      loadReadiness: () => [SCOPED, ALWAYS],
      readPushChangedPaths: () => ["docs/README.md"],
    });

    const result = await runSubmit(answered([{ id: "all-entry-paths", status: "pass" }]), deps);

    expect(result.code).toBe(0);
  });

  it("reads the changed paths with the same exclude the commit gets", async () => {
    // The response file is not part of the change, so it must not make a rule apply.
    const { deps, calls } = makeDeps({ loadReadiness: () => [ALWAYS] });

    await runSubmit(
      { ...answered([{ id: "all-entry-paths", status: "pass" }]), responsePath: "/repo/response.json" },
      deps,
    );

    const read = calls.find((call) => call.fn === "readPushChangedPaths");
    expect(read?.args).toEqual(["develop", ["response.json"]]);
    const commit = calls.find((call) => call.fn === "commitAll");
    expect(commit?.args[1]).toEqual(["response.json"]);
  });

  it("carries every rule when the changed paths cannot be read", async () => {
    // Over-asking degrades politely; silently unenforced does not. The scoped rule is
    // asked about anyway, so leaving it unanswered still refuses.
    const { deps } = makeDeps({
      loadReadiness: () => [SCOPED, ALWAYS],
      readPushChangedPaths: () => {
        throw new Error("clean filter 'lfs' failed");
      },
    });

    const result = await runSubmit(answered([{ id: "all-entry-paths", status: "pass" }]), deps);

    expect(result.code).toBe(1);
    expect(result.findings[0]?.message).toContain("design-tokens");
  });

  it("carries every rule when the caller supplies no changed-paths read at all", async () => {
    const { deps } = makeDeps({
      loadReadiness: () => [SCOPED],
      readPushChangedPaths: undefined,
    });

    expect((await runSubmit(answered([]), deps)).findings[0]?.message).toContain("design-tokens");
  });

  it("refuses an n/a with no note", async () => {
    const { deps, err } = makeDeps({ loadReadiness: () => [ALWAYS] });

    const result = await runSubmit(answered([{ id: "all-entry-paths", status: "n/a" }]), deps);

    expect(result.code).toBe(1);
    expect(err.join("\n")).toContain("readiness-note-required");
  });

  it("refuses a failing block rule", async () => {
    const { deps } = makeDeps({ loadReadiness: () => [BLOCKING] });

    const result = await runSubmit(
      answered([{ id: "secrets", status: "fail", note: "a token is still in the fixture" }]),
      deps,
    );

    expect(result.code).toBe(1);
    expect(result.findings.map((finding) => finding.rule)).toEqual(["readiness-secrets"]);
  });

  it("turns a failing warn rule into an ordinary pre-flight warning", async () => {
    const { deps, err } = makeDeps({ loadReadiness: () => [ALWAYS] });

    const result = await runSubmit(
      answered([{ id: "all-entry-paths", status: "fail", note: "Apple Pay path not covered" }]),
      deps,
    );

    expect(result.code).toBe(0);
    expect(result.warnings).toEqual([
      {
        check: "readiness-all-entry-paths",
        message: "Does the new check hold on every entry path? — Apple Pay path not covered",
      },
    ]);
    expect(err.join("\n")).toContain("readiness-all-entry-paths");
  });

  it("gates on that warning like any other when it is not acknowledged", async () => {
    // `no-surface` is the ordinary `echo` repository with no approval app running: the
    // agent's own acknowledgement is then the only thing that can open the gate, and it
    // acknowledged nothing.
    const { deps, calls } = makeDeps({
      loadReadiness: () => [ALWAYS],
      requestApproval: async () => ({ outcome: "no-surface" as const }),
    });

    const result = await runSubmit(
      {
        ...answered([{ id: "all-entry-paths", status: "fail", note: "Apple Pay path not covered" }]),
        acknowledge: [],
      },
      deps,
    );

    expect(result.code).toBe(2);
    expect(result.refusal).toBe("unacknowledged");
    expect(calls.some((call) => call.fn === "commitAll")).toBe(false);
  });

  it("sends a failing advise rule to advice and never to the warnings", async () => {
    const { deps, calls } = makeDeps({
      loadReadiness: () => [ADVISORY],
      loadConfig: () => HUMAN,
      requestApproval: () => {
        throw new Error("advice must never ask a person");
      },
    });

    const result = await runSubmit(
      {
        ...answered([{ id: "constants-deliberate", status: "fail", note: "two values still inline" }]),
        acknowledge: [],
      },
      deps,
    );

    expect(result.code).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(result.advice).toEqual([
      {
        topic: "readiness-constants-deliberate",
        message: "Are the magic values deliberate? — two values still inline",
      },
    ]);
    expect(calls.some((call) => call.fn === "requestApproval")).toBe(false);
  });

  it("enforces in preview as well as apply", async () => {
    const { deps } = makeDeps({ loadReadiness: () => [ALWAYS] });

    const refused = await runSubmit({ ...answered([]), mode: "preview" }, deps);
    expect(refused.code).toBe(1);
    expect(refused.findings.map((finding) => finding.rule)).toEqual(["readiness-unanswered"]);

    const { deps: second } = makeDeps({ loadReadiness: () => [ALWAYS] });
    const warned = await runSubmit(
      {
        ...answered([{ id: "all-entry-paths", status: "fail", note: "Apple Pay path not covered" }]),
        mode: "preview",
      },
      second,
    );
    expect(warned.code).toBe(0);
    expect(warned.warnings.map((warning) => warning.check)).toEqual(["readiness-all-entry-paths"]);
  });
});

// The severity mapping's whole payoff: a warn-failure is a `Warning`, so it reaches the
// approval panel and binds into the fingerprint with no new canonical-form work at all.
describe("a readiness warning under pr.approval: human", () => {
  const failing = answered([
    { id: "all-entry-paths", status: "fail", note: "Apple Pay path not covered" },
  ]);

  it("reaches the ApprovalRequest's warnings like any other warning", async () => {
    const seen: ApprovalRequest[] = [];
    const { deps } = makeDeps({
      loadConfig: () => HUMAN,
      loadReadiness: () => [ALWAYS],
      requestApproval: async (request: ApprovalRequest) => {
        seen.push(request);
        return { outcome: "approved" as const };
      },
    });

    const result = await runSubmit({ ...failing, acknowledge: [] }, deps);

    expect(result.code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.warnings).toEqual([
      {
        check: "readiness-all-entry-paths",
        message: "Does the new check hold on every entry path? — Apple Pay path not covered",
      },
    ]);
  });

  it("binds into the fingerprint, so the same push without it hashes differently", async () => {
    const capture = () => {
      const seen: ApprovalRequest[] = [];
      return {
        seen,
        requestApproval: async (request: ApprovalRequest) => {
          seen.push(request);
          return { outcome: "denied" as const };
        },
      };
    };

    const withReadiness = capture();
    const withoutReadiness = capture();
    const readiness = await runSubmit(
      { ...failing, acknowledge: [] },
      makeDeps({ loadConfig: () => HUMAN, loadReadiness: () => [ALWAYS], requestApproval: withReadiness.requestApproval }).deps,
    );
    const plain = await runSubmit(
      { ...answered([{ id: "all-entry-paths", status: "pass" }]), acknowledge: [] },
      makeDeps({ loadConfig: () => HUMAN, loadReadiness: () => [ALWAYS], requestApproval: withoutReadiness.requestApproval }).deps,
    );

    // The run with a passing answer has no warning at all, so under `human` it is never
    // asked — which is itself the proof that the warning is what put the other on the panel.
    expect(withoutReadiness.seen).toHaveLength(0);
    expect(plain.code).toBe(0);
    expect(readiness.approvalFingerprint).toBeDefined();
    expect(withReadiness.seen[0]?.fingerprint).toBe(readiness.approvalFingerprint);
    expect(withReadiness.seen[0]?.warnings).toEqual(
      sortWarnings([
        {
          check: "readiness-all-entry-paths",
          message: "Does the new check hold on every entry path? — Apple Pay path not covered",
        },
      ]),
    );
  });

  it("survives the re-derivation after the person approves", async () => {
    // The trap: the situation is read again and hashed again after an approval, and a
    // re-derivation that forgot the readiness warnings would differ from the situation the
    // person actually approved — every approved push would report "the situation changed"
    // and refuse, forever.
    const { deps, calls } = makeDeps({ loadConfig: () => HUMAN, loadReadiness: () => [ALWAYS] });

    const result = await runSubmit({ ...failing, acknowledge: [] }, deps);

    expect(result.message).toBeUndefined();
    expect(result.code).toBe(0);
    expect(calls.some((call) => call.fn === "commitAll")).toBe(true);
    expect(calls.some((call) => call.fn === "pushBranch")).toBe(true);
  });

  it("hashes exactly the situation the panel was shown", async () => {
    const seen: ApprovalRequest[] = [];
    const { deps } = makeDeps({
      loadConfig: () => HUMAN,
      loadReadiness: () => [ALWAYS],
      requestApproval: async (request: ApprovalRequest) => {
        seen.push(request);
        return { outcome: "denied" as const };
      },
    });

    await runSubmit({ ...failing, acknowledge: [] }, deps);

    const request = seen[0] as ApprovalRequest;
    expect(
      fingerprint({
        repo: request.repo,
        branch: request.branch,
        base: request.base,
        head: request.head,
        title: request.title,
        commitMessage: request.commitMessage,
        diffstat: request.diffstat,
        warnings: request.warnings,
      }),
    ).toBe(request.fingerprint);
  });
});
