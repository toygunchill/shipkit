import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jiraToken, readKeychainSecret } from "../../src/secrets/keychain.js";

const original = process.env.SHIPKIT_JIRA_TOKEN;
beforeEach(() => {
  delete process.env.SHIPKIT_JIRA_TOKEN;
});
afterEach(() => {
  if (original === undefined) delete process.env.SHIPKIT_JIRA_TOKEN;
  else process.env.SHIPKIT_JIRA_TOKEN = original;
});

describe("readKeychainSecret", () => {
  it("asks security for the shipkit item and trims the answer", () => {
    const seen: string[][] = [];
    const value = readKeychainSecret("jira", (args) => {
      seen.push(args);
      return "s3cret\n";
    });
    expect(value).toBe("s3cret");
    expect(seen).toEqual([["find-generic-password", "-s", "shipkit", "-a", "jira", "-w"]]);
  });

  // `security` exits non-zero when the item is absent, which is the ordinary
  // case on a machine where nobody has saved a token. It is not an error.
  it("returns undefined when the item is missing", () => {
    expect(
      readKeychainSecret("jira", () => {
        throw new Error("The specified item could not be found in the keychain.");
      }),
    ).toBeUndefined();
  });

  it("returns undefined for an empty answer", () => {
    expect(readKeychainSecret("jira", () => "\n")).toBeUndefined();
  });
});

describe("jiraToken", () => {
  it("prefers the environment, so CI and overrides keep working", () => {
    process.env.SHIPKIT_JIRA_TOKEN = "from-env";
    expect(jiraToken(() => "from-keychain")).toBe("from-env");
  });

  it("falls back to the keychain", () => {
    expect(jiraToken(() => "from-keychain")).toBe("from-keychain");
  });

  it("treats an empty environment variable as absent", () => {
    process.env.SHIPKIT_JIRA_TOKEN = "";
    expect(jiraToken(() => "from-keychain")).toBe("from-keychain");
  });

  // SHIPKIT_JIRA_TOKEN=" " is not a token either. Reaching Jira with it would fail the
  // fetch and, upstream in runSubmit, turn into a JiraError that aborts the whole submit —
  // instead of degrading to issue-unverified the way a genuinely unset variable does.
  it("treats a whitespace-only environment variable as absent", () => {
    process.env.SHIPKIT_JIRA_TOKEN = "   ";
    expect(jiraToken(() => "from-keychain")).toBe("from-keychain");
  });

  it("is undefined when neither has it", () => {
    expect(
      jiraToken(() => {
        throw new Error("not found");
      }),
    ).toBeUndefined();
  });
});
