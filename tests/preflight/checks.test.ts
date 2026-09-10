import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { preflight } from "../../src/preflight/checks.js";

const config = loadConfig("tests/fixtures/valid.shipkit.yml");
const base = {
  branch: "bugfix/squadb/31087-invoice",
  base: "develop",
  commits: ["fix(invoice): default citizenship"],
  ticketKey: "ABC-31087",
  issueVerified: true,
  pullRequest: null,
  config,
};
const ids = (r: { warnings: { check: string }[] }) => r.warnings.map((w) => w.check);

describe("preflight", () => {
  it("is silent for a clean branch with no pull request", () => {
    expect(preflight(base).warnings).toEqual([]);
  });

  it("warns that a push will dismiss existing approvals", () => {
    const result = preflight({
      ...base,
      pullRequest: { number: 1, baseRefName: "develop", labels: [], approvals: ["alice", "bob"] },
    });
    const finding = result.warnings.find((w) => w.check === "approvals-dismissed");
    expect(finding?.message).toContain("2");
  });

  it("stays silent when the pull request has no approvals", () => {
    const result = preflight({
      ...base,
      pullRequest: { number: 1, baseRefName: "develop", labels: [], approvals: [] },
    });
    expect(ids(result)).not.toContain("approvals-dismissed");
  });

  it("warns about commits citing another ticket", () => {
    const result = preflight({
      ...base,
      commits: ["fix(invoice): default citizenship", "[ABC-27975] fix(split-passenger): popup"],
    });
    const finding = result.warnings.find((w) => w.check === "foreign-commits");
    expect(finding?.message).toContain("ABC-27975");
  });

  it("does not treat the branch's own ticket as foreign", () => {
    const result = preflight({
      ...base,
      commits: ["[ABC-31087] fix(invoice): default citizenship"],
    });
    expect(ids(result)).not.toContain("foreign-commits");
  });

  it("is silent about foreign commits when no ticket is known", () => {
    const result = preflight({
      ...base,
      ticketKey: undefined,
      commits: ["[ABC-27975] fix(split-passenger): popup"],
    });
    expect(ids(result)).not.toContain("foreign-commits");
  });

  it("warns when the chosen base differs from the open pull request's", () => {
    const result = preflight({
      ...base,
      pullRequest: { number: 1, baseRefName: "release/3.76.0", labels: [], approvals: [] },
    });
    const finding = result.warnings.find((w) => w.check === "base-mismatch");
    expect(finding?.message).toContain("release/3.76.0");
    expect(finding?.message).toContain("develop");
  });

  it("stays silent when the pull request base matches the chosen base", () => {
    const result = preflight({
      ...base,
      pullRequest: { number: 1, baseRefName: "develop", labels: [], approvals: [] },
    });
    expect(result.warnings).toEqual([]);
  });

  it("warns about a blocking label, case-insensitively", () => {
    const withLabels = loadConfig("tests/fixtures/blocking-labels.shipkit.yml");
    const result = preflight({
      ...base,
      config: withLabels,
      pullRequest: { number: 1, baseRefName: "develop", labels: ["In Test"], approvals: [] },
    });
    expect(ids(result)).toContain("blocking-label");
  });

  it("warns when a ticket key could not be verified against Jira", () => {
    const result = preflight({ ...base, issueVerified: false });
    const finding = result.warnings.find((w) => w.check === "issue-unverified");
    expect(finding?.message).toContain("ABC-31087");
  });

  it("is silent about verification when there is no ticket key", () => {
    const result = preflight({ ...base, ticketKey: undefined, issueVerified: false });
    expect(ids(result)).not.toContain("issue-unverified");
  });

  it("ignores labels that are not configured as blocking", () => {
    const withLabels = loadConfig("tests/fixtures/blocking-labels.shipkit.yml");
    const result = preflight({
      ...base,
      config: withLabels,
      pullRequest: { number: 1, baseRefName: "develop", labels: ["needs-design"], approvals: [] },
    });
    expect(ids(result)).not.toContain("blocking-label");
  });
});
