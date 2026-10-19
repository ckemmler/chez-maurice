import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif

// ── Snippets: long pastes and shared articles as cards ──────────
//
// Both live in fenced blocks. A long paste travels inside the member's message
// as a block whose info string is `pasted` — the model reads it as quoted
// material, a client that doesn't know the convention shows a plain code
// block, and this app draws a card.

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

    /// The paste as a fenced block.
    static func fenced(_ text: String) -> String { fence(text, info: fenceInfo) }

    /// `text` in a fenced block. The fence is one backtick longer than any run
    /// inside, so the text may hold fences of its own without closing ours.
    static func fence(_ text: String, info: String) -> String {
        var longest = 0, run = 0
        for c in text {
            if c == "`" { run += 1; longest = max(longest, run) } else { run = 0 }
        }
        let fence = String(repeating: "`", count: max(3, longest + 1))
        return "\(fence)\(info)\n\(text.trimmingCharacters(in: .newlines))\n\(fence)"
    }

    /// What is sent: the pastes and articles first, as images lead, then what
    /// was typed.
    static func compose(_ text: String, pastes: [Snippet]) -> String {
        (pastes.map(\.fenced) + (text.isEmpty ? [] : [text])).joined(separator: "\n\n")
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

/// A long piece of text the composer carries as a card above the field.
enum Snippet: Equatable {
    /// Text pasted or dropped into the field.
    case paste(String)
    /// An article shared from another app (ShareInbox).
    case article(SharedArticle)

    var fenced: String {
        switch self {
        case .paste(let text): return PastedText.fenced(text)
        case .article(let article): return article.fenced
        }
    }
}

/// An article shared with Maurice, as it rides in a message: an `article`
/// block whose first lines say what it is — `title: …`, `url: …` — and whose
/// body, after a blank line, is its text. The model reads a labelled document;
/// this app draws a card.
struct SharedArticle: Equatable {
    static let fenceInfo = "article"

    var title: String
    var site: String = ""
    var author: String = ""
    /// YYYY-MM-DD, when the page says.
    var date: String = ""
    var url: String
    /// Empty when the page could not be read: the card is then a link.
    var text: String

    private static let keys = ["title", "site", "author", "date", "url"]

    var fenced: String {
        let values = [title, site, author, date, url]
        let header = zip(Self.keys, values).compactMap { key, value -> String? in
            let line = value.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
            return line.isEmpty ? nil : "\(key): \(line)"
        }
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return PastedText.fence(([header.joined(separator: "\n")] + (body.isEmpty ? [] : [body]))
            .joined(separator: "\n\n"), info: Self.fenceInfo)
    }

    /// Read back the block's content (without its fences).
    init(block content: String) {
        let trimmed = content.trimmingCharacters(in: .newlines)
        let parts = trimmed.components(separatedBy: "\n\n")
        var fields: [String: String] = [:]
        for line in parts[0].split(separator: "\n") {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = String(line[..<colon])
            guard Self.keys.contains(key) else { continue }
            fields[key] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        title = fields["title"] ?? ""
        site = fields["site"] ?? ""
        author = fields["author"] ?? ""
        date = fields["date"] ?? ""
        url = fields["url"] ?? ""
        // A block without the header is all text.
        text = fields.isEmpty ? trimmed : parts.dropFirst().joined(separator: "\n\n")
    }

    init(title: String, site: String = "", author: String = "", date: String = "", url: String, text: String) {
        self.title = title
        self.site = site
        self.author = author
        self.date = date
        self.url = url
        self.text = text
    }

    /// The publication, or the address's host when the page did not say.
    var source: String {
        if !site.isEmpty { return site }
        let host = URL(string: url)?.host ?? ""
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    var wordCount: Int {
        text.split(whereSeparator: { $0.isWhitespace }).count
    }

    /// "Article · 1 234 words", or "Link only" when no text came with it.
    var caption: String {
        let n = wordCount
        guard n > 0 else { return L("article.link_only") }
        return "\(L("article.title")) · \(L("article.words", n))"
    }
}

// MARK: - Copy

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

// MARK: - Pasted text and shared articles

/// A paste or an article waiting in the composer: its first lines — or its
/// source and title — and its size.
struct PastedTextTile: View {
    @Environment(\.mauriceTheme) private var theme
    let snippet: Snippet

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            switch snippet {
            case .paste(let text):
                Text(text.trimmingCharacters(in: .whitespacesAndNewlines))
                    .font(.system(size: 9))
                    .foregroundStyle(theme.inkSoft)
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
                caption(PastedText.caption(text))
            case .article(let article):
                Text(article.source)
                    .font(.system(size: 8, weight: .medium))
                    .foregroundStyle(theme.inkMute)
                    .lineLimit(1)
                Text(article.title.isEmpty ? article.url : article.title)
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(theme.ink)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
                caption(article.caption)
            }
        }
        .padding(6)
        .frame(width: 128, height: 60, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 6).fill(theme.codeBg))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(theme.rule, lineWidth: 0.5))
    }

    private func caption(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 9, weight: .medium))
            .foregroundStyle(theme.inkMute)
            .lineLimit(1)
    }
}

/// A shared article on its way: the server is reading it.
struct ReadingArticleTile: View {
    @Environment(\.mauriceTheme) private var theme
    let label: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(theme.inkSoft)
                .lineLimit(2)
            Spacer(minLength: 0)
            HStack(spacing: 4) {
                ProgressView().controlSize(.mini)
                Text(L("article.reading"))
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(theme.inkMute)
                    .lineLimit(1)
            }
        }
        .padding(6)
        .frame(width: 128, height: 60, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 6).fill(theme.codeBg))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(theme.rule, lineWidth: 0.5))
    }
}

/// A paste or an article in a sent message: a card in place of the wall of
/// text, opened in full with one tap.
struct PastedTextCard: View {
    let snippet: Snippet
    let theme: MauriceTheme
    @State private var open = false

    var body: some View {
        Button { open = true } label: {
            VStack(alignment: .leading, spacing: 6) {
                switch snippet {
                case .paste(let text):
                    Text(text.trimmingCharacters(in: .whitespacesAndNewlines))
                        .font(.system(size: 12))
                        .foregroundStyle(theme.inkSoft)
                        .lineLimit(3)
                        .multilineTextAlignment(.leading)
                    Label(PastedText.caption(text), systemImage: "doc.plaintext")
                        .font(.system(size: 11))
                        .foregroundStyle(theme.inkMute)
                case .article(let article):
                    Text(article.source)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(theme.inkMute)
                        .lineLimit(1)
                    Text(article.title.isEmpty ? article.url : article.title)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(theme.ink)
                        .lineLimit(3)
                        .multilineTextAlignment(.leading)
                    Label(article.caption, systemImage: "newspaper")
                        .font(.system(size: 11))
                        .foregroundStyle(theme.inkMute)
                }
            }
            .padding(10)
            .frame(maxWidth: 360, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8).fill(theme.codeBg))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(theme.rule, lineWidth: 0.5))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .sheet(isPresented: $open) {
            PastedTextSheet(snippet: snippet)
                .environment(\.mauriceTheme, theme)
        }
    }
}

/// The whole paste or article, selectable, with Copy — and, from the composer,
/// a way to put a paste back in the field as ordinary text. An article offers
/// its page instead.
struct PastedTextSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.mauriceTheme) private var theme
    let snippet: Snippet
    var onInline: (() -> Void)? = nil

    private var text: String {
        switch snippet {
        case .paste(let text): return text
        case .article(let a):
            let byline = [a.author, a.date].filter { !$0.isEmpty }.joined(separator: " · ")
            return ([a.title, byline, a.text].filter { !$0.isEmpty }).joined(separator: "\n\n")
        }
    }

    private var title: String {
        switch snippet {
        case .paste: return L("pasted.title")
        case .article(let a): return a.source.isEmpty ? L("article.title") : a.source
        }
    }

    private var caption: String {
        switch snippet {
        case .paste(let text): return PastedText.caption(text)
        case .article(let a): return a.caption
        }
    }

    var body: some View {
        NavigationStack {
            content
                .background(theme.surface.ignoresSafeArea())
                .navigationTitle(title)
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
                // The size, and the way back into the field or out to the page,
                // under the text: the toolbar has no room for them on a phone.
                .safeAreaInset(edge: .bottom) {
                    HStack {
                        Text(caption)
                            .font(.system(size: 12))
                            .foregroundStyle(theme.inkMute)
                        Spacer()
                        if case .article(let a) = snippet, let url = URL(string: a.url) {
                            Link(L("article.open"), destination: url)
                                .buttonStyle(.bordered)
                        } else if let onInline {
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
        // A UITextView: selection can span the whole text, and a long one
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
