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
});
