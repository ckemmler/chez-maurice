import SwiftUI

/// Maurice's logomark — the bowler-hat brandmark (asset `maurice-logomark`,
/// a template silhouette so it tints to any colour for light/dark + accents).
/// Kept under the `BoaterHat` name and `(size:color:ribbonColor:)` signature so
/// every brand-hat site (wordmark, splash, chat avatar, send button) renders it
/// without changes. `ribbonColor` is retained for source compatibility; the
/// silhouette's band is a transparent gap that simply shows the surface behind it.
struct BoaterHat: View {
    var size: CGFloat = 18
    var color: Color = .primary
    var ribbonColor: Color? = nil

    var body: some View {
        Image("maurice-logomark")
            .renderingMode(.template)
            .interpolation(.high)
            .antialiased(true)
            .resizable()
            .scaledToFit()
            .foregroundStyle(color)
            // Same footprint box as the old drawn glyph (ar ≈ 1.35 ≈ the mark's
            // 1.363), so existing call-site sizes stay visually consistent.
            .frame(width: size * 1.15, height: size * 0.85)
    }
}
