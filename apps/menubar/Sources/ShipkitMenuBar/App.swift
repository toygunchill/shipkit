import SwiftUI
import ShipkitKit

@main
struct ShipkitMenuBarApp: App {
    @StateObject private var model: AppModel

    /// The model is built here, eagerly, and only handed to `@StateObject` —
    /// never created by its lazy default. `AppModel.init` is what starts the
    /// socket listener, and the default's autoclosure runs whenever SwiftUI
    /// first *evaluates a view that reads the model*. With the old drawn-view
    /// label that happened at launch; the rasterised `Image` label is lazier,
    /// and the listener silently did not exist until the first click on the
    /// icon — every push before that click was refused with `no-surface`.
    /// Measured both ways with `lsof` and the real Node client, no clicks
    /// anywhere: lazy default → zero sockets at 25s; this → bound at launch.
    init() {
        let started = AppModel()
        _model = StateObject(wrappedValue: started)
    }

    var body: some Scene {
        MenuBarExtra {
            if let pending = model.pending {
                ApprovalPanel(
                    request: pending.request,
                    queuedBehind: model.queuedBehind,
                    actionsEnabled: model.actionsEnabled
                ) { model.decide($0) }
            } else if let review = model.review {
                // Below an approval and above the inbox. An approval is a push
                // standing still until somebody says yes; a review is a person
                // reading, which can wait the few seconds that yes takes.
                ReviewPane(model: model, offer: review)
            } else {
                // Not the settings pane: a pending decision outranks
                // everything, and when there is none the panel's subject is
                // the pull requests waiting on this person — the Jira token is
                // a setting, reached from in there.
                InboxPane(model: model)
            }
        } label: {
            // The silhouette carries the state: a menu-bar icon is tinted by the
            // system and cannot signal with colour, and at 16pt a small addition
            // is not a state anyone notices.
            //
            // Rasterised, not drawn live: `MenuBarExtra` reliably renders only
            // `Text` and `Image` labels, and the composed-`Path` view this used
            // to be came up blank — see `ShipkitMark.statusImage`.
            Image(nsImage: ShipkitMark.statusImage(isPending: model.pending != nil || model.review != nil))
        }
        .menuBarExtraStyle(.window)
    }
}
