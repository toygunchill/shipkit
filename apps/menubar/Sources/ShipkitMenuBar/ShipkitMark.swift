import SwiftUI

/// The shipkit mark: a branch leaving a trunk, a commit at its head, and a gate
/// standing in front of it.
///
/// Drawn rather than shipped as an image. A menu-bar icon has to be crisp at
/// whatever height the bar happens to be — 16pt, more on a taller bar, doubled
/// again on Retina — and drawing gives that for free. It also inherits the
/// foreground style, which is the whole job of a template image, so there is no
/// asset catalog and no render step to keep in sync with the artwork.
///
/// A composed view rather than a single `Shape`: the mark mixes stroked lines
/// with filled solids, and flattening a stroke outline into the same path as a
/// fill made the commit dot punch a hole where the two overlapped — the two
/// subpaths wind in opposite directions and nonzero fill cancels them.
///
/// Geometry is authored in the 16×16 space the mark was designed in and scaled
/// to whatever frame it is given. `design/icon/b3d-branch-gate.svg` is the same
/// drawing and remains the reference for anything that needs a file.
struct ShipkitMark: View {
    /// Whether an approval is waiting. The gate shortens and a dot appears above
    /// it, so the silhouette changes rather than only gaining a speck — at 16pt a
    /// speck is not a state anyone notices, and a menu-bar icon tinted by the
    /// system cannot signal one with colour.
    var isPending: Bool = false

    var body: some View {
        GeometryReader { proxy in
            let unit = min(proxy.size.width, proxy.size.height) / 16
            let originX = proxy.size.width / 2 - unit * 8
            let originY = proxy.size.height / 2 - unit * 8

            let at: (CGFloat, CGFloat) -> CGPoint = { x, y in
                CGPoint(x: originX + x * unit, y: originY + y * unit)
            }

            let gateTop: CGFloat = isPending ? 5.4 : 2.3
            let gateHeight: CGFloat = isPending ? 8.3 : 11.4

            ZStack(alignment: .topLeading) {
                // The trunk, and the branch rising from it toward the gate.
                Path { path in
                    path.move(to: at(3, 2.8))
                    path.addLine(to: at(3, 13.2))
                    path.move(to: at(3, 10.4))
                    path.addCurve(
                        to: at(9.4, 5.6),
                        control1: at(4.4, 10.4),
                        control2: at(7.4, 5.6)
                    )
                }
                .stroke(style: StrokeStyle(lineWidth: 1.7 * unit, lineCap: .round))

                // The commit at the branch head.
                Circle()
                    .frame(width: 2.9 * unit, height: 2.9 * unit)
                    .offset(x: at(9.5, 5.6).x - 1.45 * unit, y: at(9.5, 5.6).y - 1.45 * unit)

                // The gate.
                RoundedRectangle(cornerRadius: 1.1 * unit)
                    .frame(width: 2.2 * unit, height: gateHeight * unit)
                    .offset(x: at(12.1, gateTop).x, y: at(12.1, gateTop).y)

                if isPending {
                    Circle()
                        .frame(width: 4 * unit, height: 4 * unit)
                        .offset(x: at(13.2, 2.5).x - 2 * unit, y: at(13.2, 2.5).y - 2 * unit)
                }
            }
        }
        .aspectRatio(1, contentMode: .fit)
    }
}

#Preview("Mark") {
    VStack(spacing: 24) {
        ForEach([false, true], id: \.self) { pending in
            HStack(alignment: .center, spacing: 20) {
                ForEach([CGFloat(16), 22, 32, 128], id: \.self) { size in
                    ShipkitMark(isPending: pending)
                        .frame(width: size, height: size)
                }
            }
        }
    }
    .padding(32)
}

extension ShipkitMark {
    /// The mark rasterised for the menu bar, because drawing it live there does
    /// not work: `MenuBarExtra` renders only `Text` and `Image` labels reliably,
    /// and a composed `Path` view comes up as an empty — but still clickable —
    /// stretch of menu bar. That was this project's one claim no human had
    /// verified, and it was false: the socket answered while the icon never drew.
    ///
    /// `isTemplate` is what makes the raster behave like the drawing meant to:
    /// the system tints the alpha mask for light and dark menu bars and dims it
    /// when the item is disabled, so the hue used to draw is irrelevant.
    ///
    /// Rendered at 2× and sized back down so Retina bars get real pixels.
    @MainActor
    static func statusImage(isPending: Bool) -> NSImage {
        let side: CGFloat = 18
        let renderer = ImageRenderer(
            content: ShipkitMark(isPending: isPending).frame(width: side, height: side),
        )
        renderer.scale = 2
        let image = renderer.nsImage ?? NSImage(size: NSSize(width: side, height: side))
        image.size = NSSize(width: side, height: side)
        image.isTemplate = true
        return image
    }
}
