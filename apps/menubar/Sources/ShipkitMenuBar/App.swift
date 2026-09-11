import SwiftUI

// Task 6 replaces this with the real MenuBarExtra. Until then the executable
// exists so the package builds and the .app script has something to wrap.
@main
struct ShipkitMenuBarApp: App {
    var body: some Scene {
        MenuBarExtra {
            Text("shipkit")
        } label: {
            ShipkitMark()
                .frame(width: 18, height: 18)
        }
        .menuBarExtraStyle(.window)
    }
}
