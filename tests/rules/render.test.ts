import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadReadinessFiles } from "../../src/readiness/load.js";
import { propose } from "../../src/rules/propose.js";
import { renderRules } from "../../src/rules/render.js";
import { surveyRepository } from "../../src/rules/survey.js";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "shipkit-rules-")));
  tempDirs.push(dir);
  return dir;
}

/** A repository shaped enough to trip most of the catalogue. */
const FILES: Record<string, string> = {
  "Sources/Screen.swift":
    "import UIKit\nfinal class ScreenViewController: UIViewController {\n  @IBOutlet var label: UILabel!\n  func go() { Task { await load() } }\n  func a() { label.accessibilityIdentifier = \"x\" }\n}\n",
  "Sources/NewScreen.swift":
    "import SwiftUI\nstruct NewScreen: View {\n  @State private var n = 0\n  var body: some View { Text(\"x\") }\n}\n",
  "Sources/Design/Colors.swift": "enum Colors { static let primary = 1 }\n",
  "Tests/ScreenTests.swift": "import XCTest\n",
};

function rendered(): string {
  const survey = surveyRepository({
    trackedPaths: () => Object.keys(FILES),
    read: (path) => FILES[path],
  });
  return renderRules(propose(survey), survey.files.length, survey.capped);
}

describe("the file the command writes", () => {
  // The strongest assertion available: the thing this command produces has to be the thing
  // `--rules` can then load, or the loop it exists to close does not close.
  it("loads through the real readiness loader", () => {
    const dir = scratch();
    const path = join(dir, "derived.yml");
    writeFileSync(path, rendered(), "utf8");

    const rules = loadReadinessFiles([{ path, named: "the rendered file" }]);

    expect(rules.length).toBeGreaterThan(0);
    expect(rules.map((rule) => rule.id)).toContain("swiftui-direction");
  });

  // Nothing derived may gate a push before a person has read the file. `init` makes the same
  // choice for the same reason, defaulting approval to `echo`.
  it("makes every derived rule advise, which never gates and never changes an exit code", () => {
    const dir = scratch();
    const path = join(dir, "derived.yml");
    writeFileSync(path, rendered(), "utf8");

    for (const rule of loadReadinessFiles([{ path, named: "x" }])) {
      expect(rule.severity, `${rule.id} would gate`).toBe("advise");
    }
  });

  it("says above each rule what put it there", () => {
    const text = rendered();

    expect(text).toContain("# observed: UIKit in 1 file, SwiftUI in 1 file");
    expect(text).toContain("# observed: defined in Sources/Design/Colors.swift");
  });

  it("names what it left out, and why, so the file is not a mystery", () => {
    const text = rendered();

    expect(text).toContain("nothing in this repository to ask about");
    expect(text).toContain("localization");
  });

  it("says how much it read, so a count is never read as a count of the whole repository", () => {
    const text = rendered();

    expect(text).toContain("Read 4 source files");
  });

  // An `appliesTo` that came through as a string rather than a list would load as a glob
  // matching nothing, which is a rule that silently never applies.
  it("carries appliesTo through as a list", () => {
    const dir = scratch();
    const path = join(dir, "derived.yml");
    writeFileSync(path, rendered(), "utf8");

    const rule = loadReadinessFiles([{ path, named: "x" }]).find((entry) => entry.id === "swiftui-direction");

    expect(rule?.appliesTo).toEqual(["**/*.swift"]);
  });
});
