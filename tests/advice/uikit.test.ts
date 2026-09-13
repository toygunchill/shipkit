import { describe, expect, it } from "vitest";
import { detectConversion, type ChangedFile } from "../../src/advice/uikit.js";

const f = (over: Partial<ChangedFile>): ChangedFile => ({
  path: "A.swift", status: "modified", before: "", after: "", ...over,
});

describe("detectConversion", () => {
  it("sees a controller that became a SwiftUI view", () => {
    const got = detectConversion([
      f({ path: "Trip/SummaryVC.swift",
          before: "final class SummaryVC: UIViewController {\n  @IBOutlet var label: UILabel!\n}",
          after: "struct SummaryView: View {\n  @State private var trip: Trip?\n  var body: some View { Text(\"x\") }\n}" }),
    ]);
    expect(got?.files).toEqual(["Trip/SummaryVC.swift"]);
  });

  it("counts a deleted interface file as part of the same conversion", () => {
    const got = detectConversion([
      f({ path: "Trip/Summary.xib", status: "deleted", before: "<xml/>" }),
      f({ path: "Trip/SummaryView.swift", status: "added",
          after: "struct SummaryView: View { var body: some View { Text(\"x\") } }" }),
    ]);
    expect(got?.deletedInterfaceFiles).toEqual(["Trip/Summary.xib"]);
  });

  it("says nothing about a SwiftUI file that was always SwiftUI", () => {
    expect(detectConversion([
      f({ path: "New.swift", status: "added", after: "struct New: View { var body: some View { EmptyView() } }" }),
    ])).toBeUndefined();
  });

  it("says nothing when UIKit is merely still present", () => {
    expect(detectConversion([
      f({ before: "class A: UIViewController {}", after: "class A: UIViewController { func x() {} }" }),
    ])).toBeUndefined();
  });

  // Getting this fixture right took two tries, and the failure is instructive.
  // It must lose every UIKit marker, or the "still UIKit" rule excludes it first
  // and the hosting-controller check is never reached. The first attempt used
  // `UIViewControllerRepresentable`, which *contains* the substring
  // `UIViewController` — so it was excluded by the earlier rule and passed
  // whether or not this exclusion existed. Assert on the exclusion by removing
  // every other reason to exclude.
  it("says nothing when a UIHostingController is added, which is bridging, not converting", () => {
    expect(detectConversion([
      f({ before: "final class A: UIViewController { @IBOutlet var label: UILabel! }",
          after: "struct AView: View {\n"
               + "  @State private var shown = false\n"
               + "  var body: some View { EmptyView() }\n"
               + "}\n"
               + "let host = UIHostingController(rootView: AView())" }),
    ])).toBeUndefined();
  });

  it("ignores a non-Swift file that happens to contain the words", () => {
    expect(detectConversion([
      f({ path: "notes.md", before: "we use UIViewController", after: "we use some View now" }),
    ])).toBeUndefined();
  });

  // The rule: an added SwiftUI file corroborates a deleted interface file only when their
  // file-name stems correspond — equal ignoring case, or one a prefix of the other with the
  // remainder starting upper-case, which is the PascalCase word boundary Xcode's own naming
  // convention puts there. Without it, "some SwiftUI file was added" and "some interface
  // file was deleted" corroborate each other from opposite ends of the repository.
  describe("the deleted interface file must belong to the Swift file that corroborates it", () => {
    // Reproduced against the built code: `git rm Legacy/OldOnboarding.xib` plus an
    // unrelated new `Feature/PromoBanner.swift` reported "converts UIKit to SwiftUI in 1
    // file, and deletes 1 interface file" — and the file it counted was the brand-new one.
    it("says nothing about a deleted interface file and an unrelated new SwiftUI file", () => {
      expect(detectConversion([
        f({ path: "Legacy/OldOnboarding.xib", status: "deleted", before: "<xml/>" }),
        f({ path: "Feature/PromoBanner.swift", status: "added",
            after: "struct PromoBanner: View { var body: some View { Text(\"x\") } }" }),
      ])).toBeUndefined();
    });

    // The commonest instance by far: deleting LaunchScreen.storyboard is routine when
    // adopting the SwiftUI app lifecycle, and any pull request that also adds one SwiftUI
    // view used to be reported as a conversion.
    it("says nothing about LaunchScreen.storyboard beside an unrelated new view", () => {
      expect(detectConversion([
        f({ path: "Resources/LaunchScreen.storyboard", status: "deleted", before: "<xml/>" }),
        f({ path: "Feature/PromoBanner.swift", status: "added",
            after: "struct PromoBanner: View { var body: some View { Text(\"x\") } }" }),
      ])).toBeUndefined();
    });

    it("still pairs Summary.xib with SummaryViewController.swift, across directories", () => {
      const got = detectConversion([
        f({ path: "Legacy/Summary.xib", status: "deleted", before: "<xml/>" }),
        f({ path: "Feature/SummaryViewController.swift", status: "added",
            after: "struct SummaryView: View { var body: some View { Text(\"x\") } }" }),
      ]);
      expect(got?.deletedInterfaceFiles).toEqual(["Legacy/Summary.xib"]);
      expect(got?.files).toEqual(["Feature/SummaryViewController.swift"]);
    });

    // The prefix has to land on a word boundary, or a one-letter stem claims everything.
    it("does not let A.xib claim Anything.swift", () => {
      expect(detectConversion([
        f({ path: "A.xib", status: "deleted", before: "<xml/>" }),
        f({ path: "Anything.swift", status: "added",
            after: "struct Anything: View { var body: some View { Text(\"x\") } }" }),
      ])).toBeUndefined();
    });

    // A real conversion stands on its own, so the signal survives — but the unrelated
    // storyboard must not be counted into it, or the sentence names a file nothing
    // converted.
    it("keeps a real conversion but leaves an unrelated deleted storyboard out of the count", () => {
      const got = detectConversion([
        f({ path: "Trip/SummaryVC.swift",
            before: "final class SummaryVC: UIViewController { @IBOutlet var l: UILabel! }",
            after: "struct SummaryView: View { var body: some View { Text(\"x\") } }" }),
        f({ path: "Resources/LaunchScreen.storyboard", status: "deleted", before: "<xml/>" }),
      ]);
      expect(got?.files).toEqual(["Trip/SummaryVC.swift"]);
      expect(got?.deletedInterfaceFiles).toEqual([]);
    });

    // An added SwiftUI file that corroborates nothing is not a converted file, so it must
    // not swell the count the message prints.
    it("does not count an uncorroborated new SwiftUI file alongside a real conversion", () => {
      const got = detectConversion([
        f({ path: "Trip/SummaryVC.swift",
            before: "final class SummaryVC: UIViewController { @IBOutlet var l: UILabel! }",
            after: "struct SummaryView: View { var body: some View { Text(\"x\") } }" }),
        f({ path: "Feature/PromoBanner.swift", status: "added",
            after: "struct PromoBanner: View { var body: some View { Text(\"x\") } }" }),
      ]);
      expect(got?.files).toEqual(["Trip/SummaryVC.swift"]);
    });
  });

  // Gained, not merely present. The docstring said "gained" from the start; the code only
  // checked that the after-text has a SwiftUI marker.
  describe("a SwiftUI marker has to be gained, not merely be there", () => {
    // The ordinary shape in a partly-migrated app: one file holding the live SwiftUI view
    // and the dead controller it replaced. Deleting the dead controller read as a
    // conversion, and nothing was converted — the SwiftUI was already there.
    it("says nothing when the file already held SwiftUI and only lost its dead controller", () => {
      expect(detectConversion([
        f({ path: "Trip/Summary.swift",
            before: "struct SummaryView: View {\n  var body: some View { Text(\"x\") }\n}\n"
                  + "final class SummaryViewController: UIViewController { @IBOutlet var l: UILabel! }\n",
            after: "struct SummaryView: View {\n  var body: some View { Text(\"x\") }\n}\n" }),
      ])).toBeUndefined();
    });

    it("still sees the file that had no SwiftUI in it before", () => {
      const got = detectConversion([
        f({ path: "Trip/Summary.swift",
            before: "final class SummaryViewController: UIViewController { @IBOutlet var l: UILabel! }\n",
            after: "struct SummaryView: View {\n  var body: some View { Text(\"x\") }\n}\n" }),
      ]);
      expect(got?.files).toEqual(["Trip/Summary.swift"]);
    });
  });
});
