import { beforeEach, describe, expect, it, vi } from "vitest";

// Asserts the exact options passed to `execFileSync`, the way tests/vcs/git.args.test.ts
// does for git — the fake SecurityRunner used in keychain.test.ts bypasses this call
// entirely, so it cannot see whether the real runner ever sets a timeout.
const execFileSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

const { readKeychainSecret } = await import("../../src/secrets/keychain.js");

beforeEach(() => {
  execFileSyncMock.mockReset();
  execFileSyncMock.mockImplementation(() => "s3cret\n");
});

describe("readKeychainSecret's default runner", () => {
  // If the keychain item's ACL doesn't trust /usr/bin/security, macOS raises a GUI prompt
  // and an untimed call blocks until someone answers it — a hung tool call with no ceiling
  // when the process is an MCP child launched from the Dock. A timeout turns that into an
  // ordinary, reportable failure instead.
  it("calls /usr/bin/security with a timeout", () => {
    readKeychainSecret("jira");

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = execFileSyncMock.mock.calls[0] as [
      string,
      string[],
      { timeout?: number },
    ];
    expect(command).toBe("/usr/bin/security");
    expect(args).toEqual(["find-generic-password", "-s", "shipkit", "-a", "jira", "-w"]);
    expect(options.timeout).toBe(5000);
  });
});
