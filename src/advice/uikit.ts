/**
 * Notices a screen moving from UIKit to SwiftUI, from the changed files alone.
 *
 * This is a signal, never a conclusion: whether the conversion was in scope depends on
 * what the ticket asked for, and that isn't in the diff. The agent holds the ticket and
 * the diff, so the agent judges; this module only supplies the observation.
 *
 * Conservatism is the property that matters most here, more than in most of this
 * codebase. Unlike a warning, advice has no gate to make it matter — nobody re-reads it
 * once it stops being trustworthy. `issue-unverified` fired on every run until that was
 * fixed, and `init` had to ban `N/A` after it recurred; the lesson both times was that a
 * check nobody can trust is worse than no check. So every rule below is written to miss a
 * real conversion sooner than invent one: a lone marker, a still-partly-UIKit file, or a
 * brand-new SwiftUI file with no deleted interface file next to it all say nothing.
 */

export type ChangedFile = {
  path: string;
  status: "added" | "modified" | "deleted";
  before: string;
  after: string;
};

export type Conversion = {
  files: string[];
  deletedInterfaceFiles: string[];
};

// Substring checks on the raw text, not a Swift parse: cheap, and precise enough for a
// signal that the agent is going to weigh against the ticket anyway. Each marker is
// checked for literal presence, so `UIView` also matches inside `UIViewController` —
// harmless here, since a file that still has the more specific name still has the marker.
const UIKIT_MARKERS = ["UIViewController", "UIView", "@IBOutlet", "@IBAction"];
const SWIFTUI_MARKERS = ["var body:", "some View", "@State", "@ObservedObject"];
const INTERFACE_EXTENSIONS = [".xib", ".storyboard"];

const hasAny = (text: string, markers: string[]): boolean => markers.some((marker) => text.includes(marker));
const isSwiftFile = (path: string): boolean => path.endsWith(".swift");
const isInterfaceFile = (path: string): boolean => INTERFACE_EXTENSIONS.some((ext) => path.endsWith(ext));

/**
 * True for a `.swift` file whose text lost every UIKit marker it had and gained a
 * SwiftUI one. Both sides matter: a file that merely adds SwiftUI while keeping its
 * `UIViewController` superclass hasn't converted, and one that never had a UIKit marker
 * wasn't converted either — it was just written in SwiftUI to begin with.
 *
 * `UIHostingController` in the after-text disqualifies a file on its own terms — it is
 * the ordinary way a UIKit screen hosts a SwiftUI subtree, present in every
 * partially-migrated app, and not a conversion. In practice a file that still hosts a
 * `UIHostingController` also still declares `UIViewController`, so this check is often
 * redundant with the "lost every UIKit marker" test above; it is kept anyway as the
 * rule that would matter for a bridging file whose superclass line changed shape while
 * a hosting reference remained.
 */
function isConverted(file: ChangedFile): boolean {
  if (!isSwiftFile(file.path)) return false;
  if (!hasAny(file.before, UIKIT_MARKERS)) return false;
  if (hasAny(file.after, UIKIT_MARKERS)) return false;
  if (!hasAny(file.after, SWIFTUI_MARKERS)) return false;
  return !file.after.includes("UIHostingController");
}

/** True for a brand-new `.swift` file written in SwiftUI. On its own this proves nothing
 * — a new screen can simply be written in SwiftUI without anything having been converted
 * — so it only ever corroborates a deleted interface file in the same change, never
 * opens a conversion by itself. */
function isAddedSwiftUI(file: ChangedFile): boolean {
  if (file.status !== "added" || !isSwiftFile(file.path)) return false;
  if (!hasAny(file.after, SWIFTUI_MARKERS)) return false;
  return !file.after.includes("UIHostingController");
}

/**
 * Returns the conversion signal for one change, or `undefined` when there isn't one.
 *
 * A converted file (see `isConverted`) is sufficient on its own. A deleted `.xib` or
 * `.storyboard` is not: interface files get deleted for reasons that have nothing to do
 * with SwiftUI, so it counts only alongside a converted file, or a newly added SwiftUI
 * file standing in for the screen the interface file used to describe.
 */
export function detectConversion(files: ChangedFile[]): Conversion | undefined {
  const converted = files.filter(isConverted);
  const addedSwiftUI = files.filter(isAddedSwiftUI);
  const deletedInterfaceFiles = files.filter((file) => file.status === "deleted" && isInterfaceFile(file.path));

  const hasSignal = converted.length > 0 || (addedSwiftUI.length > 0 && deletedInterfaceFiles.length > 0);
  if (!hasSignal) return undefined;

  return {
    files: [...new Set([...converted, ...addedSwiftUI].map((file) => file.path))],
    deletedInterfaceFiles: deletedInterfaceFiles.map((file) => file.path),
  };
}
