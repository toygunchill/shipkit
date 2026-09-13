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

    // Reproduced by running: under the earlier form of this rule — "the before side holds
    // no SwiftUI marker at all" — every UIKit file carrying an Xcode canvas preview was
    // silent. `PreviewProvider`'s signature is fixed at `static var previews: some View`,
    // so the before text of any previewed view controller contains `some View`. Per
    // marker, the rewrite still gains `var body:` and `@State`.
    it("still sees a controller whose only SwiftUI was a PreviewProvider block", () => {
      const got = detectConversion([
        f({ path: "Trip/TripSummaryViewController.swift",
            before: "final class TripSummaryViewController: UIViewController {\n"
                  + "  @IBOutlet var titleLabel: UILabel!\n"
                  + "}\n"
                  + "#if DEBUG\n"
                  + "struct TripSummaryPreviews: PreviewProvider {\n"
                  + "  static var previews: some View { TripSummaryRepresentable() }\n"
                  + "}\n"
                  + "#endif\n",
            after: "struct TripSummaryView: View {\n"
                 + "  @State private var trip: Trip?\n"
                 + "  var body: some View { Text(\"x\") }\n"
                 + "}\n" }),
      ]);
      expect(got?.files).toEqual(["Trip/TripSummaryViewController.swift"]);
    });

    // The Xcode 15 macro carries none of the four markers, so it was never caught by the
    // stricter form. Pinned so the per-marker rewrite does not lose the shape that worked.
    it("still sees a rewrite whose preview is the #Preview macro", () => {
      const got = detectConversion([
        f({ path: "Home/HomeViewController.swift",
            before: "final class HomeViewController: UIViewController { @IBOutlet var l: UILabel! }\n"
                  + "#Preview { HomeViewController() }\n",
            after: "struct HomeView: View {\n"
                 + "  @State private var loaded = false\n"
                 + "  var body: some View { Text(\"home\") }\n"
                 + "}\n"
                 + "#Preview { HomeView() }\n" }),
      ]);
      expect(got?.files).toEqual(["Home/HomeViewController.swift"]);
    });
  });

  // Deleted `.swift` files were never read, so the Swift half of the name pairing could
  // only ever be a file that survived the change. A conversion that deletes its old
  // controller outright — the ordinary way a storyboard screen is replaced — was silent.
  // The anchor that admits it is the deleted controller itself: a `.swift` deleted with a
  // UIKit marker in it. That is what `Main.storyboard` has beside it and
  // `LaunchScreen.storyboard` does not.
  describe("a conversion whose old controller was deleted rather than modified", () => {
    it("sees a deleted controller and its xib replaced by a new SwiftUI screen", () => {
      const got = detectConversion([
        f({ path: "Trip/TripSummaryViewController.swift", status: "deleted",
            before: "final class TripSummaryViewController: UIViewController { @IBOutlet var l: UILabel! }" }),
        f({ path: "Trip/TripSummaryViewController.xib", status: "deleted", before: "<xml/>" }),
        f({ path: "Trip/TripSummaryScreen.swift", status: "added",
            after: "struct TripSummaryScreen: View { var body: some View { Text(\"x\") } }" }),
      ]);
      // One file, not two: the deleted controller is not a file that is now SwiftUI.
      expect(got?.files).toEqual(["Trip/TripSummaryScreen.swift"]);
      expect(got?.deletedInterfaceFiles).toEqual(["Trip/TripSummaryViewController.xib"]);
    });

    it("sees Main.storyboard torn out with its controllers and replaced by SwiftUI screens", () => {
      const got = detectConversion([
        f({ path: "App/Main.storyboard", status: "deleted", before: "<xml/>" }),
        f({ path: "Home/HomeViewController.swift", status: "deleted",
            before: "final class HomeViewController: UIViewController { @IBOutlet var l: UILabel! }" }),
        f({ path: "Settings/SettingsViewController.swift", status: "deleted",
            before: "final class SettingsViewController: UIViewController {}" }),
        f({ path: "Home/HomeView.swift", status: "added",
            after: "struct HomeView: View { var body: some View { Text(\"h\") } }" }),
        f({ path: "Settings/SettingsView.swift", status: "added",
            after: "struct SettingsView: View { var body: some View { Text(\"s\") } }" }),
      ]);
      // `Main.storyboard` corresponds to neither name, which is why the pairing on this
      // path is the deleted controllers rather than the file names.
      expect(got?.files).toEqual(["Home/HomeView.swift", "Settings/SettingsView.swift"]);
      expect(got?.deletedInterfaceFiles).toEqual(["App/Main.storyboard"]);
    });

    // The anchor has to be a *UIKit* Swift file, or the LaunchScreen false positive comes
    // straight back through any pull request that also deletes some unrelated helper.
    it("says nothing when the deleted Swift file carries no UIKit marker", () => {
      expect(detectConversion([
        f({ path: "Resources/LaunchScreen.storyboard", status: "deleted", before: "<xml/>" }),
        f({ path: "Support/DateFormatting.swift", status: "deleted",
            before: "enum DateFormatting { static let iso = ISO8601DateFormatter() }" }),
        f({ path: "Feature/PromoBanner.swift", status: "added",
            after: "struct PromoBanner: View { var body: some View { Text(\"x\") } }" }),
      ])).toBeUndefined();
    });

    // `readPushChangedFiles` runs with `--no-renames`, so moving a screen into another
    // folder arrives here as a deletion plus an addition — deleted UIKit, a deleted
    // interface file, and an added `.swift` whose `PreviewProvider` block contains
    // `some View`. Nothing was converted; the same UIKit landed in a new directory.
    it("says nothing when a UIKit screen is merely moved to another folder", () => {
      const uikit = "final class SummaryViewController: UIViewController {\n"
                  + "  @IBOutlet var l: UILabel!\n"
                  + "}\n"
                  + "struct SummaryPreviews: PreviewProvider {\n"
                  + "  static var previews: some View { SummaryRepresentable() }\n"
                  + "}\n";
      expect(detectConversion([
        f({ path: "Trip/SummaryViewController.swift", status: "deleted", before: uikit }),
        f({ path: "Trip/Summary.xib", status: "deleted", before: "<xml/>" }),
        f({ path: "Features/Trip/SummaryViewController.swift", status: "added", after: uikit }),
        f({ path: "Features/Trip/Summary.xib", status: "added", after: "<xml/>" }),
      ])).toBeUndefined();
    });

    // Deleting a UIKit screen is not converting it. Something has to have been written in
    // SwiftUI, or there is no conversion to count and nothing to name.
    it("says nothing when a UIKit screen is deleted and nothing SwiftUI is added", () => {
      expect(detectConversion([
        f({ path: "Trip/TripSummaryViewController.swift", status: "deleted",
            before: "final class TripSummaryViewController: UIViewController { @IBOutlet var l: UILabel! }" }),
        f({ path: "Trip/TripSummaryViewController.xib", status: "deleted", before: "<xml/>" }),
      ])).toBeUndefined();
    });
  });
});
