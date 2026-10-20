import SwiftUI

#if os(iOS)
/// The keyboard glyph inside an empty search field, as in the composer: hides
/// the keyboard and leaves the search open.
struct HideKeyboardButton: View {
    var focus: FocusState<Bool>.Binding
    var color: Color
    var label: String
    /// The tap target's height; a field gives its own so the whole of it counts.
    var height: CGFloat = 28

    var body: some View {
        Button { focus.wrappedValue = false } label: {
            Image(systemName: "keyboard.chevron.compact.down")
                .font(.system(size: 14))
                .foregroundStyle(color)
                .frame(width: 36, height: height)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}
#endif
