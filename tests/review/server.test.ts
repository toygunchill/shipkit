import { describe, expect, it } from "vitest";
import { createHandler, isLoopback, listen, type ReviewHttpRequest } from "../../src/review/server.js";
import type { FixRequestItem } from "../../src/review/fixrequest.js";

const TOKEN = "a".repeat(64);

function make(
  over: {
    openEditor?: (path: string, line: number) => void;
    openable?: string[];
    submit?: (items: FixRequestItem[]) => void;
  } = {},
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
    submit: (items) => {
      over.submit?.(items);
      submitted.push(items);
    },
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

describe("a request target the URL parser will not take", () => {
  // Node's HTTP parser hands these through intact; the WHATWG URL parser refuses them. The
  // parse runs before the token check, so no token is needed — and unguarded the throw landed
  // in a callback nothing catches and killed the process. A person eight minutes into a
  // review with fourteen boxes ticked lost all of it to anything else on the machine
  // touching the port, including a browser tab on another origin.
  it.each(["//%", "//[", "//]", "//a%2", "//%C0", "//:@/", "/\\"])("answers %s with a 400", (target) => {
    const { handle } = make();

    const response = handle({ url: target });

    expect(response.status).toBe(400);
  });

  it("does not take a malformed target as an answer to the review", () => {
    const { handle, submitted } = make();

    handle({ method: "POST", url: "//%", body: selection([]) });

    expect(submitted).toEqual([]);
  });
});

describe("a selection that cannot be saved", () => {
  // The 200 used to be written before anything was on disk, so the page said "Sent to
  // shipkit. You can close this tab." while the write was still to come — and when it failed,
  // it failed after the person had closed the tab.
  it("says so instead of claiming the selection was sent", () => {
    const { handle } = make({
      submit: () => {
        throw new Error("Cannot write the review selection to /repo/.shipkit/fix-request.json: EACCES");
      },
    });

    const response = handle({
      method: "POST",
      url: `/submit?token=${TOKEN}`,
      body: selection([{ kind: "warning", id: "untracked-files", message: "m", note: "" }]),
    });

    expect(response.status).toBe(500);
    expect(response.body).toContain("EACCES");
  });

  it("leaves the review answerable, so pressing send again can work", () => {
    let failing = true;
    const { handle, submitted } = make({
      submit: () => {
        if (failing) throw new Error("disk full");
      },
    });
    const body = selection([{ kind: "warning", id: "untracked-files", message: "m", note: "" }]);

    expect(handle({ method: "POST", url: `/submit?token=${TOKEN}`, body }).status).toBe(500);
    failing = false;
    const second = handle({ method: "POST", url: `/submit?token=${TOKEN}`, body });

    expect(second.status).toBe(200);
    expect(submitted).toHaveLength(1);
  });
});

// The one test here that binds a real port. It has to: the bug this guards was not in the
// handler at all, it was that an exception from the handler had no `catch` anywhere above it
// and took the process down. Loopback, port 0, closed in `finally` — nothing leaves the
// machine and nothing is left listening.
describe("a handler that throws", () => {
  it("costs one request, not the whole review", async () => {
    const server = await listen(() => {
      throw new Error("something nobody anticipated");
    }, 0);
    try {
      const first = await fetch(`${server.origin}/?token=${TOKEN}`);
      expect(first.status).toBe(500);
      expect(await first.text()).toContain("something nobody anticipated");

      // Still answering, which is the whole point: the process is alive.
      expect((await fetch(`${server.origin}/?token=${TOKEN}`)).status).toBe(500);
    } finally {
      await server.close();
    }
  });
});

describe("a comment written on a line", () => {
  // The one item the page invents rather than echoes. Its id is the place, so it is checked
  // for the shape an agent will read it as.
  it("is taken when its id names a path and a positive line", () => {
    const { handle, submitted } = make();

    const response = handle({
      method: "POST",
      url: `/submit?token=${TOKEN}`,
      body: selection([
        { kind: "comment", id: "Sources/A.swift:42", message: "+  let x = 1", note: "move this" },
      ]),
    });

    expect(response.status).toBe(200);
    expect(submitted[0][0]).toEqual({
      kind: "comment",
      id: "Sources/A.swift:42",
      message: "+  let x = 1",
      note: "move this",
    });
  });

  it.each(["Sources/A.swift", "Sources/A.swift:0", "Sources/A.swift:-1", ":12", "A.swift:1.5"])(
    "is refused when its id does not name a place: %s",
    (id) => {
      const { handle, submitted } = make();

      const response = handle({
        method: "POST",
        url: `/submit?token=${TOKEN}`,
        body: selection([{ kind: "comment", id, message: "m", note: "n" }]),
      });

      expect(response.status).toBe(400);
      expect(submitted).toEqual([]);
    },
  );

  // The shape check is for comments only: a finding's id is a check name, and demanding a
  // line number of it would refuse every real selection.
  it("leaves the other kinds' ids alone", () => {
    const { handle } = make();

    const response = handle({
      method: "POST",
      url: `/submit?token=${TOKEN}`,
      body: selection([{ kind: "warning", id: "untracked-files", message: "m", note: "" }]),
    });

    expect(response.status).toBe(200);
  });
});
