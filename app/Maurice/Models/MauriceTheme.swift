import SwiftUI

// MARK: - Theme

/// Semantic color tokens derived from a named palette.
struct MauriceTheme {
    let isDark: Bool
    let bg: Color
    let surface: Color
    let surfaceAlt: Color
    let ink: Color
    let inkSoft: Color
    let inkMute: Color
    let rule: Color
    let ruleHard: Color
    let codeBg: Color
    let codeInk: Color

    /// Auto theme based on system color scheme.
    static func current(for colorScheme: ColorScheme) -> MauriceTheme {
        colorScheme == .dark ? palette("studio") : palette("cream")
    }

    /// Resolve a palette by name, falling back to auto (system color scheme).
    static func named(_ id: String, colorScheme: ColorScheme) -> MauriceTheme {
        if id == "auto" {
            return current(for: colorScheme)
        }
        return palette(id)
    }

    /// The color scheme a palette implies (nil = follow system).
    static func colorSchemeOverride(for id: String) -> ColorScheme? {
        if id == "auto" { return nil }
        if let p = allPalettes.first(where: { $0.id == id }) {
            return p.isDark ? .dark : .light
        }
        return nil
    }
}

// MARK: - Palettes

/// A palette defines three surface colors; ink/rule tokens are derived from whether it's dark.
struct Palette {
    let id: String
    let label: String
    let isDark: Bool
    let bg: Color
    let surface: Color
    let surfaceAlt: Color

    func resolve() -> MauriceTheme {
        if isDark {
            let ink = Color(red: 0xf0/255, green: 0xeb/255, blue: 0xe2/255)
            return MauriceTheme(
                isDark: true,
                bg: bg,
                surface: surface,
                surfaceAlt: surfaceAlt,
                ink: ink,
                inkSoft: ink.opacity(0.65),
                inkMute: ink.opacity(0.40),
                rule: ink.opacity(0.10),
                ruleHard: ink.opacity(0.18),
                codeBg: surfaceAlt,
                codeInk: ink.opacity(0.85)
            )
        } else {
            let ink = Color(red: 0x26/255, green: 0x23/255, blue: 0x20/255)
            return MauriceTheme(
                isDark: false,
                bg: bg,
                surface: surface,
                surfaceAlt: surfaceAlt,
                ink: ink,
                inkSoft: ink.opacity(0.62),
                inkMute: ink.opacity(0.42),
                rule: ink.opacity(0.10),
                ruleHard: ink.opacity(0.18),
                codeBg: surfaceAlt,
                codeInk: ink.opacity(0.85)
            )
        }
    }
}

extension MauriceTheme {

    // ── Light palettes ──────────────────────────────────────

    static let lightPalettes: [Palette] = [
        Palette(id: "white",  label: "White",  isDark: false,
                bg: c(0xff,0xff,0xff), surface: c(0xff,0xff,0xff), surfaceAlt: c(0xf6,0xf6,0xf4)),
        Palette(id: "bone",   label: "Bone",   isDark: false,
                bg: c(0xfa,0xfa,0xf8), surface: c(0xff,0xff,0xff), surfaceAlt: c(0xf0,0xf0,0xec)),
        Palette(id: "ivory",  label: "Ivory",  isDark: false,
                bg: c(0xf8,0xf5,0xef), surface: c(0xfe,0xfc,0xf7), surfaceAlt: c(0xef,0xea,0xe0)),
        Palette(id: "cream",  label: "Cream",  isDark: false,
                bg: c(0xf5,0xef,0xe6), surface: c(0xfb,0xf7,0xf0), surfaceAlt: c(0xf0,0xe9,0xdc)),
        Palette(id: "stone",  label: "Stone",  isDark: false,
                bg: c(0xef,0xec,0xe6), surface: c(0xf8,0xf6,0xf1), surfaceAlt: c(0xe6,0xe2,0xd9)),
        Palette(id: "sage",   label: "Sage",   isDark: false,
                bg: c(0xec,0xef,0xe7), surface: c(0xf5,0xf7,0xf0), surfaceAlt: c(0xe2,0xe7,0xd9)),
        Palette(id: "mist",   label: "Mist",   isDark: false,
                bg: c(0xec,0xef,0xf3), surface: c(0xf6,0xf8,0xfb), surfaceAlt: c(0xdd,0xe3,0xea)),
    ]

    // ── Dark palettes ───────────────────────────────────────

    static let darkPalettes: [Palette] = [
        Palette(id: "studio",   label: "Studio",   isDark: true,
                bg: c(0x1f,0x1c,0x19), surface: c(0x26,0x23,0x20), surfaceAlt: c(0x18,0x16,0x14)),
        Palette(id: "slate",    label: "Slate",    isDark: true,
                bg: c(0x17,0x1a,0x1d), surface: c(0x1f,0x23,0x28), surfaceAlt: c(0x0f,0x12,0x16)),
        Palette(id: "forest",   label: "Forest",   isDark: true,
                bg: c(0x14,0x18,0x15), surface: c(0x1c,0x21,0x1c), surfaceAlt: c(0x0e,0x12,0x0e)),
        Palette(id: "plum",     label: "Plum",     isDark: true,
                bg: c(0x1c,0x17,0x1c), surface: c(0x24,0x1e,0x26), surfaceAlt: c(0x13,0x0f,0x18)),
        Palette(id: "espresso", label: "Espresso", isDark: true,
                bg: c(0x1a,0x19,0x16), surface: c(0x22,0x20,0x19), surfaceAlt: c(0x10,0x0f,0x0c)),
    ]

    static let allPalettes: [Palette] = lightPalettes + darkPalettes

    static func palette(_ id: String) -> MauriceTheme {
        if let p = allPalettes.first(where: { $0.id == id }) {
            return p.resolve()
        }
        return lightPalettes[3].resolve() // cream fallback
    }

    private static func c(_ r: Int, _ g: Int, _ b: Int) -> Color {
        Color(red: Double(r)/255, green: Double(g)/255, blue: Double(b)/255)
    }
}

// MARK: - Theme Environment Key

private struct ThemeKey: EnvironmentKey {
    static let defaultValue = MauriceTheme.palette("cream")
}

extension EnvironmentValues {
    var mauriceTheme: MauriceTheme {
        get { self[ThemeKey.self] }
        set { self[ThemeKey.self] = newValue }
    }
}
