import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attachAgent, retryDelayMs } from "../../src/approval/attach.js";

/** A stand-in for the menu-bar application: accepts, acknowledges, counts. */
function application(path: string) {
  const seen: string[] = [];
  const live = new Set<Socket>();
  const server: Server = createServer((socket) => {
    live.add(socket);
    socket.on("close", () => live.delete(socket));
    socket.on("data", (chunk) => {
      seen.push(chunk.toString().trim());
      socket.write('{"ok":true}\n');
    });
  });
  return {
    seen,
    get connections() {
      return live.size;
    },
    listen: () => new Promise<void>((resolve) => server.listen(path, resolve)),
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of live) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.length = 0;
});

function scratchSocket(): string {
  const directory = mkdtempSync(join(tmpdir(), "shipkit-attach-"));
  directories.push(directory);
  return join(directory, "approvals.sock");
}

describe("announcing an agent to the menu bar", () => {
  it("says what it is, once connected", async () => {
    const path = scratchSocket();
    const app = application(path);
    await app.listen();

    const attachment = attachAgent("claude", { socketPath: path });
    await wait(150);

    expect(app.seen[0]).toContain('"kind":"attach"');
    expect(app.seen[0]).toContain("claude");
    attachment.detach();
    await app.stop();
  });

  // The defect this replaced a one-shot attach for. An agent outlives the
  // application: quitting, upgrading or restarting it drops every connection,
  // and attaching only at startup meant the menu bar said "no agent is running"
  // for the rest of that agent's life. Upgrading the app is the most ordinary
  // thing a person does with it.
  it("comes back after the application restarts", async () => {
    const path = scratchSocket();
    const first = application(path);
    await first.listen();

    const attachment = attachAgent("claude", { socketPath: path, delayFor: () => 20 });
    await wait(150);
    expect(first.connections).toBe(1);

    await first.stop();
    await wait(60);

    const second = application(path);
    await second.listen();
    await wait(300);

    expect(second.connections, "the agent never came back").toBe(1);
    expect(second.seen[0]).toContain('"kind":"attach"');

    attachment.detach();
    await second.stop();
  });

  // Starting before the application is the normal order on a fresh login, and
  // an agent that gave up then would never be seen at all.
  it("waits for an application that is not there yet", async () => {
    const path = scratchSocket();

    const attachment = attachAgent("claude", { socketPath: path, delayFor: () => 20 });
    await wait(100);

    const app = application(path);
    await app.listen();
    await wait(300);

    expect(app.connections).toBe(1);
    attachment.detach();
    await app.stop();
  });

  it("stops trying once detached", async () => {
    const path = scratchSocket();

    const attachment = attachAgent("claude", { socketPath: path, delayFor: () => 20 });
    attachment.detach();

    const app = application(path);
    await app.listen();
    await wait(200);

    expect(app.connections).toBe(0);
    await app.stop();
  });

  it("detaching twice is not an error", () => {
    const attachment = attachAgent("claude", { socketPath: scratchSocket(), delayFor: () => 20 });

    expect(() => {
      attachment.detach();
      attachment.detach();
    }).not.toThrow();
  });

  // No application at all is the ordinary case, and serving must not depend on
  // an optional companion — attaching returns something usable either way.
  it("returns an attachment even with nothing listening", () => {
    const attachment = attachAgent("claude", { socketPath: scratchSocket(), delayFor: () => 20 });

    expect(typeof attachment.detach).toBe("function");
    attachment.detach();
  });
});

describe("how long it waits between tries", () => {
  it("is quick at first, because the application is usually coming straight back", () => {
    expect(retryDelayMs(0)).toBe(1000);
    expect(retryDelayMs(1)).toBe(2000);
  });

  // The other common case is no application at all, and a process reconnecting
  // every second forever is one nobody wants running.
  it("backs off, and stops at a minute", () => {
    expect(retryDelayMs(6)).toBe(60_000);
    expect(retryDelayMs(50)).toBe(60_000);
  });
});
