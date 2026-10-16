import SwiftUI
import MarkdownUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif

// ── Snippets: code blocks one can copy, long pastes as cards ────
//
// Both live in fenced blocks. A code block Maurice writes gets a copy button;
// a long paste travels inside the member's message as a block whose info string
// is `pasted` — the model reads it as quoted material, a client that doesn't
// know the convention shows a plain code block, and this app draws a card.

func copyToPasteboard(_ text: String) {
    #if os(iOS)
    UIPasteboard.general.string = text
    #else
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
    #endif
}

enum PastedText {
    static let fenceInfo = "pasted"
    /// A paste this long leaves the field for a card.
    static let minCharacters = 1_000
    static let minLines = 20

    static func isLong(_ text: String) -> Bool {
        text.count >= minCharacters || lineCount(text) >= minLines
    }

    static func lineCount(_ text: String) -> Int {
        text.trimmingCharacters(in: .newlines).reduce(1) { $1 == "\n" ? $0 + 1 : $0 }
    }

    /// "Pasted text · 42 lines"
    static func caption(_ text: String) -> String {
        let n = lineCount(text)
        return "\(L("pasted.title")) · \(n == 1 ? L("pasted.one_line") : L("pasted.lines", n))"
    }

    /// The paste as a fenced block. The fence is one backtick longer than any
    /// run inside, so a paste may hold fences of its own without closing ours.
    static func fenced(_ text: String) -> String {
        var longest = 0, run = 0
        for c in text {
            if c == "`" { run += 1; longest = max(longest, run) } else { run = 0 }
        }
        let fence = String(repeating: "`", count: max(3, longest + 1))
        return "\(fence)\(fenceInfo)\n\(text.trimmingCharacters(in: .newlines))\n\(fence)"
    }

    /// What is sent: the pastes first, as images lead, then what was typed.
    static func compose(_ text: String, pastes: [String]) -> String {
        (pastes.map(fenced) + (text.isEmpty ? [] : [text])).joined(separator: "\n\n")
    }

    /// The long run of text an edit inserted in one go — a paste, or a drop —
    /// and the field without it. Nil for typing and for short pastes.
    static func insertion(from old: String, to new: String) -> (inserted: String, remaining: String)? {
        guard new.count > old.count else { return nil }
        let o = Array(old), n = Array(new)
        var prefix = 0
        while prefix < o.count, o[prefix] == n[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < o.count - prefix, o[o.count - 1 - suffix] == n[n.count - 1 - suffix] { suffix += 1 }
        let inserted = String(n[prefix..<(n.count - suffix)])
        guard isLong(inserted) else { return nil }
        return (inserted, String(n[..<prefix]) + String(n[(n.count - suffix)...]))
    }
}

// MARK: - Code block

/// A fenced block in a reply: its language, if given, and a copy button over
/// the code. The button copies the code alone, not the fences.
struct CodeBlockView: View {
    let configuration: CodeBlockConfiguration
    let theme: MauriceTheme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                if let language = configuration.language, !language.isEmpty {
                    Text(language)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(theme.inkMute)
                }
                Spacer(minLength: 0)
                CopyButton(text: configuration.content.trimmingCharacters(in: .newlines), theme: theme)
            }
            .padding(.leading, 10)
            .padding(.trailing, 4)
            .padding(.top, 2)
            configuration.label
                .markdownTextStyle {
                    FontFamilyVariant(.monospaced)
                    FontSize(13)
                    ForegroundColor(theme.codeInk)
                }
                .padding(.horizontal, 10)
                .padding(.bottom, 10)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.codeBg)
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

/// "Copy", then "Copied" for a moment.
private struct CopyButton: View {
    let text: String
    let theme: MauriceTheme
    @State private var copied = false

    var body: some View {
        Button {
            copyToPasteboard(text)
            copied = true
            Task {
                try? await Task.sleep(for: .seconds(1.5))
                copied = false
            }
        } label: {
            Label(copied ? L("chat.copied") : L("chat.copy"),
                  systemImage: copied ? "checkmark" : "doc.on.doc")
                .font(.system(size: 11))
                .padding(.horizontal, 6)
                .padding(.vertical, 6)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(theme.inkMute)
        .help(L("chat.copy"))
    }
}

// MARK: - Pasted text

/// A paste waiting in the composer: its first lines and its size.
struct PastedTextTile: View {
    @Environment(\.mauriceTheme) private var theme
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(text.trimmingCharacters(in: .whitespacesAndNewlines))
                .font(.system(size: 9))
                .foregroundStyle(theme.inkSoft)
                .lineLimit(3)
                .multilineTextAlignment(.leading)
            Spacer(minLength: 0)
            Text(PastedText.caption(text))
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(theme.inkMute)
                .lineLimit(1)
        }
        .padding(6)
        .frame(width: 128, height: 60, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 6).fill(theme.codeBg))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(theme.rule, lineWidth: 0.5))
    }
}

/// A paste in a sent message: a card in place of the wall of text, opened in
/// full with one tap.
struct PastedTextCard: View {
    let text: String
    let theme: MauriceTheme
    @State private var open = false

    var body: some View {
        Button { open = true } label: {
            VStack(alignment: .leading, spacing: 6) {
                Text(text.trimmingCharacters(in: .whitespacesAndNewlines))
                    .font(.system(size: 12))
                    .foregroundStyle(theme.inkSoft)
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)
                Label(PastedText.caption(text), systemImage: "doc.plaintext")
                    .font(.system(size: 11))
                    .foregroundStyle(theme.inkMute)
            }
            .padding(10)
            .frame(maxWidth: 360, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8).fill(theme.codeBg))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(theme.rule, lineWidth: 0.5))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .sheet(isPresented: $open) {
            PastedTextSheet(text: text)
                .environment(\.mauriceTheme, theme)
        }
    }
}

/// The whole paste, selectable, with Copy — and, from the composer, a way to
/// put it back in the field as ordinary text.
struct PastedTextSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.mauriceTheme) private var theme
    let text: String
    var onInline: (() -> Void)? = nil

    var body: some View {
        NavigationStack {
            content
                .background(theme.surface.ignoresSafeArea())
                .navigationTitle(L("pasted.title"))
                #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
                #endif
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(L("common.done")) { dismiss() }
                    }
                    ToolbarItem(placement: .primaryAction) {
                        CopyButton(text: text, theme: theme)
                    }
                }
                // The size, and from the composer the way back into the field,
                // under the text: the toolbar has no room for them on a phone.
                .safeAreaInset(edge: .bottom) {
                    HStack {
                        Text(PastedText.caption(text))
                            .font(.system(size: 12))
                            .foregroundStyle(theme.inkMute)
                        Spacer()
                        if let onInline {
                            Button(L("pasted.inline")) {
                                onInline()
                                dismiss()
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(theme.surface)
                }
        }
        #if os(macOS)
        .frame(minWidth: 560, idealWidth: 680, minHeight: 420, idealHeight: 560)
        #endif
    }

    @ViewBuilder
    private var content: some View {
        #if os(iOS)
        // A UITextView: selection can span the whole paste, and a long one
        // scrolls without laying out as a single SwiftUI Text.
        SelectableTextView(text: text, textColor: UIColor(theme.ink))
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        #else
        ScrollView {
            Text(text)
                .font(.system(size: 13))
                .foregroundStyle(theme.ink)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
        }
        #endif
    }
}
