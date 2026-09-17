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
  untrackedFiles: [],
  addedLines: [],
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
      pullRequest: { number: 1, url: "https://github.com/x/y/pull/1", baseRefName: "develop", labels: [], approvals: ["alice", "bob"] },
    });
    const finding = result.warnings.find((w) => w.check === "approvals-dismissed");
    expect(finding?.message).toContain("2");
  });

  it("stays silent when the pull request has no approvals", () => {
    const result = preflight({
      ...base,
      pullRequest: { number: 1, url: "https://github.com/x/y/pull/1", baseRefName: "develop", labels: [], approvals: [] },
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
      pullRequest: { number: 1, url: "https://github.com/x/y/pull/1", baseRefName: "release/3.76.0", labels: [], approvals: [] },
    });
    const finding = result.warnings.find((w) => w.check === "base-mismatch");
    expect(finding?.message).toContain("release/3.76.0");
    expect(finding?.message).toContain("develop");
  });

  it("stays silent when the pull request base matches the chosen base", () => {
    const result = preflight({
      ...base,
      pullRequest: { number: 1, url: "https://github.com/x/y/pull/1", baseRefName: "develop", labels: [], approvals: [] },
    });
    expect(result.warnings).toEqual([]);
  });

  it("warns about a blocking label, case-insensitively", () => {
    const withLabels = loadConfig("tests/fixtures/blocking-labels.shipkit.yml");
    const result = preflight({
      ...base,
      config: withLabels,
      pullRequest: { number: 1, url: "https://github.com/x/y/pull/1", baseRefName: "develop", labels: ["In Test"], approvals: [] },
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
      pullRequest: { number: 1, url: "https://github.com/x/y/pull/1", baseRefName: "develop", labels: ["needs-design"], approvals: [] },
    });
    expect(ids(result)).not.toContain("blocking-label");
  });
});

describe("preflight untracked-files", () => {
  it("warns about the untracked files staging would sweep into the commit", () => {
    const result = preflight({ ...base, untrackedFiles: [".env.local", "debug-notes.md"] });
    const finding = result.warnings.find((w) => w.check === "untracked-files");
    expect(finding?.message).toContain(".env.local");
    expect(finding?.message).toContain("debug-notes.md");
  });

  it("stays silent when the tree carries no untracked files", () => {
    expect(ids(preflight({ ...base, untrackedFiles: [] }))).not.toContain("untracked-files");
  });

  // The list exists so someone can act on it. Twenty paths scrolling past is the same as
  // no warning, so the message names a handful and says how many more there are.
  it("caps the listing and says how many were left out", () => {
    const many = Array.from({ length: 12 }, (_, i) => `file-${i}.txt`);
    const finding = preflight({ ...base, untrackedFiles: many }).warnings.find(
      (w) => w.check === "untracked-files",
    );
    expect(finding?.message).toContain("file-0.txt");
    expect(finding?.message).not.toContain("file-11.txt");
    expect(finding?.message).toContain("7 more");
  });

  it("names every path when there are few enough to show", () => {
    const finding = preflight({ ...base, untrackedFiles: ["a.txt", "b.txt"] }).warnings.find(
      (w) => w.check === "untracked-files",
    );
    expect(finding?.message).toContain("a.txt");
    expect(finding?.message).toContain("b.txt");
    expect(finding?.message).not.toContain("more");
  });
});

describe("preflight comment-lines", () => {
  const indented = (text: string) => ({ path: "Views/Card.swift", text });

  it("asks about an explanatory comment written inside the code", () => {
    const result = preflight({
      ...base,
      addedLines: [indented("        // The link's own inset leaves a target shorter than a finger.")],
    });
    const finding = result.warnings.find((w) => w.check === "comment-lines");
    expect(finding?.message).toContain("1 explanatory comment line");
    expect(finding?.message).toContain("Views/Card.swift");
  });

  it("stays silent for a licence header, which is never indented", () => {
    const result = preflight({
      ...base,
      addedLines: [
        { path: "Views/Card.swift", text: "//" },
        { path: "Views/Card.swift", text: "//  Card.swift" },
        { path: "Views/Card.swift", text: "//  Copyright © 2026 Example Inc. All rights reserved." },
      ],
    });
    expect(ids(result)).not.toContain("comment-lines");
  });

  it("asks about a doc comment, indented or not", () => {
    const nested = preflight({
      ...base,
      addedLines: [indented("    /// Selection is carried by the border alone.")],
    });
    expect(ids(nested)).toContain("comment-lines");

    // A licence header is `//`, never `///`, so a doc comment at column zero is
    // documentation on a top-level declaration rather than boilerplate.
    const topLevel = preflight({
      ...base,
      addedLines: [{ path: "Views/Card.swift", text: "/// Confirmation shown once a payment completes." }],
    });
    expect(ids(topLevel)).toContain("comment-lines");
  });

  it("stays silent for pragmas spelled as comments", () => {
    const result = preflight({
      ...base,
      addedLines: [
        indented("    // MARK: - Border"),
        indented("    // swiftlint:disable:next force_cast"),
      ],
    });
    expect(ids(result)).not.toContain("comment-lines");
  });

  it("stays silent for added code that merely contains a slash", () => {
    const result = preflight({
      ...base,
      addedLines: [indented('        Text("Kredi / Banka Kartı ile Öde")')],
    });
    expect(ids(result)).not.toContain("comment-lines");
  });

  it("caps the listing and says how many were left out", () => {
    const result = preflight({
      ...base,
      addedLines: Array.from({ length: 5 }, (_, i) => indented(`    // note ${i}`)),
    });
    const finding = result.warnings.find((w) => w.check === "comment-lines");
    expect(finding?.message).toContain("5 explanatory comment line");
    expect(finding?.message).toContain("and 2 more");
  });
});
