import SwiftUI

#if os(iOS)
/// The keyboard glyph inside an empty search field, as in the composer: hides
/// the keyboard and leaves the search open.
struct HideKeyboardButton: View {
    var focus: FocusState<Bool>.Binding
    var color: Color
    var label: String

    var body: some View {
        Button { focus.wrappedValue = false } label: {
            Image(systemName: "keyboard.chevron.compact.down")
                .font(.system(size: 14))
                .foregroundStyle(color)
                .frame(width: 28, height: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}
#endif
