import SwiftUI

// MARK: - Search fields and the keyboard
//
// iOS lets no icon onto the return key, so an empty search field reads "Done"
// there instead of a Search key with nothing to search, and that key hides the
// keyboard; the field itself carries the keyboard glyph while it is focused and
// empty, as the composer does. Most of these fields filter as you type: their
// return key only ever hides the keyboard.

extension View {
    /// The return key of a search field. Empty, it reads Done and hides the
    /// keyboard. With text it reads Search and runs `submit`, or, for a field
    /// that filters as you type (no `submit`), hides the keyboard as well.
    func searchReturnKey(isEmpty: Bool, focus: FocusState<Bool>.Binding,
                         submit: (() -> Void)? = nil) -> some View {
        #if os(iOS)
        submitLabel(isEmpty ? .done : .search)
            .onSubmit {
                if isEmpty || submit == nil { focus.wrappedValue = false } else { submit?() }
            }
        #else
        onSubmit { if !isEmpty { submit?() } }
        #endif
    }
}

#if os(iOS)
/// The keyboard glyph inside an empty search field: hides the keyboard and
/// leaves the search open.
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
