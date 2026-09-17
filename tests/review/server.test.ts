import { describe, expect, it } from "vitest";
import { createHandler, isLoopback, type ReviewHttpRequest } from "../../src/review/server.js";
import type { FixRequestItem } from "../../src/review/fixrequest.js";

const TOKEN = "a".repeat(64);

function make(
  over: { openEditor?: (path: string, line: number) => void; openable?: string[] } = {},
): {
  handle: (request: Partial<ReviewHttpRequest>) => ReturnType<ReturnType<typeof createHandler>>;
  submitted: FixRequestItem[][];
  opened: { path: string; line: number }[];
} {
  const submitted: FixRequestItem[][] = [];
  const opened: { path: string; line: number }[] = [];
  const handler = createHandler({
    token: TOKEN,
    page: "<!doctype html><title>page</title>",
    submit: (items) => submitted.push(items),
    openEditor:
      over.openEditor ?? ((path, line) => {
        opened.push({ path, line });
      }),
    openable: new Set(over.openable ?? ["app.ts"]),
  });
  return {
    handle: (request) =>
      handler({
        method: "GET",
        url: `/?token=${TOKEN}`,
        remoteAddress: "127.0.0.1",
        body: "",
        ...request,
      }),
    submitted,
    opened,
  };
}

const selection = (items: unknown[]): string => JSON.stringify({ items });

describe("the loopback rule", () => {
  it("serves this machine talking to itself, in all three spellings", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
  });

  it("refuses anything else, including a socket that could not name its peer", () => {
    expect(isLoopback("192.168.1.10")).toBe(false);
    expect(isLoopback("10.0.0.1")).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });

  it("refuses a non-loopback peer before it can even try a token", () => {
    const { handle } = make();

    const response = handle({ remoteAddress: "192.168.1.10" });

    expect(response.status).toBe(403);
    expect(response.body).toContain("this machine only");
  });
});

describe("the token", () => {
  it("serves the page when it is right", () => {
    const { handle } = make();

    const response = handle({});

    expect(response.status).toBe(200);
    expect(response.contentType).toContain("text/html");
    expect(response.body).toContain("<title>page</title>");
  });

  // The discriminating half of the loopback test above: same peer, same route, one
  // character different in the token.
  it("refuses a wrong token, on the page and on the submit alike", () => {
    const { handle, submitted } = make();
    const wrong = `${"a".repeat(63)}b`;

    expect(handle({ url: `/?token=${wrong}` }).status).toBe(403);
    expect(
      handle({ method: "POST", url: `/submit?token=${wrong}`, body: selection([]) }).status,
    ).toBe(403);
    expect(submitted).toEqual([]);
  });

  it("refuses a missing token", () => {
    expect(make().handle({ url: "/" }).status).toBe(403);
  });

  // A token of a different length must not reach timingSafeEqual, which throws on one.
  it("refuses a token of the wrong length without crashing", () => {
    expect(make().handle({ url: "/?token=short" }).status).toBe(403);
  });

  it("refuses before revealing which paths exist", () => {
    const response = make().handle({ url: "/submit?token=nope" });
    expect(response.status).toBe(403);
    expect(response.body).not.toContain("Nothing here");
  });
});

describe("one review, one answer", () => {
  it("takes the selection and hands it on", () => {
    const { handle, submitted } = make();

    const response = handle({
      method: "POST",
      url: `/submit?token=${TOKEN}`,
      body: selection([{ kind: "warning", id: "untracked-files", message: "m", note: " fix it " }]),
    });

    expect(response.status).toBe(200);
    expect(submitted).toEqual([
      [{ kind: "warning", id: "untracked-files", message: "m", note: "fix it" }],
    ]);
  });

  it("treats a missing note as an empty one, because ticking and saying nothing is an answer", () => {
    const { handle, submitted } = make();

    handle({
      method: "POST",
      url: `/submit?token=${TOKEN}`,
      body: selection([{ kind: "advice", id: "uikit-to-swiftui", message: "m" }]),
    });

    expect(submitted[0]?.[0]?.note).toBe("");
  });

  it("refuses a second POST rather than overwriting the first", () => {
    const { handle, submitted } = make();
    const post = (): ReturnType<typeof handle> =>
      handle({ method: "POST", url: `/submit?token=${TOKEN}`, body: selection([]) });

    expect(post().status).toBe(200);
    expect(post().status).toBe(409);
    expect(submitted).toHaveLength(1);
  });

  it("refuses a body that is not a selection", () => {
    const { handle, submitted } = make();

    expect(handle({ method: "POST", url: `/submit?token=${TOKEN}`, body: "{" }).status).toBe(400);
    expect(
      handle({ method: "POST", url: `/submit?token=${TOKEN}`, body: '{"items":"all"}' }).status,
    ).toBe(400);
    expect(
      handle({
        method: "POST",
        url: `/submit?token=${TOKEN}`,
        body: selection([{ kind: "opinion", id: "a", message: "m", note: "" }]),
      }).status,
    ).toBe(400);
    expect(submitted).toEqual([]);
  });

  // A refused body must not spend the one answer: the page can retry.
  it("leaves the review open after a refused body", () => {
    const { handle } = make();

    handle({ method: "POST", url: `/submit?token=${TOKEN}`, body: "{" });

    expect(
      handle({ method: "POST", url: `/submit?token=${TOKEN}`, body: selection([]) }).status,
    ).toBe(200);
  });
});

describe("opening a file in the editor", () => {
  it("opens one the page offered, at the line it named", () => {
    const { handle, opened } = make({ openable: ["Sources/Screen.swift"] });

    const response = handle({
      method: "POST",
      url: `/open?token=${TOKEN}`,
      body: JSON.stringify({ path: "Sources/Screen.swift", line: 12 }),
    });

    expect(response.status).toBe(200);
    expect(opened).toEqual([{ path: "Sources/Screen.swift", line: 12 }]);
  });

  // The token is the only guard on this origin, and a process that had it could otherwise
  // make shipkit run an editor against any path on the machine.
  it("refuses a path that is not in this change", () => {
    const { handle, opened } = make({ openable: ["app.ts"] });

    const response = handle({
      method: "POST",
      url: `/open?token=${TOKEN}`,
      body: JSON.stringify({ path: "../../../../etc/passwd", line: 1 }),
    });

    expect(response.status).toBe(404);
    expect(opened).toEqual([]);
  });

  it("falls back to line 1 when the line is not a line", () => {
    const { handle, opened } = make();

    handle({
      method: "POST",
      url: `/open?token=${TOKEN}`,
      body: JSON.stringify({ path: "app.ts", line: -4 }),
    });

    expect(opened).toEqual([{ path: "app.ts", line: 1 }]);
  });

  it("reports a failure to start the editor rather than dying", () => {
    const { handle } = make({
      openEditor: () => {
        throw new Error("xed: command not found");
      },
    });

    const response = handle({
      method: "POST",
      url: `/open?token=${TOKEN}`,
      body: JSON.stringify({ path: "app.ts", line: 1 }),
    });

    expect(response.status).toBe(502);
  });

  it("does not end the review", () => {
    const { handle } = make();

    handle({ method: "POST", url: `/open?token=${TOKEN}`, body: JSON.stringify({ path: "app.ts" }) });

    expect(
      handle({ method: "POST", url: `/submit?token=${TOKEN}`, body: selection([]) }).status,
    ).toBe(200);
  });
});

describe("everything else", () => {
  it("is a 404, even with the right token", () => {
    expect(make().handle({ url: `/secrets?token=${TOKEN}` }).status).toBe(404);
    expect(make().handle({ method: "DELETE", url: `/?token=${TOKEN}` }).status).toBe(404);
  });
});
