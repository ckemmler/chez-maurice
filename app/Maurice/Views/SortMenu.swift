import SwiftUI

// MARK: - The one sort control the app's lists share
//
// Every list that shows a garden, a library or a search has a natural default
// order — nearly always "what I touched last". That default is right often
// enough that it should never need choosing, and wrong often enough that it
// must be changeable. So: one menu, the active choice ticked, and the default
// named as such in the list so coming back to it is never a guess.
//
// A surface declares its own axes as a SortChoice enum, stores the raw value in
// @AppStorage (the choice survives launches — a reader who sorts their garden
// by title means it), and hands the storage straight to SortMenu.

protocol SortChoice: RawRepresentable, CaseIterable, Hashable where RawValue == String {
    /// The order the list starts in, and the one the menu marks as default.
    static var defaultChoice: Self { get }
    /// Localizable key for the menu row.
    var labelKey: String { get }
}

struct SortMenu<Choice: SortChoice>: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.mauriceTheme) private var theme
    @Binding private var choice: Choice
    private let accent: Color

    /// Binds to the surface's `@AppStorage` string. An unknown stored value
    /// (a build that dropped an axis) falls back to the default rather than
    /// leaving the list in an order nothing in the menu is ticked for.
    init(raw: Binding<String>, accent: Color) {
        self._choice = Binding(
            get: { Choice(rawValue: raw.wrappedValue) ?? Choice.defaultChoice },
            set: { raw.wrappedValue = $0.rawValue },
        )
        self.accent = accent
    }

    private func label(_ c: Choice) -> String {
        let name = session.localized(c.labelKey)
        return c == Choice.defaultChoice
            ? "\(name) · \(session.localized("sort.default"))"
            : name
    }

    var body: some View {
        Menu {
            Picker(session.localized("sort.menu"), selection: $choice) {
                ForEach(Array(Choice.allCases), id: \.self) { c in
                    Text(label(c)).tag(c)
                }
            }
        } label: {
            // Tinted whenever the list is NOT in its default order — the same
            // signal the filter chips use, so a surprising order is traceable
            // to a control rather than looking like a bug.
            Image(systemName: "arrow.up.arrow.down")
                .font(.system(size: 13))
                .foregroundStyle(choice == Choice.defaultChoice ? theme.inkSoft : accent)
                .frame(width: 28, height: 28)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .accessibilityLabel(session.localized("sort.menu"))
    }
}
