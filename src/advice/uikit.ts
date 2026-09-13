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
 * real conversion sooner than invent one: a lone marker, a still-partly-UIKit file, a file
 * that gained no SwiftUI marker it did not already have, or a brand-new SwiftUI file with
 * nothing UIKit deleted beside it all say nothing.
 */

import type { Advice } from "./types.js";

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
/** True when at least one marker is in `after` and was not in `before` — gained, per marker. */
const gainsAny = (before: string, after: string, markers: string[]): boolean =>
  markers.some((marker) => after.includes(marker) && !before.includes(marker));
const isSwiftFile = (path: string): boolean => path.endsWith(".swift");
const isInterfaceFile = (path: string): boolean => INTERFACE_EXTENSIONS.some((ext) => path.endsWith(ext));

/**
 * True for a `.swift` file whose text lost every UIKit marker it had and gained a
 * SwiftUI one. Both sides matter: a file that merely adds SwiftUI while keeping its
 * `UIViewController` superclass hasn't converted, one that never had a UIKit marker
 * wasn't converted either — it was just written in SwiftUI to begin with — and one that
 * already had a SwiftUI marker before the change did not gain one.
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
  // Gained, not merely present. Without this a file that already held a SwiftUI view
  // alongside the dead controller it replaced reads as a conversion the moment the
  // controller is deleted — the ordinary shape of a partly-migrated app, and not a
  // conversion at all: the SwiftUI was already there.
  //
  // Gained *per marker*, though, not "the before side held none of them". The stricter
  // form silenced every UIKit file carrying an Xcode canvas preview, because
  // `PreviewProvider` requires `static var previews: some View` — so a view controller
  // with a preview block has `some View` in its before text, and rewriting it wholesale
  // into a SwiftUI view said nothing. Per marker, that rewrite still gains `var body:`
  // and `@State`, while the file that only lost its dead controller gains nothing and
  // stays silent, which is the case the check was added for.
  //
  // What this does not fix, and accepts: a rewrite that gains no *new kind* of marker is
  // silent under either form. A file already holding `var body:` and `some View` that is
  // rewritten into a different SwiftUI view using only those two markers reads as no
  // change at all here. That is a missed conversion, which is the direction this module
  // prefers to fail in.
  if (!gainsAny(file.before, file.after, SWIFTUI_MARKERS)) return false;
  return !file.after.includes("UIHostingController");
}

/** True for a brand-new `.swift` file written in SwiftUI. On its own this proves nothing
 * — a new screen can simply be written in SwiftUI without anything having been converted
 * — so it only ever corroborates deleted UIKit beside it, never opens a conversion by
 * itself.
 *
 * Still-UIKit text disqualifies it exactly as it does a modified file. This matters
 * because `readPushChangedFiles` runs with `--no-renames`, so a *moved* file arrives as a
 * deletion plus an addition: sweeping a controller and its `.xib` into another folder
 * presents deleted UIKit, a deleted interface file and an added `.swift`, which is the
 * shape of a conversion in every respect except that the added text is the same UIKit it
 * always was. A canvas preview is what makes that reachable — `PreviewProvider` puts
 * `some View` into a file that is otherwise pure UIKit. */
function isAddedSwiftUI(file: ChangedFile): boolean {
  if (file.status !== "added" || !isSwiftFile(file.path)) return false;
  if (hasAny(file.after, UIKIT_MARKERS)) return false;
  if (!hasAny(file.after, SWIFTUI_MARKERS)) return false;
  return !file.after.includes("UIHostingController");
}

/** The file name without its directory or its extension: `Trip/Summary.xib` -> `Summary`. */
function stem(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? base : base.slice(0, dot);
}

/**
 * Whether a Swift file and a deleted interface file are plausibly the two halves of one
 * screen, decided on their file names alone.
 *
 * **The rule:** the two stems are equal ignoring case, or one is a prefix of the other and
 * the remainder begins with an upper-case letter. So `Summary.xib` corresponds to
 * `Summary.swift`, `SummaryView.swift` and `SummaryViewController.swift`, and
 * `Main.storyboard` to `MainTabBarView.swift`. It does not correspond to
 * `PromoBanner.swift`. The upper-case remainder is what keeps the prefix honest: it is a
 * PascalCase word boundary, so `A.xib` does not claim `Anything.swift`.
 *
 * Why a name and not the text: the interface file's XML names the class it belongs to, but
 * a *deleted* one is being read for what it used to say, and matching a class name out of
 * a serialised nib is a parse this module has no business attempting for a signal. The name
 * is what Xcode itself couples — a `.xib` and its controller are conventionally named
 * together, and that convention is the evidence.
 *
 * Why any relationship is required at all: without one, "some SwiftUI file was added" and
 * "some interface file was deleted" corroborate each other from opposite ends of the
 * repository. The commonest instance is deleting `LaunchScreen.storyboard` — routine when
 * adopting the SwiftUI app lifecycle — in a pull request that also happens to add a SwiftUI
 * view. That reported a conversion of a brand-new file, which converts nothing.
 *
 * The rule errs the way the rest of this module errs. A screen whose SwiftUI rewrite was
 * given an unrelated name is missed, and being missed is the failure this feature prefers.
 */
function corresponds(swiftPath: string, interfacePath: string): boolean {
  const swift = stem(swiftPath);
  const interface_ = stem(interfacePath);
  if (swift.toLowerCase() === interface_.toLowerCase()) return true;
  const [longer, shorter] = swift.length > interface_.length ? [swift, interface_] : [interface_, swift];
  if (shorter.length === 0) return false;
  if (!longer.toLowerCase().startsWith(shorter.toLowerCase())) return false;
  return /^[A-Z]/.test(longer.slice(shorter.length));
}

/**
 * Returns the conversion signal for one change, or `undefined` when there isn't one.
 *
 * A converted file (see `isConverted`) is sufficient on its own. A deleted `.xib` or
 * `.storyboard` is not: interface files get deleted for reasons that have nothing to do
 * with SwiftUI, so it counts only alongside a converted or newly-added Swift file that
 * `corresponds` to it by name — the screen it used to describe, not merely some other
 * screen in the same pull request.
 *
 * An added SwiftUI file that corroborates nothing is left out of `files` entirely rather
 * than counted. It is not evidence of a conversion on its own, and counting it made the
 * message name a number of "converted" files that included brand-new ones.
 *
 * **The delete-and-replace shape.** The name correspondence above reads only files that
 * survive the change, so a conversion whose old controller was *deleted* rather than
 * modified was invisible: `git rm TripSummaryViewController.{swift,xib}` plus a new
 * `TripSummaryScreen.swift` said nothing, and neither did deleting `Main.storyboard`
 * beside two new SwiftUI screens — a large, common, unambiguous conversion.
 *
 * What admits it without reopening the `LaunchScreen.storyboard` false positive is the
 * deleted controller itself: the change must delete at least one `.swift` that carried a
 * UIKit marker. That is exactly what separates the two storyboard cases — tearing out
 * `Main.storyboard` comes with deleting the view controllers it instantiated, while
 * adopting the SwiftUI app lifecycle deletes `LaunchScreen.storyboard` and no Swift at all.
 *
 * On this path the pairing is not by name, and it cannot be: `Main.storyboard`
 * corresponds to nothing, and `TripSummaryScreen.swift` answers to no deleted name
 * either. The three facts together — a UIKit `.swift` deleted, an interface file deleted,
 * a SwiftUI file added — are the evidence. The cost is real and accepted: a change that
 * removes a dead UIKit screen with its `.xib` while separately adding an unrelated
 * SwiftUI file reads as a conversion. That is one sentence of wrong advice about a change
 * that did delete a UIKit screen, against silence on the commonest storyboard migration
 * there is.
 *
 * **The count.** `files` holds the added SwiftUI files, not the deleted controllers. The
 * message reads "converts UIKit to SwiftUI in N files", and a deleted controller is not a
 * file that is now SwiftUI — it is gone. So the delete-and-replace shape above counts 1
 * (`TripSummaryScreen.swift`) and the storyboard one counts 2 (`HomeView.swift` and
 * `SettingsView.swift`), while the deleted `.swift` files show up nowhere but the
 * diffstat.
 *
 * Still missed, deliberately: a deleted controller replaced by a new SwiftUI file with no
 * interface file anywhere in the change. Programmatic UIKit leaves no `.xib` behind, so
 * the only remaining evidence would be "a Swift file was deleted and another added",
 * which is every refactor.
 */
export function detectConversion(files: ChangedFile[]): Conversion | undefined {
  const converted = files.filter(isConverted);
  const addedSwiftUI = files.filter(isAddedSwiftUI);
  const deleted = files.filter((file) => file.status === "deleted" && isInterfaceFile(file.path));
  const deletedControllers = files.filter(
    (file) => file.status === "deleted" && isSwiftFile(file.path) && hasAny(file.before, UIKIT_MARKERS),
  );

  const deleteAndReplace =
    deletedControllers.length > 0 && deleted.length > 0 && addedSwiftUI.length > 0;

  const swiftSide = [...converted, ...addedSwiftUI];
  const deletedInterfaceFiles = deleteAndReplace
    ? deleted
    : deleted.filter((interfaceFile) => swiftSide.some((swift) => corresponds(swift.path, interfaceFile.path)));
  const corroborating = deleteAndReplace
    ? addedSwiftUI
    : addedSwiftUI.filter((swift) =>
        deletedInterfaceFiles.some((interfaceFile) => corresponds(swift.path, interfaceFile.path)),
      );

  const hasSignal = converted.length > 0 || corroborating.length > 0;
  if (!hasSignal) return undefined;

  return {
    files: [...new Set([...converted, ...corroborating].map((file) => file.path))],
    deletedInterfaceFiles: deletedInterfaceFiles.map((file) => file.path),
  };
}

/** "1 file" / "3 files" — the only prose this module has to get right. */
const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * The observation, worded for whoever reads it next.
 *
 * Every clause is hedged on purpose. `detectConversion` returns a signal, and whether the
 * conversion was in scope depends on the ticket, which is not in the diff — so this says
 * "if the ticket did not ask for it" rather than asserting that it didn't, and it names a
 * command to run rather than running one. The `Advice` type is what keeps that promise
 * structurally: it cannot reach `shouldRequestApproval`, so nothing here can gate a push.
 *
 * The count of files, not the list. A conversion sweeping thirty files would bury the
 * sentence that matters under thirty paths, and the paths are already in the diffstat.
 */
export function conversionAdvice(
  conversion: Conversion,
  context: { ticketKey?: string; epic?: string } = {},
): Advice {
  const deleted =
    conversion.deletedInterfaceFiles.length === 0
      ? ""
      : `, and deletes ${plural(conversion.deletedInterfaceFiles.length, "interface file")}`;
  const ticket = context.ticketKey ?? "the ticket";
  const epic = context.epic === undefined ? "" : ` under ${context.epic}`;

  return {
    topic: "uikit-to-swiftui",
    message: [
      `This change converts UIKit to SwiftUI in ${plural(conversion.files.length, "file")}${deleted}.`,
      `If ${ticket} did not ask for that, work like this gets its own technical item${epic} —`,
      "half of the existing ones were never attached to their epic.",
      "",
      '  shipkit tech-task --subject "<what was converted>"',
      "",
      "Nothing is created until you run it. shipkit cannot tell whether this was in scope;",
      "you hold the ticket, so the reading is yours.",
    ].join("\n"),
  };
}
