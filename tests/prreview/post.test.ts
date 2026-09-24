import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { reviewPayload, postReview, type PostTarget } from "../../src/prreview/post.js";
import type { AcceptedRemark } from "../../src/prreview/validate.js";

type ReviewPayloadSeen = { commit_id: string; event: string; body: string; comments: unknown[] };

const target: PostTarget = {
  owner: "acme",
  repo: "widget",
  number: 12,
  headSha: "a".repeat(40),
  host: undefined,
};

const line = (over: Partial<Extract<AcceptedRemark, { placement: "line" }>> = {}) =>
  ({
    placement: "line",
    ruleId: "ADR-012",
    path: "src/a.ts",
    line: 2,
    side: "RIGHT",
    body: "no",
    ...over,
  }) as AcceptedRemark;

describe("building the review payload", () => {
  it("sends one review, not one comment each", () => {
    const payload = reviewPayload([line(), line({ line: 3 })], target);

    expect(payload.comments).toHaveLength(2);
    expect(payload.event).toBe("COMMENT");
  });

  // The anchors were computed against this commit. Sending it is what lets GitHub outdate
  // the comments if the author pushes, rather than shipkit re-anchoring to lines it never
  // read.
  it("pins the commit the anchors were computed against", () => {
    expect(reviewPayload([line()], target).commit_id).toBe(target.headSha);
  });

  it("names the rule in the comment, so a reader can check the claim", () => {
    const payload = reviewPayload([line({ ruleId: "ADR-004", body: "the store is never owned" })], target);

    expect(payload.comments[0]?.body).toContain("ADR-004");
    expect(payload.comments[0]?.body).toContain("the store is never owned");
  });

  it("carries path, line and side through untouched", () => {
    const payload = reviewPayload([line({ path: "x/y.swift", line: 41, side: "LEFT" })], target);

    expect(payload.comments[0]).toMatchObject({ path: "x/y.swift", line: 41, side: "LEFT" });
  });

  // A remark about the whole change is not a line comment. Putting it in the review body is
  // the only place GitHub has for it.
  it("puts pull-level remarks in the review body, not among the comments", () => {
    const payload = reviewPayload(
      [line(), { placement: "pull", ruleId: "ADR-004", body: "the change assumes an unowned store" }],
      target,
    );

    expect(payload.comments).toHaveLength(1);
    expect(payload.body).toContain("the change assumes an unowned store");
    expect(payload.body).toContain("ADR-004");
  });

  it("leaves the body empty when every remark landed on a line", () => {
    expect(reviewPayload([line()], target).body ?? "").toBe("");
  });
});

describe("posting it", () => {
  // The fake reads the file the real `gh` would read. An earlier version of this test only
  // looked at the argument strings, and so happily passed while the code passed `gh` a
  // flag it does not have — the payload never reached anything.
  function runner() {
    const calls: string[][] = [];
    const sent: ReviewPayloadSeen[] = [];
    return {
      calls,
      sent,
      run: (args: string[]) => {
        calls.push(args);
        const at = args.indexOf("--input");
        if (at >= 0) {
          const path = args[at + 1] as string;
          sent.push(JSON.parse(readFileSync(path, "utf8")) as ReviewPayloadSeen);
        }
        return "{}";
      },
    };
  }

  it("actually hands gh the payload, as a file it can read", () => {
    const { sent, run } = runner();

    postReview([line()], target, run);

    expect(sent, "gh was given no readable payload").toHaveLength(1);
    expect(sent[0]?.comments).toHaveLength(1);
    expect(sent[0]?.commit_id).toBe(target.headSha);
  });

  it("uses only flags gh api actually has", () => {
    const r = runner();

    postReview([line()], target, r.run);

    expect(r.calls[0]).not.toContain("--payload");
    expect(r.calls[0]?.includes("--input")).toBe(true);
  });

  it("leaves no payload file behind once it is done", () => {
    let path = "";
    postReview([line()], target, (args) => {
      path = args[args.indexOf("--input") + 1] as string;
      return "{}";
    });

    expect(existsSync(path)).toBe(false);
  });

  // The file carries the review before it is published; leaving it on disk after a failure
  // would be a stray copy of something that was never meant to persist.
  it("removes the file even when gh fails", () => {
    let path = "";
    expect(() =>
      postReview([line()], target, (args) => {
        path = args[args.indexOf("--input") + 1] as string;
        throw new Error("gh exploded");
      }),
    ).toThrow(/exploded/);

    expect(existsSync(path)).toBe(false);
  });

  it("refuses to post a review with nothing in it", () => {
    const { calls, run } = runner();

    expect(() => postReview([], target, run)).toThrow(/nothing/i);
    expect(calls).toHaveLength(0);
  });

  it("posts to the pull request's own host, not gh's default", () => {
    const { calls, run } = runner();

    postReview([line()], { ...target, host: "git.example.com" }, run);

    expect(calls[0]).toContain("--hostname");
    expect(calls[0]).toContain("git.example.com");
  });

  it("names no host when there is nothing to disambiguate", () => {
    const { calls, run } = runner();

    postReview([line()], target, run);

    expect(calls[0]?.includes("--hostname")).toBe(false);
  });

  it("posts to the reviews endpoint of the right pull request", () => {
    const { calls, run } = runner();

    postReview([line()], target, run);

    expect(calls[0]?.join(" ")).toContain("repos/acme/widget/pulls/12/reviews");
  });

  // --dry-run exists so a person can see exactly what would be published. If it ran gh at
  // all it would be worthless as a safety net.
  it("runs nothing at all on a dry run, and hands back the payload", () => {
    const { calls, run } = runner();

    const payload = postReview([line()], target, run, { dryRun: true });

    expect(calls).toHaveLength(0);
    expect(payload.comments).toHaveLength(1);
  });
});
