import SwiftUI
import ShipkitKit

@main
struct ShipkitMenuBarApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        MenuBarExtra {
            if let pending = model.pending {
                ApprovalPanel(
                    request: pending.request,
                    queuedBehind: model.queuedBehind,
                    actionsEnabled: model.actionsEnabled
                ) { model.decide($0) }
            } else {
                SettingsPane(model: model)
            }
        } label: {
            // The silhouette carries the state: a menu-bar icon is tinted by the
            // system and cannot signal with colour, and at 16pt a small addition
            // is not a state anyone notices.
            ShipkitMark(isPending: model.pending != nil)
                .frame(width: 18, height: 18)
        }
        .menuBarExtraStyle(.window)
    }
}
