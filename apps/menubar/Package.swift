// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ShipkitMenuBar",
    platforms: [.macOS(.v14)],
    targets: [
        // The library holds everything worth testing. The executable is a thin
        // SwiftUI shell over it, because a MenuBarExtra cannot be unit tested.
        .target(name: "ShipkitKit"),
        .executableTarget(name: "ShipkitMenuBar", dependencies: ["ShipkitKit"]),
        .testTarget(name: "ShipkitKitTests", dependencies: ["ShipkitKit"]),
    ]
)
