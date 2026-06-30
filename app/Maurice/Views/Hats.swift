import SwiftUI

// MARK: - Hats
//
// The hat collection for specialized Maurices, ported from the design's
// `maurice-hats.jsx`. Each hat is a set of flat silhouette shapes on a shared
// 48×40 viewBox, drawn in `currentColor` with occasional translucent-white
// highlights. `HatGlyph` renders the silhouette; `HatBadge` sets it on a
// curated colored ground.

/// One primitive of a hat silhouette, in 48×40 viewBox coordinates.
struct HatShape {
    enum Geo {
        case path(String)
        case strokePath(String, CGFloat) // d, lineWidth
        case ellipse(CGFloat, CGFloat, CGFloat, CGFloat) // cx, cy, rx, ry
        case rect(CGFloat, CGFloat, CGFloat, CGFloat, CGFloat) // x, y, w, h, radius
        case circle(CGFloat, CGFloat, CGFloat) // cx, cy, r
    }
    let geo: Geo
    /// nil → fill in the ink color; a value → fill white at that opacity (a highlight).
    let highlight: Double?

    init(_ geo: Geo, highlight: Double? = nil) {
        self.geo = geo
        self.highlight = highlight
    }

    func makePath() -> Path {
        switch geo {
        case let .path(d), let .strokePath(d, _):
            return Self.parse(d)
        case let .ellipse(cx, cy, rx, ry):
            return Path(ellipseIn: CGRect(x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2))
        case let .rect(x, y, w, h, r):
            return Path(roundedRect: CGRect(x: x, y: y, width: w, height: h), cornerRadius: r)
        case let .circle(cx, cy, r):
            return Path(ellipseIn: CGRect(x: cx - r, y: cy - r, width: r * 2, height: r * 2))
        }
    }

    /// Minimal absolute-command SVG path parser (M, L, Q, C, Z) — enough for the
    /// hat data, which uses only absolute coordinates.
    static func parse(_ d: String) -> Path {
        var path = Path()
        var tokens: [String] = []
        var num = ""
        for ch in d {
            if ch.isLetter {
                if !num.isEmpty { tokens.append(num); num = "" }
                tokens.append(String(ch))
            } else if ch == " " || ch == "," || ch == "\n" || ch == "\t" {
                if !num.isEmpty { tokens.append(num); num = "" }
            } else {
                num.append(ch)
            }
        }
        if !num.isEmpty { tokens.append(num) }

        var i = 0
        func f() -> CGFloat { defer { i += 1 }; return i < tokens.count ? CGFloat(Double(tokens[i]) ?? 0) : 0 }
        while i < tokens.count {
            let cmd = tokens[i]; i += 1
            switch cmd {
            case "M": path.move(to: CGPoint(x: f(), y: f()))
            case "L": path.addLine(to: CGPoint(x: f(), y: f()))
            case "Q":
                let c = CGPoint(x: f(), y: f())
                path.addQuadCurve(to: CGPoint(x: f(), y: f()), control: c)
            case "C":
                let c1 = CGPoint(x: f(), y: f())
                let c2 = CGPoint(x: f(), y: f())
                path.addCurve(to: CGPoint(x: f(), y: f()), control1: c1, control2: c2)
            case "Z", "z": path.closeSubpath()
            default: break
            }
        }
        return path
    }
}

/// The ordered hat roster: (kind, label). Drives the picker grid. Computed (not
/// a stored `let`) so the localized labels re-resolve when the language changes.
var HAT_KINDS: [(String, String)] { [
    ("boater", L("hat.boater")), ("fedora", L("hat.fedora")), ("topHat", L("hat.tophat")), ("beret", L("hat.beret")),
    ("flatCap", L("hat.flatcap")), ("ballCap", L("hat.ballcap")), ("chef", L("hat.chef")), ("grad", L("hat.grad")),
    ("hardHat", L("hat.hardhat")), ("detective", L("hat.detective")), ("explorer", L("hat.explorer")),
    ("wizard", L("hat.wizard")), ("crown", L("hat.crown")), ("party", L("hat.party")), ("swim", L("hat.swim")), ("captain", L("hat.captain")),
] }

private let HAT_SHAPES: [String: [HatShape]] = [
    "boater": [
        .init(.ellipse(24, 30, 20, 3.3)),
        .init(.path("M15 30 L16 17 Q16 14.6 18.4 14.6 L29.6 14.6 Q32 14.6 32 17 L33 30 Z")),
        .init(.rect(15.4, 26, 17.2, 2.6, 0.4), highlight: 0.34),
    ],
    "topHat": [
        .init(.ellipse(24, 31.5, 17, 3)),
        .init(.path("M17.5 31.5 L15.8 9.5 Q15.8 8 17.4 8 L30.6 8 Q32.2 8 32.2 9.5 L30.5 31.5 Z")),
        .init(.rect(16.4, 26.5, 15.2, 2.8, 0.4), highlight: 0.32),
    ],
    "fedora": [
        .init(.path("M5 29.5 Q24 25.5 43 29.5 Q24 33.5 5 29.5 Z")),
        .init(.path("M15.5 29 C15 17 18.5 12.5 24 12.5 C27 12.5 29 14 30 16.5 C30.6 14.8 31.6 14 32.5 14.4 C33.6 19 33 25 32.6 29 Z")),
        .init(.rect(15.8, 25.5, 16.6, 2.6, 0.4), highlight: 0.30),
    ],
    "beret": [
        .init(.ellipse(23, 22, 16, 8.2)),
        .init(.path("M9 22 Q9 26 14 26.6 L33 26.6 Q38 26 38 22 Z")),
        .init(.circle(24, 13.4, 1.8)),
    ],
    "flatCap": [
        .init(.path("M10.5 27 Q11 16 24 16 Q34.5 16 35.5 25.2 L39 26.6 Q41 27.4 39 28.4 L13 28.4 Q10.5 28.4 10.5 27 Z")),
    ],
    "ballCap": [
        .init(.path("M12 25.5 Q12 14.5 24 14.5 Q35.5 14.5 35.5 25.5 Z")),
        .init(.path("M34.5 24.6 Q44 25.4 45.5 28 Q44 29.4 34 27.4 Z")),
        .init(.circle(24, 13.6, 1.3)),
        .init(.rect(11.6, 24, 24, 3, 1.4), highlight: 0.28),
    ],
    "chef": [
        .init(.rect(16, 25, 16, 7, 1.2)),
        .init(.path("M16.5 27 C12.5 27 12 19.5 17 19.2 C15.8 13.4 24 12 25.4 17.4 C28.5 12.6 35.5 15.8 32.2 20.4 C36.4 20.8 35 27.2 31.4 26.8 Z")),
    ],
    "grad": [
        .init(.path("M8 18 L24 12 L40 18 L24 24 Z")),
        .init(.path("M17 21 L17 25.5 Q17 28.4 24 28.4 Q31 28.4 31 25.5 L31 21 L24 23.6 Z")),
        .init(.circle(24, 18, 1.3)),
        .init(.strokePath("M24 18 Q36 19.4 36 24 L36 27", 1.1)),
        .init(.circle(36, 28, 1.7)),
    ],
    "hardHat": [
        .init(.path("M13 26 C13 15.5 17.5 13.2 24 13.2 C30.5 13.2 35 15.5 35 26 Z")),
        .init(.ellipse(24, 26.6, 17, 2.8)),
        .init(.rect(22.4, 13.6, 3.2, 12, 1.4), highlight: 0.28),
    ],
    "detective": [
        .init(.path("M14.5 25.5 Q14.5 14.8 24 14.8 Q33.5 14.8 33.5 25.5 Z")),
        .init(.path("M14.5 22.5 L6 24.8 Q4.2 25.5 6 26.4 L14.5 26.8 Z")),
        .init(.path("M33.5 22.5 L42 24.8 Q43.8 25.5 42 26.4 L33.5 26.8 Z")),
        .init(.ellipse(24, 25.6, 10, 2.4)),
        .init(.ellipse(24, 13.8, 2.6, 1.7)),
    ],
    "explorer": [
        .init(.path("M13.5 26 Q13.5 16 24 16 Q34.5 16 34.5 26 Z")),
        .init(.ellipse(24, 26.6, 19, 3.2)),
        .init(.circle(24, 15.2, 1.5)),
    ],
    "wizard": [
        .init(.path("M24 5.5 Q26 18 33.5 31 L14.5 31 Q21.5 18 24 5.5 Z")),
        .init(.ellipse(24, 31, 14, 2.6)),
    ],
    "crown": [
        .init(.path("M12 27 L13.6 16 L19 23 L24 13.5 L29 23 L34.4 16 L36 27 Z")),
        .init(.rect(12.4, 26, 23.2, 5.5, 1.2)),
        .init(.rect(15.6, 27.4, 16.8, 2.4, 1.2), highlight: 0.26),
    ],
    "party": [
        .init(.path("M24 7 L33 30.5 L15 30.5 Z")),
        .init(.circle(24, 6.6, 2.6)),
        .init(.path("M19.5 24.5 L28.5 24.5 L29.6 27.5 L18.4 27.5 Z"), highlight: 0.26),
    ],
    "swim": [
        .init(.path("M13 29.5 Q13 14 24 14 Q35 14 35 29.5 Q24 32.5 13 29.5 Z")),
        .init(.circle(30.5, 19, 1.6), highlight: 0.3),
    ],
    "captain": [
        .init(.path("M14 20.5 L14 16.4 Q14 14.4 16 14.4 L32 14.4 Q34 14.4 34 16.4 L34 20.5 Z")),
        .init(.path("M11 20.5 L37 20.5 Q39.4 20.5 39.4 22.6 Q39.4 24.6 36 24.6 L13 24.6 Q11 24.6 11 22.6 Z")),
        .init(.rect(14, 18, 20, 2.8, 0), highlight: 0.3),
    ],
]

/// A hat silhouette drawn in `color`, on the 48×40 baseline (rendered at `size`
/// wide, proportional height).
struct HatGlyph: View {
    var kind: String = "boater"
    var size: CGFloat = 28
    var color: Color = .primary

    var body: some View {
        let shapes = HAT_SHAPES[kind] ?? HAT_SHAPES["boater"]!
        Canvas { ctx, canvasSize in
            let k = canvasSize.width / 48.0
            ctx.scaleBy(x: k, y: k)
            for shape in shapes {
                let p = shape.makePath()
                if case let .strokePath(_, lw) = shape.geo {
                    ctx.stroke(p, with: .color(color), lineWidth: lw)
                } else if let op = shape.highlight {
                    ctx.fill(p, with: .color(.white.opacity(op)))
                } else {
                    ctx.fill(p, with: .color(color))
                }
            }
        }
        .frame(width: size, height: size * 40.0 / 48.0)
    }
}

/// A hat on a rounded, palette-colored ground — the persona's visual identity.
struct HatBadge: View {
    var kind: String = "boater"
    var palette: HatPalette = .ink
    var size: CGFloat = 56
    var radius: CGFloat? = nil

    var body: some View {
        RoundedRectangle(cornerRadius: radius ?? (size * 0.28), style: .continuous)
            .fill(palette.bg)
            .frame(width: size, height: size)
            .overlay(
                HatGlyph(kind: kind, size: size * 0.6, color: palette.ink)
            )
            .overlay(
                RoundedRectangle(cornerRadius: radius ?? (size * 0.28), style: .continuous)
                    .strokeBorder(Color.black.opacity(0.06), lineWidth: 0.5)
            )
    }
}

// MARK: - Hat loader

/// Loading animation: a hat on a round ground that flips rapidly through a
/// random succession of styles and palette colours. No spinner.
struct HatLoader: View {
    var size: CGFloat = 116

    @State private var kind = HAT_KINDS.randomElement()!.0
    @State private var palette = HatPalette.all.randomElement()!

    // Fast tick → a lively flicker of hats + colours.
    private let tick = Timer.publish(every: 0.16, on: .main, in: .common).autoconnect()

    var body: some View {
        Circle()
            .fill(palette.bg)
            .frame(width: size, height: size)
            .overlay(HatGlyph(kind: kind, size: size * 0.56, color: palette.ink))
            .onReceive(tick) { _ in
                // Instant swaps (no eased transition) — avoid repeats.
                kind = HAT_KINDS.filter { $0.0 != kind }.randomElement()?.0 ?? kind
                palette = HatPalette.all.filter { $0.id != palette.id }.randomElement() ?? palette
            }
    }
}

// MARK: - Hat palettes

/// A curated palette: colored ground (`bg`) + hat ink chosen to read on it.
struct HatPalette: Identifiable, Equatable {
    let id: String
    let label: String
    let bg: Color
    let ink: Color

    // Computed (not stored) so labels re-resolve when the language changes.
    static var all: [HatPalette] { [
        .init(id: "ink", label: L("palette.ink"), bg: Color(hex: "#2a2622"), ink: Color(hex: "#f5efe6")),
        .init(id: "plum", label: L("palette.plum"), bg: Color(hex: "#7a4f6e"), ink: Color(hex: "#f7eef3")),
        .init(id: "cobalt", label: L("palette.cobalt"), bg: Color(hex: "#2c5aa0"), ink: Color(hex: "#eaf1fb")),
        .init(id: "marigold", label: L("palette.marigold"), bg: Color(hex: "#b97a1e"), ink: Color(hex: "#fff6e8")),
        .init(id: "sage", label: L("palette.sage"), bg: Color(hex: "#3d6b4f"), ink: Color(hex: "#ecf5ef")),
        .init(id: "terracotta", label: L("palette.terracotta"), bg: Color(hex: "#a6452e"), ink: Color(hex: "#fbeae4")),
        .init(id: "blush", label: L("palette.blush"), bg: Color(hex: "#e3a7c2"), ink: Color(hex: "#5a2742")),
        .init(id: "slate", label: L("palette.slate"), bg: Color(hex: "#44504f"), ink: Color(hex: "#eef2f1")),
        .init(id: "clay", label: L("palette.clay"), bg: Color(hex: "#9c6b4a"), ink: Color(hex: "#f7ede3")),
        .init(id: "cream", label: L("palette.cream"), bg: Color(hex: "#a89c88"), ink: Color(hex: "#2a2622")),
    ] }

    static let ink = all[0]

    static func by(_ id: String) -> HatPalette {
        all.first { $0.id == id } ?? ink
    }
}

// MARK: - Avatars
//
// A household member's photo avatar, with a graceful fallback to an initial on
// their accent colour when no photo is available. `AvatarStack` overlaps several
// for multi-user rooms, with a +N bubble past `max`.

struct Avatar: View {
    /// Absolute image URL (server base already applied), or nil → initials.
    var url: String?
    var initial: String
    var color: Color
    var size: CGFloat = 22
    /// When set, draws a ring in this colour so the avatar punches out from its
    /// background (used in overlapping stacks).
    var ring: Color? = nil

    var body: some View {
        Group {
            if let url, let u = URL(string: url) {
                AsyncImage(url: u) { phase in
                    if let img = phase.image {
                        img.resizable().scaledToFill()
                    } else {
                        fallback
                    }
                }
            } else {
                fallback
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay(
            Circle().strokeBorder(ring ?? Color.black.opacity(0.18), lineWidth: ring != nil ? 1.5 : 0.5)
        )
    }

    private var fallback: some View {
        color.overlay(
            Text(initial.uppercased())
                .font(.system(size: size * 0.44, weight: .medium, design: .serif))
                .foregroundStyle(.white)
        )
    }
}

struct AvatarStack: View {
    let participants: [ServerParticipant]
    /// Server base URL, prepended to each member's relative avatar path.
    var serverBase: String? = nil
    var size: CGFloat = 20
    /// The surface colour behind the stack, so avatars read as separated.
    var ring: Color = .white
    var max: Int = 4

    var body: some View {
        let show = Array(participants.prefix(max))
        let extra = participants.count - show.count
        HStack(spacing: -size * 0.36) {
            ForEach(Array(show.enumerated()), id: \.element.id) { i, p in
                Avatar(url: avatarURL(p), initial: p.initial, color: p.color, size: size, ring: ring)
                    .zIndex(Double(show.count - i))
            }
            if extra > 0 {
                Text("+\(extra)")
                    .font(.system(size: size * 0.42, design: .monospaced))
                    .foregroundStyle(.white)
                    .frame(width: size, height: size)
                    .background(Color(hex: "262320").opacity(0.55), in: Circle())
                    .overlay(Circle().strokeBorder(ring, lineWidth: 1.5))
            }
        }
    }

    private func avatarURL(_ p: ServerParticipant) -> String? {
        guard let path = p.avatar_url, !path.isEmpty else { return nil }
        if path.hasPrefix("http") { return path }
        return (serverBase ?? "") + path
    }
}
