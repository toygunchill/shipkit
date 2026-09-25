import { createConnection, type Socket } from "node:net";
import { defaultSocketPath } from "./client.js";

/**
 * Telling the menu-bar application that an agent is here, and keeping it told.
 *
 * The menu bar cannot produce a review — it holds no agent, and MCP is
 * request/response, so a server cannot hand work to an agent that did not ask for it. What
 * it can know is whether an agent *exists*, and that is what this is for: its Review button
 * either starts one, hands work to one, or says plainly that there is none.
 *
 * The connection is the registration. `shipkit mcp` runs as a child of the agent for
 * exactly as long as the agent does, so holding one connection open says "an agent is here"
 * for precisely the right interval, with no heartbeat and nothing to expire — a vanished
 * peer reaches the other side as end-of-file.
 *
 * **It reconnects, and that is not a refinement.** An agent outlives the application: the
 * app is quit, upgraded, or restarted, and every one of those drops every connection it
 * held. A one-shot attach was tried first and meant that the first app restart lost
 * presence permanently — the menu bar said "no agent is running" for the rest of the
 * agent's life, with no way to recover but restarting the agent too. Since upgrading the
 * app is the most ordinary thing a person does with it, that is most of the time.
 *
 * None of it is required. No application, or one that is not running, is the ordinary case:
 * the socket is simply absent, and this keeps quietly trying in the background rather than
 * making an agent's own startup depend on an optional companion.
 */

export type Attachment = {
  /** Stops announcing this agent, and stops trying to. Safe to call more than once. */
  detach: () => void;
};

/** How long to wait before trying again, backing off to a minute. */
export function retryDelayMs(attempt: number): number {
  // Quick at first, because the common case is the application coming straight back after
  // an upgrade, and slow after that, because the other common case is no application at all
  // and a process that reconnects every second forever is a process nobody wants running.
  const delay = 1000 * 2 ** Math.min(attempt, 6);
  return Math.min(delay, 60_000);
}

export type AttachOptions = {
  socketPath?: string;
  /** Injected in tests. Real callers use the default. */
  delayFor?: (attempt: number) => number;
};

export function attachAgent(name: string, options: AttachOptions = {}): Attachment {
  const path = options.socketPath ?? defaultSocketPath();
  const delayFor = options.delayFor ?? retryDelayMs;

  let stopped = false;
  let socket: Socket | undefined;
  let timer: NodeJS.Timeout | undefined;
  let attempt = 0;

  const later = (): void => {
    if (stopped) return;
    const wait = delayFor(attempt);
    attempt += 1;
    timer = setTimeout(connect, wait);
    // Never a reason for this process to stay alive. The agent decides when it exits; a
    // pending retry must not be what keeps it running.
    timer.unref?.();
  };

  function connect(): void {
    if (stopped) return;

    let next: Socket;
    try {
      next = createConnection({ path });
    } catch {
      later();
      return;
    }
    socket = next;

    next.on("error", () => {
      next.destroy();
    });

    next.on("connect", () => {
      next.write(`${JSON.stringify({ kind: "attach", name })}\n`);
    });

    next.once("data", () => {
      // Acknowledged, so the next drop is a real drop rather than a connection that never
      // registered. Only then is the backoff worth resetting.
      attempt = 0;
    });

    next.on("close", () => {
      if (socket === next) socket = undefined;
      // The application went away — quit, upgraded, crashed. Keep saying we are here, so
      // that when it comes back it learns so without the agent having to restart.
      later();
    });
  }

  connect();

  return {
    detach: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      socket?.destroy();
      socket = undefined;
    },
  };
}
