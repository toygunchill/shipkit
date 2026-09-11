import { createConnection } from "node:net";
import { defaultSocketPath } from "../approval/client.js";
import { PROTOCOL_VERSION } from "../approval/protocol.js";

// `security(1)` used to be the way this module read a token out of the login
// keychain. That broke: an item the menu-bar app writes through `SecItemAdd`
// carries an ACL that does not trust `/usr/bin/security`, so
// `find-generic-password` raises a GUI prompt and blocks until someone
// answers it — measured, not theorized, and adding `/usr/bin/security` as a
// trusted application did not fix it either. The token now travels over the
// unix socket the approval surface already listens on; see
// `apps/menubar/Sources/ShipkitKit/Listener.swift`'s `TokenRequest` /
// `TokenResponse` for the wire format this module speaks.

const DEFAULT_TIMEOUT_MS = 5000;

type TokenRequest = {
  protocol: number;
  kind: "token";
  account: string;
};

type TokenResponse = {
  protocol: number;
  kind: string;
  secret: string | null;
};

function isTokenResponse(value: unknown): value is TokenResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.protocol === "number" &&
    typeof candidate.kind === "string" &&
    (typeof candidate.secret === "string" || candidate.secret === null)
  );
}

/**
 * Asks the approval surface for the named secret over the socket, and waits for
 * an answer.
 *
 * Never throws. Nothing listening, a timeout, a connection that closes without
 * a full line, and a reply that doesn't parse all resolve to `undefined` —
 * exactly what a genuinely absent token looks like, because to `jiraToken`'s
 * caller a missing surface and a missing secret are the same "keep going
 * without one" outcome.
 */
export function readSocketSecret(
  account: string,
  options: { socketPath?: string; timeoutMs?: number } = {},
): Promise<string | undefined> {
  const path = options.socketPath ?? defaultSocketPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<string | undefined>((resolve) => {
    let settled = false;
    let buffer = "";

    const socket = createConnection({ path });

    const finish = (secret: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(secret);
    };

    const timer = setTimeout(() => finish(undefined), timeoutMs);
    // Must not hold the process open on its own; the socket is what this call
    // is waiting for.
    timer.unref?.();

    socket.on("connect", () => {
      const request: TokenRequest = { protocol: PROTOCOL_VERSION, kind: "token", account };
      socket.write(`${JSON.stringify(request)}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(buffer.slice(0, newline));
      } catch {
        finish(undefined);
        return;
      }

      if (
        !isTokenResponse(parsed) ||
        parsed.protocol !== PROTOCOL_VERSION ||
        parsed.kind !== "token"
      ) {
        finish(undefined);
        return;
      }

      finish(parsed.secret ?? undefined);
    });

    // ENOENT when the socket file is not there, ECONNREFUSED when it is
    // stale. Both mean the same thing to this caller: nobody is home, so
    // there is no token to be had.
    socket.on("error", () => finish(undefined));

    // Closed without a full line. Not an answer.
    socket.on("close", () => finish(undefined));
  });
}

/**
 * The environment first, so CI and a deliberate override keep working, then
 * the socket — which is where the token lives on a machine whose agent was
 * launched from the Dock and never saw a shell profile.
 *
 * Never throws; see `readSocketSecret`.
 */
export async function jiraToken(
  options: { socketPath?: string; timeoutMs?: number } = {},
): Promise<string | undefined> {
  const fromEnv = process.env.SHIPKIT_JIRA_TOKEN;
  // Whitespace is not a token. `SHIPKIT_JIRA_TOKEN=" "` must fall through to the socket
  // like an unset variable would, not reach Jira as a credential that can only fail.
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv;
  return readSocketSecret("jira", options);
}
