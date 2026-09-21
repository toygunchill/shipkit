import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { offerReview } from "../../src/approval/client.js";
import {
  PROTOCOL_VERSION,
  decodeReviewResponse,
  encodeReviewOffer,
  ProtocolError,
  type ReviewOffer,
} from "../../src/approval/protocol.js";
import { reviewFingerprint } from "../../src/approval/fingerprint.js";

const situation = {
  repo: "example-app",
  root: "/Users/x/example-app",
  url: "http://127.0.0.1:53983/?token=abc",
  branch: "bugfix/squad/1-invoice",
  base: "develop",
  commitMessage: "fix(x): y",
  diffstat: " 1 file changed",
  items: [{ kind: "warning", id: "untracked-files", message: "m", severity: "warns" as const }],
  files: [{ path: "A.swift", status: "modified", line: 3 }],
};

const OFFER: ReviewOffer = {
  protocol: PROTOCOL_VERSION,
  kind: "review",
  fingerprint: reviewFingerprint(situation),
  ...situation,
};

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in menu bar: takes one line, replies with whatever the test says. */
function surface(reply: (line: string) => string | undefined): Promise<{ path: string; close: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "shipkit-offer-"));
  dirs.push(dir);
  const path = join(dir, "s.sock");
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const answer = reply(buffer.slice(0, newline));
      if (answer === undefined) {
        socket.destroy();
        return;
      }
      socket.write(answer);
    });
    socket.on("error", () => undefined);
  });
  return new Promise((resolve) => {
    server.listen(path, () =>
      resolve({
        path,
        close: () => new Promise<void>((done) => server.close(() => done())),
      }),
    );
  });
}

const answered = (over: Record<string, unknown> = {}): string =>
  `${JSON.stringify({
    protocol: PROTOCOL_VERSION,
    kind: "review",
    fingerprint: OFFER.fingerprint,
    answer: "selected",
    items: [{ kind: "warning", id: "untracked-files", message: "m", note: "fix it" }],
    ...over,
  })}\n`;

describe("offering a review to the menu bar", () => {
  it("carries the selection back when somebody answers there", async () => {
    const menuBar = await surface(() => answered());
    const { answer } = offerReview(OFFER, { socketPath: menuBar.path });

    const outcome = await answer;

    expect(outcome.outcome).toBe("answered");
    expect(outcome.outcome === "answered" && outcome.response.items[0].note).toBe("fix it");
    await menuBar.close();
  });

  // The ordinary case: nobody has the application installed, and the page is a
  // complete answer on its own. Not a failure, and nothing is printed about it.
  it("says no-surface when nothing is listening", async () => {
    const { answer } = offerReview(OFFER, { socketPath: "/tmp/shipkit-nothing-here.sock" });

    expect((await answer).outcome).toBe("no-surface");
  });

  // The page won. Closing this connection is what tells the application to take
  // the review off the panel, and it must not be reported as anything going wrong.
  it("says withdrawn when the caller closes it, not failed", async () => {
    const menuBar = await surface(() => undefined);
    const { answer, cancel } = offerReview(OFFER, { socketPath: menuBar.path });
    cancel();

    expect((await answer).outcome).toBe("withdrawn");
    await menuBar.close();
  });

  it("reports an answer for a different review rather than taking it", async () => {
    const menuBar = await surface(() => answered({ fingerprint: "0".repeat(64) }));
    const { answer } = offerReview(OFFER, { socketPath: menuBar.path });

    const outcome = await answer;

    expect(outcome.outcome).toBe("failed");
    expect(outcome.outcome === "failed" && outcome.detail).toContain("different review");
    await menuBar.close();
  });

  it("reports a surface speaking another protocol, which a denial would hide", async () => {
    const menuBar = await surface(() => answered({ protocol: PROTOCOL_VERSION + 1 }));
    const { answer } = offerReview(OFFER, { socketPath: menuBar.path });

    const outcome = await answer;

    expect(outcome.outcome === "failed" && outcome.detail).toContain("protocol");
    await menuBar.close();
  });
});

describe("decoding what the menu bar said", () => {
  it("refuses an answer of nothing that nonetheless carries items", () => {
    // The two readings lead opposite ways — write these, or clear what is
    // pending — so this is refused rather than guessed at.
    const line = JSON.stringify({
      protocol: PROTOCOL_VERSION,
      kind: "review",
      fingerprint: OFFER.fingerprint,
      answer: "nothing",
      items: [{ kind: "warning", id: "a", message: "m", note: "" }],
    });

    expect(() => decodeReviewResponse(line, OFFER.fingerprint)).toThrow(ProtocolError);
  });

  it("takes an empty selection as a decision in its own right", () => {
    const line = JSON.stringify({
      protocol: PROTOCOL_VERSION,
      kind: "review",
      fingerprint: OFFER.fingerprint,
      answer: "nothing",
      items: [],
    });

    expect(decodeReviewResponse(line, OFFER.fingerprint).answer).toBe("nothing");
  });

  it("puts one offer on one line, so a message with a newline cannot split it", () => {
    const encoded = encodeReviewOffer({ ...OFFER, commitMessage: "one\ntwo" });

    expect(encoded.split("\n")).toHaveLength(2);
    expect(encoded.endsWith("\n")).toBe(true);
  });
});
