import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearRequested, readRequested, requestedReviewPath } from "../../src/prreview/requested.js";

function withFile(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "shipkit-req-")), "requested-review.json");
  writeFileSync(path, contents, "utf8");
  return path;
}

const good = JSON.stringify({
  version: 1,
  repository: "git.example.com/acme/widget",
  number: 977,
  title: "fix: something",
  url: "https://git.example.com/acme/widget/pull/977",
  requestedAt: "2026-09-24T15:43:40Z",
});

describe("picking up a review asked for from the menu bar", () => {
  it("reads what the application wrote", () => {
    const requested = readRequested(withFile(good));

    expect(requested).toMatchObject({ repository: "git.example.com/acme/widget", number: 977 });
  });

  it("reads nothing waiting as nothing, rather than throwing", () => {
    expect(readRequested(join(tmpdir(), "definitely-not-there.json"))).toBeUndefined();
  });

  // A half-written or hand-edited file is not a request. Acting on a repository
  // name that parsed by luck ends in comments on the wrong pull request.
  it("refuses a file that is not a request", () => {
    expect(readRequested(withFile("not json"))).toBeUndefined();
    expect(readRequested(withFile("{}"))).toBeUndefined();
    expect(readRequested(withFile('{"version":2,"repository":"a/b","number":1,"url":"u"}'))).toBeUndefined();
    expect(readRequested(withFile('{"version":1,"repository":"","number":1,"url":"u"}'))).toBeUndefined();
    expect(readRequested(withFile('{"version":1,"repository":"a/b","number":0,"url":"u"}'))).toBeUndefined();
    expect(readRequested(withFile('{"version":1,"repository":"a/b","number":"1","url":"u"}'))).toBeUndefined();
  });

  it("tolerates a missing title rather than rejecting the request over it", () => {
    const path = withFile('{"version":1,"repository":"a/b","number":3,"url":"u"}');

    expect(readRequested(path)).toMatchObject({ number: 3, title: "" });
  });

  // So the same press is not answered twice, and a request from yesterday is not
  // acted on today by an agent that happened to ask.
  it("forgets the request once it has been taken", () => {
    const path = withFile(good);

    clearRequested(path);

    expect(existsSync(path)).toBe(false);
    expect(readRequested(path)).toBeUndefined();
  });

  it("clearing nothing is not an error", () => {
    expect(() => clearRequested(join(tmpdir(), "nope.json"))).not.toThrow();
  });

  // Both halves must name the same file or the button writes where nothing reads.
  it("looks where the application writes", () => {
    expect(requestedReviewPath("/Users/someone")).toBe(
      "/Users/someone/Library/Application Support/shipkit/requested-review.json",
    );
  });
});
