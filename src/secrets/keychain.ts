import { execFileSync } from "node:child_process";

/** The seam that keeps `security` out of the tests. */
export type SecurityRunner = (args: string[]) => string;

const defaultRunner: SecurityRunner = (args) =>
  execFileSync("/usr/bin/security", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    // If the keychain item's ACL doesn't trust /usr/bin/security — the default when
    // another application created it — macOS raises a GUI prompt and the call blocks
    // until someone answers it. In an MCP child launched from the Dock that is a hung
    // tool call with no ceiling; a timeout turns it into an ordinary failure instead.
    timeout: 5000,
  });

/**
 * Reads a secret shipkit stored in the login keychain.
 *
 * Never throws. `security` exits non-zero when the item is absent, which is the
 * ordinary state of a machine where nobody has saved a token — an error type
 * here would make the common case look like a fault.
 */
export function readKeychainSecret(
  account: string,
  run: SecurityRunner = defaultRunner,
): string | undefined {
  let raw: string;
  try {
    raw = run(["find-generic-password", "-s", "shipkit", "-a", account, "-w"]);
  } catch {
    return undefined;
  }
  const value = raw.trim();
  return value.length > 0 ? value : undefined;
}

/**
 * The environment first, so CI and a deliberate override keep working, then the
 * keychain — which is where the token lives on a machine whose agent was
 * launched from the Dock and never saw a shell profile.
 */
export function jiraToken(run: SecurityRunner = defaultRunner): string | undefined {
  const fromEnv = process.env.SHIPKIT_JIRA_TOKEN;
  // Whitespace is not a token. `SHIPKIT_JIRA_TOKEN=" "` must fall through to the keychain
  // like an unset variable would, not reach Jira as a credential that can only fail.
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv;
  return readKeychainSecret("jira", run);
}
