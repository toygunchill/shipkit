import { createConnection, type Socket } from "node:net";
import { defaultSocketPath } from "./client.js";

/**
 * Telling the menu-bar application that an agent is here.
 *
 * The menu bar cannot produce a review — it holds no agent, and MCP is
 * request/response, so a server cannot hand work to an agent that did not ask for it. What
 * it can know is whether an agent *exists*, and that is what this is for: its Review button
 * either hands work to something real or says plainly that there is nothing to hand it to.
 *
 * The connection is the registration. `shipkit mcp` runs as a child of the agent for
 * exactly as long as the agent does, so holding one connection open says "an agent is
 * here" for precisely the right interval, with no heartbeat and nothing to expire — a
 * vanished peer reaches the other side as end-of-file.
 *
 * Nothing about this is required for shipkit to work. No menu-bar application, or one that
 * is not running, is the ordinary case: the socket is simply not there, and attaching fails
 * silently rather than making the agent's own startup depend on an optional companion.
 */

export type Attachment = {
  /** Stops announcing this agent. Safe to call more than once. */
  detach: () => void;
};

export function attachAgent(
  name: string,
  options: { socketPath?: string } = {},
): Promise<Attachment> {
  const path = options.socketPath ?? defaultSocketPath();

  return new Promise<Attachment>((resolve) => {
    let socket: Socket;
    let settled = false;

    const give = (attachment: Attachment): void => {
      if (settled) return;
      settled = true;
      resolve(attachment);
    };

    // Not having a menu bar is not a failure. Every path below resolves with something the
    // caller can call `detach` on, so an agent never has to know whether the companion was
    // there.
    const nothing: Attachment = { detach: () => {} };

    try {
      socket = createConnection({ path });
    } catch {
      give(nothing);
      return;
    }

    socket.on("error", () => {
      socket.destroy();
      give(nothing);
    });

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ kind: "attach", name })}\n`);
    });

    // The acknowledgement, so the attachment is only reported once the other side has
    // recorded it. Resolving on `connect` would claim presence the menu bar might never
    // have registered.
    socket.once("data", () => {
      give({
        detach: () => {
          socket.destroy();
        },
      });
    });

    // The other side going away first — the application quitting — leaves the agent running
    // and unattached, which is exactly what the menu bar will then report.
    socket.on("close", () => {
      give(nothing);
    });
  });
}
