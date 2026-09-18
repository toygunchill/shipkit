import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { FixRequestItem, FixRequestKind } from "./fixrequest.js";

/**
 * The loopback surface `shipkit review` puts the page on, split in two: a pure handler that
 * the suite drives directly, and a socket that only the CLI ever opens.
 *
 * No test in this repository may open a real port, so the handler takes a request as data
 * and answers with data. Everything worth asserting — the token, the loopback rule, the
 * single-use POST — lives on that side of the line.
 */

const KINDS: readonly FixRequestKind[] = ["warning", "finding", "readiness", "advice", "comment"];

export type ReviewHttpRequest = {
  method: string;
  /** The request target as it arrived, e.g. `/submit?token=abc`. */
  url: string;
  /** The peer's address, from the socket. Absent means the socket could not name it. */
  remoteAddress?: string | undefined;
  body: string;
};

export type ReviewHttpResponse = {
  status: number;
  contentType: string;
  body: string;
};

/**
 * Whether a peer is this machine talking to itself.
 *
 * The server binds to `127.0.0.1` explicitly, so in practice nothing else can connect — this
 * is the belt to that braces, and it is worth having because the two are independent: a
 * future edit that changes the bind address, or a proxy in front, would otherwise silently
 * open the page to the network. `::ffff:127.0.0.1` is how a dual-stack Node socket spells
 * an IPv4 loopback peer.
 *
 * Deliberately three exact strings and not a `127.` prefix test: the whole 127/8 block is
 * loopback, but nothing can reach this server from 127.0.0.2 while it is bound to
 * 127.0.0.1, so admitting the range would only widen what a future bind change could expose.
 */
export function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * Constant-time comparison, on equal-length buffers only.
 *
 * `timingSafeEqual` throws on a length mismatch, so the length is checked first — which
 * leaks the token's length and nothing else, and the length is fixed and public anyway.
 */
function tokenMatches(given: string | null, expected: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Parses the submitted selection, or `undefined` when it is not one. */
function parseSelection(body: string): FixRequestItem[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) return undefined;

  const selection: FixRequestItem[] = [];
  for (const raw of items) {
    if (typeof raw !== "object" || raw === null) return undefined;
    const { kind, id, message, note } = raw as Record<string, unknown>;
    if (typeof kind !== "string" || !KINDS.includes(kind as FixRequestKind)) return undefined;
    if (typeof id !== "string" || id.length === 0) return undefined;
    // A comment is the one item the page invents rather than echoes, so its id is checked
    // for the shape the agent will read it as: `path:line`, line a positive integer.
    if (kind === "comment" && !/^.+:[1-9][0-9]*$/.test(id)) return undefined;
    if (typeof message !== "string") return undefined;
    // The note is the one field a person types, and an empty one is an ordinary answer:
    // they ticked the box and had nothing to add.
    if (note !== undefined && typeof note !== "string") return undefined;
    selection.push({ kind: kind as FixRequestKind, id, message, note: (note ?? "").trim() });
  }
  return selection;
}

export type HandlerDeps = {
  token: string;
  /** The rendered page, served once per GET. */
  page: string;
  /** Called with the selection, at most once. */
  submit: (items: FixRequestItem[]) => void;
  /**
   * Opens a file in the editor. Omitted when there is no editor to open — the page's button
   * then reports that it could not, which is the honest answer.
   */
  openEditor?: ((path: string, line: number) => void) | undefined;
  /**
   * The paths the page offered. Nothing outside this set is opened, so `/open` cannot be
   * turned into "run the editor against any file on this machine" by a caller that has the
   * token — the set is the diff shipkit itself computed, not anything the request supplies.
   */
  openable: ReadonlySet<string>;
};

export type ReviewHandler = (request: ReviewHttpRequest) => ReviewHttpResponse;

function text(status: number, body: string): ReviewHttpResponse {
  return { status, contentType: "text/plain; charset=utf-8", body };
}

/**
 * The whole surface: `GET /` serves the page, `POST /submit` takes the selection once, and
 * `POST /open` opens a file the page offered. Everything else is a 404.
 *
 * The token gate comes before the routing, so an unauthenticated request cannot learn which
 * paths exist. The loopback gate comes before the token, so a remote peer is refused without
 * being given the chance to guess one.
 */
export function createHandler(deps: HandlerDeps): ReviewHandler {
  let submitted = false;

  return (request) => {
    if (!isLoopback(request.remoteAddress)) {
      return text(403, "shipkit review serves this machine only.");
    }

    // A base is required by the URL parser and is never used: only the path and the query
    // of the request target matter, and the Host header is not to be trusted for either.
    //
    // Guarded because Node's HTTP parser hands over request targets the WHATWG URL parser
    // refuses — `//%`, `//[`, `//a%2`, a bare `/\` — and none of them needs a token, since
    // the parse happens before the token check. Unguarded, the throw landed in the `end`
    // callback in `listen`, which nothing catches, and the process died: anything at all on
    // the machine could end a review a person was eight minutes and fourteen ticks into.
    let url: URL;
    try {
      url = new URL(request.url, "http://127.0.0.1");
    } catch {
      return text(400, "Not a request this page makes.");
    }
    if (!tokenMatches(url.searchParams.get("token"), deps.token)) {
      return text(403, "Wrong or missing token.");
    }

    if (request.method === "GET" && url.pathname === "/") {
      return { status: 200, contentType: "text/html; charset=utf-8", body: deps.page };
    }

    if (request.method === "POST" && url.pathname === "/submit") {
      if (submitted) {
        // One review, one answer. A second POST is not a correction — the command has
        // already written the file and printed where it went, and it may well have exited.
        return text(409, "This review has already been answered.");
      }
      const selection = parseSelection(request.body);
      if (selection === undefined) return text(400, "Not a selection.");
      try {
        // Before the 200, and before the door closes on a second attempt. `submit` is what
        // writes the selection to disk, and a page that says "Sent to shipkit" while the
        // write failed is the one lie this feature cannot tell: the person closes the tab
        // believing their ten minutes are saved. A failure leaves the review answerable,
        // so pressing the button again after fixing the disk works.
        deps.submit(selection);
      } catch (error) {
        return text(500, error instanceof Error ? error.message : "The selection was not saved.");
      }
      submitted = true;
      return { status: 200, contentType: "application/json", body: '{"ok":true}' };
    }

    if (request.method === "POST" && url.pathname === "/open") {
      const open = deps.openEditor;
      if (open === undefined) return text(501, "No editor to open.");
      let parsed: unknown;
      try {
        parsed = JSON.parse(request.body);
      } catch {
        return text(400, "Not a file to open.");
      }
      const { path, line } = (parsed ?? {}) as { path?: unknown; line?: unknown };
      if (typeof path !== "string" || !deps.openable.has(path)) {
        return text(404, "Not a file in this change.");
      }
      const at = typeof line === "number" && Number.isInteger(line) && line > 0 ? line : 1;
      try {
        open(path, at);
      } catch {
        return text(502, "The editor could not be started.");
      }
      return { status: 200, contentType: "application/json", body: '{"ok":true}' };
    }

    return text(404, "Nothing here.");
  };
}

export type Listening = {
  /** The origin the page is on, e.g. `http://127.0.0.1:53211`. */
  origin: string;
  close: () => Promise<void>;
};

/**
 * Binds the handler to a loopback socket.
 *
 * `127.0.0.1` explicitly, never `0.0.0.0`: the default would put a page carrying this
 * repository's diff on every interface the machine has. Port 0 asks the kernel for a free
 * one, unless the caller named a port and wants a stable URL.
 *
 * The body is read whole before the handler runs, and capped: the page posts a selection of
 * a few kilobytes, and a handler that buffered without limit would be a way to make shipkit
 * eat memory on a machine where something else already has the token.
 */
export function listen(handler: ReviewHandler, port: number): Promise<Listening> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        aborted = true;
        response.writeHead(413, { "content-type": "text/plain; charset=utf-8" });
        response.end("Too large.");
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (aborted) return;
      // The second half of the guard above: the handler is the only thing running inside
      // this callback, and an exception here has no `catch` anywhere above it — it ends the
      // process. Every handler path that can fail reports its own status; this exists so
      // that a path nobody anticipated costs one request rather than the whole review.
      let answer: ReviewHttpResponse;
      try {
        answer = handler({
          method: request.method ?? "GET",
          url: request.url ?? "/",
          remoteAddress: request.socket.remoteAddress ?? undefined,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      } catch (error) {
        answer = {
          status: 500,
          contentType: "text/plain; charset=utf-8",
          body: error instanceof Error ? error.message : "shipkit review could not answer.",
        };
      }
      response.writeHead(answer.status, {
        "content-type": answer.contentType,
        // The page loads nothing and talks to nowhere but its own origin. Saying so costs
        // one header and removes every way a message in the diff could reach the network.
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
        "cache-control": "no-store",
      });
      response.end(answer.body);
    });
  });

  return new Promise<Listening>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("The review server did not bind to a port."));
        return;
      }
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((done) => {
            // Everything that connected is a browser tab that may be keeping the connection
            // alive; without this the close never completes and the command never exits.
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
