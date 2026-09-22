import SwiftUI

// MARK: - Liquid Glass (OS 26+) with a material fallback before

/// Liquid Glass for the surfaces we draw ourselves. Standard components (bars,
/// sheets, the split view's sidebar, `.glass` buttons) get the material from
/// the system; these helpers give it to the floating composer panel, the two
/// header groups, and the custom controls (icon buttons, pills, fields) — a
/// deliberate choice to go further than Apple's "use sparingly" guidance, so
/// every helper also carries the pre-26 fallback and can be dialled back per
/// call site.
///
/// The deployment target (iOS 17 / macOS 14) is why everything is behind
/// `#available`; before OS 26 the app keeps the material-over-tint look it
/// shipped with.
extension View {

    /// The floating composer panel. Regular glass, lightly tinted with the
    /// palette surface so the warm themes survive; the fallback is a thin
    /// material under the same tint.
    func glassPanel(_ theme: MauriceTheme, cornerRadius: CGFloat) -> some View {
        modifier(GlassPanel(theme: theme, cornerRadius: cornerRadius))
    }

    /// The sidebar column. On 26+ the split view paints the column in glass
    /// and Apple asks that custom backgrounds be removed from split views, so
    /// we paint nothing; before, the opaque `surfaceAlt` as always.
    func glassSidebarBackground(_ theme: MauriceTheme) -> some View {
        modifier(GlassSidebarBackground(theme: theme))
    }

    /// A control — a button label, a field, a pill. Interactive glass (it
    /// reacts to hover and press) with a light specular rim; the fallback is
    /// `fallbackFill` (default: the palette surface) with a hairline, which is
    /// what these controls looked like before.
    /// `morph` + `namespace` give the control a glass identity: two controls
    /// sharing one, inside a `GlassGroup`, morph into each other when one
    /// replaces the other (OS 26); ignored before.
    func glassControl<S: InsettableShape>(_ theme: MauriceTheme, in shape: S,
                                          fallbackFill: Color? = nil,
                                          morph: String? = nil,
                                          namespace: Namespace.ID? = nil) -> some View {
        modifier(GlassControl(theme: theme, shape: shape, fallbackFill: fallbackFill,
                              morph: morph, namespace: namespace))
    }

    /// A sheet whose presentation hugs its content's ideal size instead of the
    /// platform's fixed form-sheet box (iPad: 540×620, which strands the card
    /// in a wide empty surface). No-op before iOS 18 / macOS 15.
    func fittedPresentation() -> some View { modifier(FittedPresentation()) }

    /// `.buttonStyle(.bordered)` that turns to the system's glass style on 26+.
    func glassBorderedButton() -> some View { modifier(GlassBorderedButton(prominent: false)) }
    /// `.buttonStyle(.borderedProminent)` that turns to glass on 26+.
    func glassProminentButton() -> some View { modifier(GlassBorderedButton(prominent: true)) }
}

/// Groups neighbouring glass controls so they blend and morph as one — the
/// OS 26 `GlassEffectContainer`; a plain group before.
struct GlassGroup<Content: View>: View {
    var spacing: CGFloat = 12
    @ViewBuilder var content: () -> Content

    var body: some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) { content() }
        } else {
            content()
        }
    }
}

// MARK: Implementations

private struct GlassControl<S: InsettableShape>: ViewModifier {
    let theme: MauriceTheme
    let shape: S
    let fallbackFill: Color?
    var morph: String? = nil
    var namespace: Namespace.ID? = nil

    func body(content: Content) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            content
                .glassEffect(.regular.tint(theme.surface.opacity(theme.isDark ? 0.10 : 0.18)).interactive(),
                             in: shape)
                .modifier(GlassIdentity(morph: morph, namespace: namespace))
                .overlay(
                    shape.strokeBorder(
                        LinearGradient(
                            colors: [.white.opacity(theme.isDark ? 0.30 : 0.75),
                                     .white.opacity(0.03),
                                     .black.opacity(theme.isDark ? 0.20 : 0.05)],
                            startPoint: .top, endPoint: .bottom),
                        lineWidth: 0.75)
                )
                .shadow(color: .black.opacity(theme.isDark ? 0.30 : 0.10), radius: 6, y: 3)
        } else {
            content
                .background(fallbackFill ?? theme.surface, in: shape)
                .overlay(shape.strokeBorder(theme.ruleHard, lineWidth: 0.5))
        }
    }
}

@available(iOS 26.0, macOS 26.0, *)
private struct GlassIdentity: ViewModifier {
    let morph: String?
    let namespace: Namespace.ID?

    func body(content: Content) -> some View {
        if let morph, let namespace {
            content.glassEffectID(morph, in: namespace)
        } else {
            content
        }
    }
}

private struct GlassPanel: ViewModifier {
    let theme: MauriceTheme
    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        if #available(iOS 26.0, macOS 26.0, *) {
            content
                // A light tint only — a heavy one flattens the glass into a
                // plate and hides the system's refraction and highlights.
                .glassEffect(.regular.tint(theme.surface.opacity(theme.isDark ? 0.12 : 0.22)), in: shape)
                // Relief: a specular rim that catches light at the top edge…
                .overlay(
                    shape.strokeBorder(
                        LinearGradient(
                            colors: [.white.opacity(theme.isDark ? 0.35 : 0.85),
                                     .white.opacity(0.05),
                                     .black.opacity(theme.isDark ? 0.25 : 0.06)],
                            startPoint: .top, endPoint: .bottom),
                        lineWidth: 1)
                )
                // …and a soft drop shadow lifting the field off the stream.
                .shadow(color: .black.opacity(theme.isDark ? 0.45 : 0.16), radius: 18, y: 10)
                .shadow(color: .black.opacity(theme.isDark ? 0.25 : 0.08), radius: 2, y: 1)
        } else {
            content
                .background(theme.surface.opacity(0.80), in: shape) // warm tint, over…
                .background(.ultraThinMaterial, in: shape)          // …the backdrop blur
                .overlay(shape.strokeBorder(theme.rule, lineWidth: 0.5))
                .shadow(color: .black.opacity(0.12), radius: 14, y: 8)
        }
    }
}

private struct GlassSidebarBackground: ViewModifier {
    let theme: MauriceTheme

    func body(content: Content) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            content
        } else {
            content.background(theme.surfaceAlt)
        }
    }
}

private struct FittedPresentation: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 18.0, macOS 15.0, *) {
            content.presentationSizing(.fitted)
        } else {
            content
        }
    }
}

private struct GlassBorderedButton: ViewModifier {
    let prominent: Bool

    func body(content: Content) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            if prominent { content.buttonStyle(.glassProminent) } else { content.buttonStyle(.glass) }
        } else {
            if prominent { content.buttonStyle(.borderedProminent) } else { content.buttonStyle(.bordered) }
        }
    }
}
