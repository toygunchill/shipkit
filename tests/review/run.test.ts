import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import type { ShipkitConfig } from "../../src/config/schema.js";
import type { IssueFacts } from "../../src/jira/types.js";
import type { ReadinessRule } from "../../src/readiness/types.js";
import {
  FIX_REQUEST_PATH,
  type ArchiveOutcome,
  type FixRequest,
  type FixRequestItem,
} from "../../src/review/fixrequest.js";
import type { ReviewOfferOutcome } from "../../src/approval/client.js";
import { runReview, type ReviewDeps, type ReviewOptions } from "../../src/review/run.js";
import type { Listening, ReviewHandler } from "../../src/review/server.js";
import { renderBody, type SubmitResponse } from "../../src/submit/response.js";
import { VcsError } from "../../src/vcs/git.js";

const CONFIG = loadConfig("tests/fixtures/valid.shipkit.yml");
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

const OPTIONS: ReviewOptions = {
  base: "develop",
  config: "tests/fixtures/valid.shipkit.yml",
  responsePath: "/repo/scratch/response.json",
  port: 0,
  open: false,
};

type Harness = {
  deps: ReviewDeps;
  calls: string[];
  out: string[];
  err: string[];
  written: FixRequest[];
  /** Drives the page's POST, the way a browser would, without a socket anywhere. */
  answer: (items: FixRequestItem[]) => void;
  /** Ends the wait with nobody having answered. */
  abandon: () => void;
  handler: () => ReviewHandler;
  pageHtml: () => string;
};

/**
 * Every dependency is a fake, and the list deliberately contains no way to commit, push or
 * open a pull request — `runReview` could not do any of those if it tried.
 *
 * `listen` never binds anything. It captures the handler so a test can call it directly,
 * which is the whole reason the handler is a pure function.
 */
function makeDeps(overrides: Partial<ReviewDeps> = {}): Harness {
  const calls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const written: FixRequest[] = [];
  let captured: ReviewHandler | undefined;
  let releaseWait: () => void = () => undefined;

  const record = <A extends unknown[], R>(name: string, impl: (...args: A) => R) =>
    (...args: A): R => {
      calls.push(name);
      return impl(...args);
    };

  const defaults: ReviewDeps = {
    loadConfig: () => CONFIG,
    loadResponse: () => RESPONSE,
    renderBody: (sections, config) => renderBody(sections, config),
    currentBranch: () => BRANCH,
    resolveIssue: (key: string) =>
      Promise.resolve({ key, type: "Story", summary: "" } as IssueFacts),
    readRepoState: () => ({ branch: BRANCH, changedFiles: [], diffstat: "", commits: [] }),
    readPushDiffstat: () => " app.ts | 2 +-\n 1 file changed",
    readPushAddedLines: () => [],
    readPushChangedFiles: () => [],
    readPushDiff: () => [{ path: "app.ts", status: "modified" as const, patch: "@@ -1 +1 @@\n-a\n+b", line: 1 }],
    readUntrackedFiles: () => [],
    readRepoRoot: () => "/repo",
    realpath: (path: string) => path,
    findPullRequest: () => null,
    fixRequestExclusions: () => [],
    writeFixRequest: (request) => {
      written.push(request);
      return "/repo/.shipkit/fix-request.json";
    },
    listen: (handler, port) => {
      calls.push(`listen:${port}`);
      captured = handler;
      return Promise.resolve({
        origin: "http://127.0.0.1:53211",
        close: () => {
          calls.push("close");
          return Promise.resolve();
        },
      } satisfies Listening);
    },
    now: () => new Date("2026-09-17T10:00:00.000Z"),
    wait: () =>
      new Promise<void>((resolve) => {
        releaseWait = resolve;
      }),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };

  /** The token is only ever in the printed URL — which is exactly where a browser finds it. */
  const printedToken = (): string => {
    const url = out.find((line) => line.startsWith("http://")) ?? "";
    return new URL(url).searchParams.get("token") ?? "";
  };

  const deps: ReviewDeps = { ...defaults, ...overrides };
  // Wrap after merging so an override lands in the call log at the right position.
  const wrapped: ReviewDeps = {
    ...deps,
    readPushDiff: record("readPushDiff", deps.readPushDiff),
    readPushDiffstat: record("readPushDiffstat", deps.readPushDiffstat),
    findPullRequest: record("findPullRequest", deps.findPullRequest),
    writeFixRequest: record("writeFixRequest", deps.writeFixRequest),
  };

  return {
    deps: wrapped,
    calls,
    out,
    err,
    written,
    handler: () => captured as ReviewHandler,
    pageHtml: () =>
      (captured as ReviewHandler)({
        method: "GET",
        url: `/?token=${printedToken()}`,
        remoteAddress: "127.0.0.1",
        body: "",
      }).body,
    answer: (items) => {
      (captured as ReviewHandler)({
        method: "POST",
        url: `/submit?token=${printedToken()}`,
        remoteAddress: "127.0.0.1",
        body: JSON.stringify({ items }),
      });
    },
    abandon: () => releaseWait(),
  };
}

/**
 * Drives one review: starts it, lets the page load, then acts. `runReview` awaits the
 * listen call, so the act has to happen on a later turn of the loop than the call itself.
 */
async function review(
  harness: Harness,
  act: (harness: Harness) => void,
  options: ReviewOptions = OPTIONS,
): Promise<Awaited<ReturnType<typeof runReview>>> {
  const running = runReview(options, harness.deps);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  act(harness);
  return running;
}

const ITEM: FixRequestItem = {
  kind: "warning",
  id: "untracked-files",
  message: "Staging will sweep in .env.local",
  note: "delete it",
};

describe("runReview writes what a person chose", () => {
  it("writes the selection and says where it went", async () => {
    const harness = makeDeps();

    const result = await review(harness, (h) => h.answer([ITEM]));

    expect(result.code).toBe(0);
    expect(harness.written).toEqual([
      {
        version: 1,
        createdAt: "2026-09-17T10:00:00.000Z",
        base: "develop",
        branch: BRANCH,
        items: [ITEM],
      },
    ]);
    expect(result.path).toBe("/repo/.shipkit/fix-request.json");
    expect(harness.out).toContain("/repo/.shipkit/fix-request.json");
  });

  // A `fixRequest` naming nothing would reach the agent as an instruction to do nothing,
  // and would sit in the repository until the next successful submit archived it.
  it("writes nothing when nothing was ticked, and says so", async () => {
    const harness = makeDeps();

    const result = await review(harness, (h) => h.answer([]));

    expect(result.code).toBe(0);
    expect(harness.written).toEqual([]);
    expect(harness.err.join("\n")).toContain("Nothing was selected");
  });

  it("closes the socket whether it was answered or abandoned", async () => {
    const answered = makeDeps();
    await review(answered, (h) => h.answer([ITEM]));
    expect(answered.calls).toContain("close");

    const abandoned = makeDeps();
    await review(abandoned, (h) => h.abandon());
    expect(abandoned.calls).toContain("close");
  });

  it("returns 2 and writes nothing when the wait runs out", async () => {
    const harness = makeDeps();

    const result = await review(harness, (h) => h.abandon());

    expect(result.code).toBe(2);
    expect(harness.written).toEqual([]);
    expect(result.message).toContain("wait ran out");
  });

  it("prints the URL and the length of the wait before anyone can answer", async () => {
    const harness = makeDeps();

    await review(harness, (h) => h.answer([ITEM]));

    expect(harness.out[0]).toMatch(/^http:\/\/127\.0\.0\.1:53211\/\?token=[0-9a-f]{64}$/);
    expect(harness.err.join("\n")).toContain("Waiting up to 10 minutes");
    expect(harness.err.join("\n")).toContain("Nothing is committed, pushed, or sent anywhere");
  });

  it("asks the kernel for a free port unless one was named", async () => {
    const free = makeDeps();
    await review(free, (h) => h.answer([]));
    expect(free.calls).toContain("listen:0");

    const fixed = makeDeps();
    await review(fixed, (h) => h.answer([]), { ...OPTIONS, port: 4123 });
    expect(fixed.calls).toContain("listen:4123");
  });
});

describe("runReview opens a browser only when asked", () => {
  it("opens it by default", async () => {
    const opened: string[] = [];
    const harness = makeDeps({ openBrowser: (url) => opened.push(url) });

    await review(harness, (h) => h.answer([]), { ...OPTIONS, open: true });

    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain("token=");
  });

  it("leaves it alone under --no-open", async () => {
    const opened: string[] = [];
    const harness = makeDeps({ openBrowser: (url) => opened.push(url) });

    await review(harness, (h) => h.answer([]), { ...OPTIONS, open: false });

    expect(opened).toEqual([]);
  });
});

describe("runReview shows everything, rather than stopping at the first channel", () => {
  // `runSubmit` returns on a failing validate, before the repository is touched. Doing that
  // here would show a person the title problem and hide the warnings underneath it, which is
  // the opposite of what this command is for.
  it("shows pre-flight warnings even when validation already refused", async () => {
    const harness = makeDeps({
      loadResponse: () => ({ ...RESPONSE, title: "no ticket here" }),
      readUntrackedFiles: () => [".env.local"],
    });

    const result = await review(harness, (h) => h.answer([]));

    expect(result.findings.map((f) => f.rule)).toContain("title-pattern");
    expect(result.warnings.map((w) => w.check)).toContain("untracked-files");
    const html = harness.pageHtml();
    expect(html).toContain("title-pattern");
    expect(html).toContain("untracked-files");
  });

  it("carries readiness answers into the evaluation, and reports what the rules cost", async () => {
    const rules: ReadinessRule[] = [
      { id: "design-tokens", ask: "Right token?", severity: "warn" },
      { id: "entry-paths", ask: "Every path?", severity: "block" },
    ];
    const harness = makeDeps({
      loadReadiness: () => rules,
      loadResponse: () => ({
        ...RESPONSE,
        readiness: [
          { id: "design-tokens", status: "fail", note: "used a raw hex" },
          { id: "entry-paths", status: "fail", note: "one path is unguarded" },
        ],
      }),
    });

    const result = await review(harness, (h) => h.answer([]));

    expect(result.items.map((item) => item.id)).toEqual(
      expect.arrayContaining(["readiness-entry-paths", "readiness-design-tokens"]),
    );
    // Whichever channel a readiness failure came out of, it is a readiness failure.
    expect(
      result.items.filter((item) => item.id.startsWith("readiness-")).map((item) => item.kind),
    ).toEqual(["readiness", "readiness"]);
  });

  // Without a response there are no answers, and `evaluate` reports that rather than
  // treating silence as compliance. That is exactly what a person should see.
  it("reports the readiness rules as unanswered when review was run without an input", async () => {
    const harness = makeDeps({
      loadReadiness: () => [{ id: "design-tokens", ask: "Right token?", severity: "warn" }],
    });

    const result = await review(harness, (h) => h.answer([]), {
      ...OPTIONS,
      responsePath: undefined,
    });

    expect(result.findings.map((f) => f.rule)).toContain("readiness-unanswered");
    expect(harness.pageHtml()).toContain("Readiness answers are absent");
  });

  it("needs no response at all, and never asks for one", async () => {
    const harness = makeDeps({
      loadResponse: () => {
        throw new Error("no response should be read");
      },
    });

    const result = await review(harness, (h) => h.answer([ITEM]), {
      ...OPTIONS,
      responsePath: undefined,
    });

    expect(result.code).toBe(0);
    expect(harness.pageHtml()).toContain("No commit message");
  });

  it("orders findings above warnings above advice", async () => {
    const harness = makeDeps({
      loadResponse: () => ({ ...RESPONSE, title: "no ticket here" }),
      readUntrackedFiles: () => [".env.local"],
      readPushChangedFiles: () => [
        { path: "Screen.xib", status: "deleted", before: "<UIViewController/>", after: "" },
        {
          path: "Screen.swift",
          status: "added",
          before: "",
          after: "import SwiftUI\nstruct Screen: View { var body: some View { Text(\"x\") } }\n",
        },
      ],
    });

    const result = await review(harness, (h) => h.answer([]));

    const severities = result.items.map((item) => item.severity);
    expect(severities.indexOf("refuses")).toBeLessThan(severities.indexOf("warns"));
    expect(severities.lastIndexOf("warns")).toBeLessThan(severities.indexOf("informs"));
  });
});

describe("runReview and the paths that are not part of the change", () => {
  it("excludes the response file and every selection file from every read", async () => {
    const seen: string[][] = [];
    const capture = (_base: string, exclude: string[]): never[] => {
      seen.push(exclude);
      return [];
    };
    const harness = makeDeps({
      fixRequestExclusions: () => [".shipkit/fix-request.json"],
      readPushAddedLines: capture,
      readPushChangedFiles: capture,
      readPushChangedPaths: capture,
      readPushDiff: capture,
      readPushDiffstat: (_base, exclude) => {
        seen.push(exclude);
        return "";
      },
      loadReadiness: () => [{ id: "a", ask: "?", severity: "warn" }],
    });

    await review(harness, (h) => h.answer([]));

    expect(seen.length).toBeGreaterThanOrEqual(5);
    for (const exclude of seen) {
      expect(exclude).toEqual(["scratch/response.json", ".shipkit/fix-request.json"]);
    }
  });

  it("does not warn about a selection file staging will not carry", async () => {
    const harness = makeDeps({
      fixRequestExclusions: () => [".shipkit/fix-request.json"],
      readUntrackedFiles: () => [".shipkit/fix-request.json"],
    });

    const result = await review(harness, (h) => h.answer([]));

    expect(result.warnings.map((w) => w.check)).not.toContain("untracked-files");
  });
});

describe("runReview refuses the same inputs runSubmit refuses", () => {
  it("refuses a base that is spelled as an option", async () => {
    const harness = makeDeps();

    const result = await runReview({ ...OPTIONS, base: "--output=/tmp/x" }, harness.deps);

    expect(result.code).toBe(2);
    expect(result.message).toContain("Refusing to use");
    expect(harness.calls).toEqual([]);
  });

  it("reports a VcsError as exit 2 rather than a stack trace", async () => {
    const harness = makeDeps({
      readRepoState: () => {
        throw new VcsError("git merge-base failed: unknown revision");
      },
    });

    const result = await runReview(OPTIONS, harness.deps);

    expect(result.code).toBe(2);
    expect(result.message).toContain("unknown revision");
  });

  it("never binds a socket when the run failed before the page existed", async () => {
    const harness = makeDeps({
      loadConfig: () => {
        throw new VcsError("nope");
      },
    });

    await runReview(OPTIONS, harness.deps);

    expect(harness.calls.some((call) => call.startsWith("listen"))).toBe(false);
  });
});

describe("runReview has no way to change the repository", () => {
  // Stated as a type-level fact rather than a behavioural one: there is no commit, push or
  // pull-request member on the dependency list to call.
  it("takes no mutating dependency", () => {
    const deps = makeDeps().deps as unknown as Record<string, unknown>;

    for (const forbidden of ["commitAll", "pushBranch", "createPullRequest", "requestApproval"]) {
      expect(deps[forbidden]).toBeUndefined();
    }
  });

  it("is not given a config whose approval policy could matter", async () => {
    const harness = makeDeps({
      loadConfig: () => ({ ...CONFIG, pr: { ...CONFIG.pr, approval: "human" } }) as ShipkitConfig,
    });

    const result = await review(harness, (h) => h.answer([ITEM]));

    // No approval is requested, no gate is consulted: the selection is simply written.
    expect(result.code).toBe(0);
    expect(harness.written).toHaveLength(1);
  });
});

describe("an empty selection, when an earlier one is still lying there", () => {
  // Ticking nothing and pressing send is how a person says "I have read this and it is fine
  // now". The earlier selection used to stay armed, and the message — "No fix request was
  // written" — was true and read as "nothing is pending": the next brief re-issued
  // instructions the person had just decided were done, under a header saying a person chose
  // them.
  it("clears the earlier one and says where it went", async () => {
    let cleared = 0;
    const harness = makeDeps({
      fixRequestExclusions: () => [FIX_REQUEST_PATH],
      clearFixRequest: (): ArchiveOutcome => {
        cleared += 1;
        return { kind: "moved", path: "/archive/fix-request-2026-09-17T10-00-00-000Z.json" };
      },
    });

    const result = await review(harness, (h) => h.answer([]));

    expect(result.code).toBe(0);
    expect(cleared).toBe(1);
    expect(harness.written).toEqual([]);
    expect(harness.err.join("\n")).toContain("/archive/fix-request-2026-09-17T10-00-00-000Z.json");
  });

  it("names the file to delete by hand when it could not be cleared", async () => {
    const harness = makeDeps({
      fixRequestExclusions: () => [FIX_REQUEST_PATH],
      clearFixRequest: (): ArchiveOutcome => ({ kind: "failed", detail: "EACCES" }),
    });

    await review(harness, (h) => h.answer([]));

    expect(harness.err.join("\n")).toContain("EACCES");
    expect(harness.err.join("\n")).toContain(FIX_REQUEST_PATH);
  });

  it("still says the plain thing when there was nothing to clear", async () => {
    const harness = makeDeps();

    await review(harness, (h) => h.answer([]));

    expect(harness.err.join("\n")).toContain("No fix request was written");
  });
});

describe("a wait that runs out with a selection still pending", () => {
  // Nobody said anything, so the selection stays exactly as it was — but silence plus
  // "nothing was written" reads as "nothing is pending", and the next brief would carry
  // instructions this run gave no hint about.
  it("names the selection the next brief will carry", async () => {
    const harness = makeDeps({ fixRequestExclusions: () => [FIX_REQUEST_PATH] });

    const result = await review(harness, (h) => h.abandon());

    expect(result.code).toBe(2);
    expect(result.message).toContain(FIX_REQUEST_PATH);
  });

  it("says nothing extra when there is nothing pending", async () => {
    const harness = makeDeps();

    const result = await review(harness, (h) => h.abandon());

    expect(result.message).not.toContain(FIX_REQUEST_PATH);
  });
});

describe("a selection that cannot be written", () => {
  // The write happens inside the POST now, so the page learns about the failure instead of
  // being told "Sent to shipkit. You can close this tab." while the write was still to come.
  // The review stays open, which is what makes pressing send again worth anything.
  it("keeps the review open, and takes the same selection once the disk lets it", async () => {
    let failing = true;
    const harness = makeDeps({
      writeFixRequest: (request) => {
        if (failing) throw new Error("EROFS: read-only file system");
        return `/repo/${FIX_REQUEST_PATH}`;
      },
    });

    const result = await review(harness, (h) => {
      h.answer([ITEM]);
      failing = false;
      h.answer([ITEM]);
    });

    expect(result.code).toBe(0);
    expect(result.selected).toEqual([ITEM]);
    expect(result.path).toBe(`/repo/${FIX_REQUEST_PATH}`);
  });
});

describe("a review answered from the menu bar", () => {
  /** A stand-in for the application: answers when the test tells it to. */
  function panel(): {
    offerReview: NonNullable<ReviewDeps["offerReview"]>;
    say: (response: { answer: "selected" | "nothing"; items: FixRequestItem[] }) => void;
    cancelled: () => boolean;
    offered: () => number;
  } {
    let resolveAnswer: (outcome: ReviewOfferOutcome) => void = () => undefined;
    let wasCancelled = false;
    let count = 0;
    let fingerprint = "";
    return {
      offerReview: (offer) => {
        count += 1;
        fingerprint = offer.fingerprint;
        return {
          answer: new Promise((resolve) => {
            resolveAnswer = resolve;
          }),
          cancel: () => {
            wasCancelled = true;
          },
        };
      },
      say: (response) =>
        resolveAnswer({
          outcome: "answered",
          response: { protocol: 1, kind: "review", fingerprint, ...response },
        }),
      cancelled: () => wasCancelled,
      offered: () => count,
    };
  }

  // The selection is written once, by the same `accept` the page reaches. The
  // menu bar is a second way to say the same thing, not a second thing to say.
  it("writes what was ticked there, through the very path the page uses", async () => {
    const surface = panel();
    const harness = makeDeps({ offerReview: surface.offerReview });

    const result = await review(harness, () => surface.say({ answer: "selected", items: [ITEM] }));

    expect(result.code).toBe(0);
    expect(result.selected).toEqual([ITEM]);
    expect(harness.written).toEqual([
      expect.objectContaining({ items: [ITEM], branch: BRANCH, base: OPTIONS.base }),
    ]);
  });

  it("clears a pending selection when nothing was ticked there", async () => {
    let cleared = 0;
    const surface = panel();
    const harness = makeDeps({
      offerReview: surface.offerReview,
      fixRequestExclusions: () => [FIX_REQUEST_PATH],
      clearFixRequest: (): ArchiveOutcome => {
        cleared += 1;
        return { kind: "moved", path: "/archive/x.json" };
      },
    });

    await review(harness, () => surface.say({ answer: "nothing", items: [] }));

    expect(cleared).toBe(1);
    expect(harness.written).toEqual([]);
  });

  // The losing surface has to be closed, or the panel keeps showing a review
  // whose buttons would reach nobody.
  it("closes the offer when the page answered first", async () => {
    const surface = panel();
    const harness = makeDeps({ offerReview: surface.offerReview });

    await review(harness, (h) => h.answer([ITEM]));

    expect(surface.cancelled()).toBe(true);
  });

  it("closes the offer when the wait ran out with nobody answering", async () => {
    const surface = panel();
    const harness = makeDeps({ offerReview: surface.offerReview });

    await review(harness, (h) => h.abandon());

    expect(surface.cancelled()).toBe(true);
  });

  // The offer settling is not an answer. `no-surface` comes back the instant
  // there is no application installed, which is most runs — and a race that
  // treated any settlement as an answer would end every review on the spot.
  it("keeps waiting when there is no application to offer it to", async () => {
    const harness = makeDeps({
      offerReview: () => ({ answer: Promise.resolve({ outcome: "no-surface" as const }), cancel: () => undefined }),
    });

    const result = await review(harness, (h) => h.answer([ITEM]));

    expect(result.code).toBe(0);
    expect(result.selected).toEqual([ITEM]);
  });

  it("reports a surface that could not answer, and lets the page finish the review", async () => {
    const harness = makeDeps({
      offerReview: () => ({
        answer: Promise.resolve({ outcome: "failed" as const, detail: "speaks protocol 2" }),
        cancel: () => undefined,
      }),
    });

    const result = await review(harness, (h) => h.answer([ITEM]));

    expect(harness.err.join("\n")).toContain("speaks protocol 2");
    expect(result.selected).toEqual([ITEM]);
  });

  // The panel's primary action opens this, so it has to be the page this very
  // review is serving — and it is bound into the fingerprint for that reason.
  it("carries the very URL it printed, so the panel opens this review and not another", async () => {
    let offeredUrl: string | undefined;
    const harness = makeDeps({
      offerReview: (offer) => {
        offeredUrl = offer.url;
        return { answer: new Promise(() => undefined), cancel: () => undefined };
      },
    });

    await review(harness, (h) => h.abandon());

    expect(offeredUrl).toBe(harness.out[0]);
    expect(offeredUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{64}$/);
  });

  it("offers each review once, and binds what the panel will show", async () => {
    let seen: { items: unknown[]; files: unknown[]; fingerprint: string } | undefined;
    const harness = makeDeps({
      offerReview: (offer) => {
        seen = { items: offer.items, files: offer.files, fingerprint: offer.fingerprint };
        return { answer: new Promise(() => undefined), cancel: () => undefined };
      },
    });

    await review(harness, (h) => h.abandon());

    expect(seen?.files).toEqual([{ path: "app.ts", status: "modified", line: 1 }]);
    expect(seen?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});
