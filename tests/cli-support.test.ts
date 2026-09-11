import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cliRemedy,
  extractIssueKeysFromBody,
  firstIssueKey,
  isValidBase,
  resolveIssue,
  selectIssueKeys,
  ticketFromBranch,
} from "../src/cli-support.js";
import type { SubmitResult } from "../src/submit/run.js";

const KEY_PATTERN = "DCP-\\d+";

describe("firstIssueKey", () => {
  it("returns the first key matching the pattern anywhere in the text", () => {
    expect(firstIssueKey("[ABC-31087] fix(invoice): default citizenship", KEY_PATTERN)).toBe(
      "ABC-31087",
    );
  });

  it("returns undefined when there is no match", () => {
    expect(firstIssueKey("fix(invoice): default citizenship", KEY_PATTERN)).toBeUndefined();
  });
});

describe("ticketFromBranch", () => {
  it("extracts the key embedded in a branch name", () => {
    expect(ticketFromBranch("bugfix/squadb/31087-invoice-fix", KEY_PATTERN)).toBeUndefined();
    expect(ticketFromBranch("bugfix/ABC-31087/invoice-fix", KEY_PATTERN)).toBe("ABC-31087");
  });

  it("returns undefined when the branch has no matching key", () => {
    expect(ticketFromBranch("feature/no-ticket-here", KEY_PATTERN)).toBeUndefined();
  });

  it("delegates to firstIssueKey", () => {
    expect(ticketFromBranch("bugfix/ABC-31087/invoice-fix", KEY_PATTERN)).toBe(
      firstIssueKey("bugfix/ABC-31087/invoice-fix", KEY_PATTERN),
    );
  });
});

describe("resolveIssue", () => {
  const originalToken = process.env.SHIPKIT_JIRA_TOKEN;

  beforeEach(() => {
    delete process.env.SHIPKIT_JIRA_TOKEN;
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.SHIPKIT_JIRA_TOKEN;
    else process.env.SHIPKIT_JIRA_TOKEN = originalToken;
  });

  it("returns undefined without a network call when no key is given", async () => {
    process.env.SHIPKIT_JIRA_TOKEN = "some-token";
    await expect(
      resolveIssue(undefined, { jira: { baseUrl: "https://jira.example.com" } }),
    ).resolves.toBeUndefined();
  });

  it("short-circuits to undefined when SHIPKIT_JIRA_TOKEN is unset, even with a key", async () => {
    // No token means no fetch is attempted — if this reached fetchIssue it would try a
    // real network call, which the test suite must never do.
    await expect(
      resolveIssue("ABC-1", { jira: { baseUrl: "https://jira.example.com" } }),
    ).resolves.toBeUndefined();
  });

  it("short-circuits to undefined when SHIPKIT_JIRA_TOKEN is empty", async () => {
    process.env.SHIPKIT_JIRA_TOKEN = "";
    await expect(
      resolveIssue("ABC-1", { jira: { baseUrl: "https://jira.example.com" } }),
    ).resolves.toBeUndefined();
  });

  it("resolves an issue using a keychain token when the environment has none", async () => {
    delete process.env.SHIPKIT_JIRA_TOKEN;
    let seenToken = "";
    const issue = await resolveIssue(
      "ABC-1",
      { jira: { baseUrl: "https://example.invalid/jira" } },
      async (_url: string, token: string) => {
        seenToken = token;
        return { key: "ABC-1", fields: { issuetype: { name: "Story" }, summary: "s" } };
      },
      () => "from-keychain",
    );
    expect(seenToken).toBe("from-keychain");
    expect(issue?.key).toBe("ABC-1");
  });
});

describe("extractIssueKeysFromBody", () => {
  const config = { jira: { section: "Issues Addressed", keyPattern: KEY_PATTERN } };

  it("extracts every key cited in the issues section", () => {
    const body = "## Issues Addressed\n\n- ABC-1\n- ABC-2\n";
    expect(extractIssueKeysFromBody(body, config)).toEqual(["ABC-1", "ABC-2"]);
  });

  it("returns an empty array when the section is absent", () => {
    expect(extractIssueKeysFromBody("## Summary\n\ntext\n", config)).toEqual([]);
  });

  it("returns an empty array when the section has no matching key", () => {
    const body = "## Issues Addressed\n\n- none\n";
    expect(extractIssueKeysFromBody(body, config)).toEqual([]);
  });

  it("respects a renamed issues section", () => {
    const renamed = { jira: { section: "Related Tickets", keyPattern: KEY_PATTERN } };
    const body = "## Related Tickets\n\n- ABC-9\n";
    expect(extractIssueKeysFromBody(body, renamed)).toEqual(["ABC-9"]);
  });

  it("de-duplicates a key cited via a markdown link, whose text and URL both match", () => {
    // "- [ABC-1](https://jira.example.com/browse/ABC-1)" is the ordinary citation shape
    // — the key appears once in the link text and once in the URL, so a naive regex match
    // counts it twice.
    const body =
      "## Issues Addressed\n\n- [ABC-1](https://jira.example.com/browse/ABC-1)\n";
    expect(extractIssueKeysFromBody(body, config)).toEqual(["ABC-1"]);
  });

  it("keeps two genuinely different cited keys, in the order they appear", () => {
    const body =
      "## Issues Addressed\n\n" +
      "- [ABC-2](https://jira.example.com/browse/ABC-2)\n" +
      "- [ABC-1](https://jira.example.com/browse/ABC-1)\n";
    expect(extractIssueKeysFromBody(body, config)).toEqual(["ABC-2", "ABC-1"]);
  });
});

describe("selectIssueKeys", () => {
  it("uses the body's keys when --issue is not given", () => {
    expect(selectIssueKeys(["ABC-1"], undefined)).toEqual(["ABC-1"]);
  });

  it("narrows to --issue when it names one of the body's own keys", () => {
    expect(selectIssueKeys(["ABC-1", "ABC-2"], "ABC-2")).toEqual(["ABC-2"]);
  });

  it("ignores --issue naming a key the body does not cite, and uses the body's keys instead", () => {
    // This is the fix for the reported bug: a caller passing --issue for an unrelated,
    // compliant ticket must not be able to make a body citing something else look clean.
    expect(selectIssueKeys(["ABC-1"], "ABC-99999")).toEqual(["ABC-1"]);
  });

  it("returns no keys when the body cites none, even if --issue is given", () => {
    expect(selectIssueKeys([], "ABC-99999")).toEqual([]);
  });
});

describe("isValidBase", () => {
  it("accepts plausible branch and ref names", () => {
    expect(isValidBase("main")).toBe(true);
    expect(isValidBase("release/3.9.0")).toBe(true);
    expect(isValidBase("feature/x/ABC-1-thing")).toBe(true);
  });

  it("rejects a value shaped like a git option", () => {
    expect(isValidBase("--output=/tmp/x")).toBe(false);
    expect(isValidBase("-x")).toBe(false);
  });

  it("rejects a leading dash even without an = sign", () => {
    expect(isValidBase("--force")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidBase("")).toBe(false);
  });
});

describe("cliRemedy", () => {
  const refused = (refusal: SubmitResult["refusal"]): SubmitResult => ({
    code: 2,
    findings: [],
    warnings: [{ check: "untracked-files", message: "m" }],
    message: "Refusing to proceed.",
    committed: false,
    pushed: false,
    refusal,
  });

  it("suggests --yes for an unacknowledged refusal when --yes was not given", () => {
    expect(cliRemedy(refused("unacknowledged"), false)).toBe(
      "Re-run with --yes to accept these.",
    );
  });

  it("says nothing when --yes was already given", () => {
    expect(cliRemedy(refused("unacknowledged"), true)).toBeUndefined();
  });

  // Each is a different reason a reader could be misled into a --yes retry that
  // reproduces the identical refusal — --yes cannot make a person appear, undo a
  // denial, or restart a wait that already ran out.
  it.each(["denied", "timed-out", "no-surface", "human-required"] as const)(
    "says nothing for a %s refusal, even without --yes",
    (reason) => {
      expect(cliRemedy(refused(reason), false)).toBeUndefined();
    },
  );

  it("says nothing on a successful result", () => {
    const ok: SubmitResult = {
      code: 0,
      findings: [],
      warnings: [],
      committed: true,
      pushed: true,
      url: "https://github.com/x/y/pull/1",
      updated: false,
    };
    expect(cliRemedy(ok, false)).toBeUndefined();
  });
});
