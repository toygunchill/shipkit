import { describe, expect, it } from "vitest";
import { observedChangedFiles } from "../../src/advice/observe.js";
import type { ChangedFile } from "../../src/advice/uikit.js";
import { detectConversion } from "../../src/advice/uikit.js";
import { VcsError } from "../../src/vcs/git.js";

const CONVERTED: ChangedFile[] = [
  {
    path: "Scenes/SummaryViewController.swift",
    status: "modified",
    before: "import UIKit\nfinal class S: UIViewController { @IBOutlet var l: UILabel! }\n",
    after: 'import SwiftUI\nstruct S: View { @State var n = 0\n  var body: some View { Text("x") } }\n',
  },
];

describe("observedChangedFiles", () => {
  it("passes a successful read straight through", () => {
    expect(observedChangedFiles(() => CONVERTED)).toEqual(CONVERTED);
    expect(detectConversion(observedChangedFiles(() => CONVERTED))).toBeDefined();
  });

  // The shape a broken `.gitattributes` clean filter or an unreadable file produces:
  // `readPushChangedFiles` runs `git add --all` into a scratch index, and `git` exits
  // non-zero. Unguarded this reaches runSubmit's catch as `code: 2`.
  it("answers a VcsError with no observation rather than raising it", () => {
    expect(
      observedChangedFiles(() => {
        throw new VcsError("git add --all failed: fatal: asset.bin: clean filter 'lfs' failed");
      }),
    ).toEqual([]);
  });

  // `mkdtempSync` and `rmSync` in src/vcs/git.ts throw a plain Error, which is *not* one of
  // the typed errors runSubmit catches — it escapes to the user as a stack trace. Any
  // failure of an optional observation is the same thing, so the catch is total.
  it("answers a plain Error the typed catches would miss, too", () => {
    expect(
      observedChangedFiles(() => {
        throw new Error("ENOSPC: no space left on device, mkdtemp '/tmp/shipkit-index-XXXXXX'");
      }),
    ).toEqual([]);
  });

  it("answers a thrown non-Error the same way", () => {
    expect(
      observedChangedFiles(() => {
        throw "not an error object";
      }),
    ).toEqual([]);
  });

  // The empty array is not merely "no crash": it has to mean "nothing to advise" all the
  // way through, or a caller would still have to branch on it.
  it("yields no conversion, which is what makes it silent rather than wrong", () => {
    expect(
      detectConversion(
        observedChangedFiles(() => {
          throw new VcsError("nope");
        }),
      ),
    ).toBeUndefined();
  });
});
