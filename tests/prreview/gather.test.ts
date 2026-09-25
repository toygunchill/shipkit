import { describe, expect, it } from "vitest";
import { gather } from "../../src/prreview/gather.js";

const VIEW = JSON.stringify({
  number: 12,
  title: "fix(invoice): default the citizenship",
  body: "## Summary\n\nx",
  author: { login: "someone" },
  baseRefName: "develop",
  headRefOid: "b".repeat(40),
});

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,2 @@
 one
+two
`;

function gh(calls: string[][] = []) {
  return {
    calls,
    run: (args: string[]) => {
      calls.push(args);
      if (args[1] === "view") return VIEW;
      if (args[1] === "diff") return DIFF;
      return "";
    },
  };
}

describe("gathering what a review needs", () => {
  it("reads the pull request and its diff, and derives the anchors in one pass", () => {
    const { run } = gh();

    const got = gather("acme", "widget", 12, run);

    expect(got.pull.title).toContain("citizenship");
    expect(got.pull.author).toBe("someone");
    expect(got.pull.baseRef).toBe("develop");
    expect(got.anchors.get("src/a.ts")?.has("2:RIGHT")).toBe(true);
  });

  // The anchors are computed against this commit and the payload is pinned to it. Reading
  // it anywhere else, or later, would mean publishing comments against a diff nobody read.
  it("carries the head commit the anchors were computed against", () => {
    expect(gather("acme", "widget", 12, gh().run).pull.headSha).toBe("b".repeat(40));
  });

  it("asks the pull request's own host, not whichever gh saw last", () => {
    const calls: string[][] = [];

    gather("acme", "widget", 12, gh(calls).run, "git.example.com");

    expect(calls[0]?.join(" ")).toContain("git.example.com/acme/widget");
    expect(calls[1]?.join(" ")).toContain("git.example.com/acme/widget");
  });

  it("names no host when there is only one", () => {
    const calls: string[][] = [];

    gather("acme", "widget", 12, gh(calls).run);

    expect(calls[0]?.join(" ")).toContain("--repo acme/widget");
  });

  // gh pr view has no "is this mine" field, so ownership is the author compared against
  // whoever gh is authenticated as.
  it("knows whether the pull request is the caller's own", () => {
    expect(gather("a", "b", 1, gh().run, undefined, "someone").pull.mine).toBe(true);
    expect(gather("a", "b", 1, gh().run, undefined, "someone-else").pull.mine).toBe(false);
  });

  // Not knowing must produce the more cautious wording rather than claiming the pull
  // request is yours.
  it("does not claim a pull request is yours when it cannot tell", () => {
    expect(gather("a", "b", 1, gh().run).pull.mine).toBe(false);
  });

  // gh printing something that is not JSON means the read failed in a way the caller has to
  // hear about, rather than a review being built on an empty object.
  it("says so when gh returns something that is not a pull request", () => {
    expect(() => gather("a", "b", 1, () => "not json at all")).toThrow(/could not read/i);
  });

  it("reads an empty body as empty rather than null", () => {
    const run = (args: string[]) =>
      args[1] === "view" ? JSON.stringify({ ...JSON.parse(VIEW), body: null }) : DIFF;

    expect(gather("a", "b", 1, run).pull.body).toBe("");
  });
});
