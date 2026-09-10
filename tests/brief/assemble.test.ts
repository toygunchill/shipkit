import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { assembleBrief } from "../../src/brief/assemble.js";

const config = loadConfig("tests/fixtures/valid.shipkit.yml");
const repo = {
  branch: "bugfix/squadb/31087-invoice-default-citizenship",
  changedFiles: ["Sources/Scenes/Payment/Invoice/PaymentAddInvoiceViewModel.swift"],
  diffstat: " 1 file changed, 17 insertions(+), 2 deletions(-)",
  commits: ["fix(invoice): default citizenship from passenger info"],
};
const target = { branch: "release/3.76.0", reason: "chosen by the caller" };

describe("assembleBrief", () => {
  it("carries the change through unchanged", () => {
    const brief = assembleBrief({ repo, target, config });
    expect(brief.change.files).toEqual(repo.changedFiles);
    expect(brief.change.commits).toEqual(repo.commits);
    expect(brief.change.branch).toBe(repo.branch);
  });

  it("states the target and why it was chosen", () => {
    const brief = assembleBrief({ repo, target, config });
    expect(brief.target).toEqual({ branch: "release/3.76.0", reason: "chosen by the caller" });
  });

  it("lists every configured section with its hint and requirements", () => {
    const brief = assembleBrief({ repo, target, config });
    expect(brief.template.sections.map((s) => s.name)).toEqual(
      config.pr.sections.map((s) => s.name),
    );
    const test = brief.template.sections.find((s) => s.name === "What to Test");
    expect(test?.minItems).toBe(3);
    expect(test?.required).toBe(true);
  });

  it("passes the rules the agent must obey", () => {
    const brief = assembleBrief({ repo, target, config });
    expect(brief.rules.titlePattern).toBe(config.pr.titlePattern);
    expect(brief.rules.branchPattern).toBe(config.branch.pattern);
    expect(brief.rules.keyPattern).toBe(config.jira.keyPattern);
    expect(brief.rules.forbidden).toEqual(config.pr.forbidden);
  });

  it("reports the ticket and the key the body must cite", () => {
    const issue = {
      key: "ABC-31454", type: "Development", summary: "Geliştirme",
      parent: { key: "ABC-31444", type: "Story", summary: "Brand Identity fields" },
    };
    const brief = assembleBrief({ repo, target, config, issue });
    expect(brief.ticket?.key).toBe("ABC-31454");
    expect(brief.ticket?.cite).toBe("ABC-31444");
  });

  it("cites the issue itself when it has no parent", () => {
    const issue = { key: "ABC-31789", type: "Story", summary: "removal" };
    const brief = assembleBrief({ repo, target, config, issue });
    expect(brief.ticket?.cite).toBe("ABC-31789");
  });

  it("cites a Bug even when it has a parent", () => {
    const issue = {
      key: "ABC-31086", type: "Bug", summary: "b",
      parent: { key: "ABC-31000", type: "Epic", summary: "e" },
    };
    const brief = assembleBrief({ repo, target, config, issue });
    expect(brief.ticket?.cite).toBe("ABC-31086");
  });

  it("omits the ticket when none was resolved", () => {
    expect(assembleBrief({ repo, target, config }).ticket).toBeUndefined();
  });
});
