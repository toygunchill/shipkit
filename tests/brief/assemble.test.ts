import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import type { ChangedFile } from "../../src/advice/uikit.js";
import { assembleBrief } from "../../src/brief/assemble.js";
import type { FixRequest } from "../../src/review/fixrequest.js";

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

// The agent is the only party that can read this: judging whether a UIKit-to-SwiftUI
// conversion was in scope needs the ticket, and the agent is holding it. So it goes into the
// brief, which is what the agent reads before it writes anything.
describe("assembleBrief advice", () => {
  const CONVERTED: ChangedFile[] = [
    {
      path: "Scenes/SummaryViewController.swift",
      status: "modified",
      before: "import UIKit\nfinal class S: UIViewController { @IBOutlet var l: UILabel! }\n",
      after: 'import SwiftUI\nstruct S: View { @State var n = 0\n  var body: some View { Text("x") } }\n',
    },
  ];

  it("carries the conversion advice, naming the count and the command", () => {
    const brief = assembleBrief({ repo, target, config, changed: CONVERTED });

    expect(brief.advice?.map((item) => item.topic)).toEqual(["uikit-to-swiftui"]);
    expect(brief.advice?.[0]?.message).toContain("1 file");
    expect(brief.advice?.[0]?.message).toContain("shipkit tech-task --subject");
  });

  it("has no advice key at all when the change carries no conversion", () => {
    const unconverted: ChangedFile[] = [
      { path: "Scenes/Other.swift", status: "modified", before: "let a = 1\n", after: "let a = 2\n" },
    ];

    expect(assembleBrief({ repo, target, config, changed: unconverted }).advice).toBeUndefined();
  });

  // A caller that cannot read the files gets a brief with no advice, never a wrong
  // observation standing in for a missing one.
  it("says nothing when the caller supplied no files to look at", () => {
    expect(assembleBrief({ repo, target, config }).advice).toBeUndefined();
  });

  // The half of the measurement that justified building this: half the existing conversion
  // tickets were never attached to their epic. Naming it is the remedy for that, so the
  // configured epic has to reach the message.
  it("names the ticket and the configured epic when the repository has one", () => {
    const withEpic = {
      ...config,
      techTask: {
        project: "DCP",
        issueType: "Story",
        epic: "ABC-12154",
        summaryPattern: "iOS - {subject} swift ui dönüşümü",
      },
    };
    const issue = { key: "ABC-31087", type: "Story", summary: "Invoice" };

    const message =
      assembleBrief({ repo, target, config: withEpic, issue, changed: CONVERTED }).advice?.[0]
        ?.message ?? "";

    expect(message).toContain("ABC-31087");
    expect(message).toContain("ABC-12154");
  });

  it("falls back to naming no ticket rather than inventing one", () => {
    const message =
      assembleBrief({ repo, target, config, changed: CONVERTED }).advice?.[0]?.message ?? "";

    expect(message).toContain("the ticket");
    expect(message).not.toMatch(/DCP-\d+/);
  });

  // Advice is placed before the sections it would be advice about. Placed after them it
  // would be arriving about a body already written.
  it("puts the advice ahead of the template in the JSON the agent reads", () => {
    const brief = assembleBrief({ repo, target, config, changed: CONVERTED });
    const keys = Object.keys(brief);

    expect(keys.indexOf("advice")).toBeGreaterThan(-1);
    expect(keys.indexOf("advice")).toBeLessThan(keys.indexOf("template"));
  });
});

const SELECTION: FixRequest = {
  version: 1,
  createdAt: "2026-09-17T10:00:00.000Z",
  base: target.branch,
  branch: repo.branch,
  items: [{ kind: "warning", id: "untracked-files", message: "m", note: "delete the scratch file" }],
};

describe("a selection made somewhere other than here", () => {
  // The file is per-checkout, not per-branch: a person reviews one branch, gets pulled onto
  // another, and the selection is still lying there. `createdAt` cannot show that — a
  // timestamp says when, never against what — and the two names that could were recorded in
  // the file and then thrown away on the way into the brief.
  it("says which branch and base the person was actually looking at", () => {
    const brief = assembleBrief({ repo, target, config, fixRequest: SELECTION });

    expect(brief.fixRequest?.madeOn).toEqual({ branch: repo.branch, base: target.branch });
  });

  it("adds no note when the selection describes this very change", () => {
    const brief = assembleBrief({ repo, target, config, fixRequest: SELECTION });

    expect(brief.fixRequest?.note).toBeUndefined();
  });

  it("carries the items anyway when the branch has moved on, and names the discrepancy", () => {
    const brief = assembleBrief({
      repo,
      target,
      config,
      fixRequest: { ...SELECTION, branch: "bugfix/squadb/31087-invoice-first-attempt" },
    });

    expect(brief.fixRequest?.items).toEqual(SELECTION.items);
    expect(brief.fixRequest?.note).toContain("bugfix/squadb/31087-invoice-first-attempt");
    expect(brief.fixRequest?.note).toContain(repo.branch);
  });

  it("notices a base that has moved too, not only a branch", () => {
    const brief = assembleBrief({
      repo,
      target,
      config,
      fixRequest: { ...SELECTION, base: "release/3.75.0" },
    });

    expect(brief.fixRequest?.note).toContain("release/3.75.0");
    expect(brief.fixRequest?.note).toContain(target.branch);
  });

  // The instruction is what tells the agent these are a person's words and not shipkit's.
  // A mismatched selection is still a person's words, so it keeps it.
  it("keeps the instruction that says a person chose these", () => {
    const brief = assembleBrief({
      repo,
      target,
      config,
      fixRequest: { ...SELECTION, branch: "somewhere-else" },
    });

    expect(brief.fixRequest?.instruction).toContain("A person read this change");
  });
});
