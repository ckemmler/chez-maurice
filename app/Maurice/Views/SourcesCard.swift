import SwiftUI

/// What a search found, drawn rather than dumped.
///
/// Both searches — the corpus and the web — send the same payload
/// (`card: "sources"`, built in `server/src/services/sourceCards.ts`): a title,
/// where it came from, an optional cover, and the passage that matched. Before
/// this, a corpus search rendered as a folded key/value dump of forty fields a
/// row, and a web search rendered as nothing at all.
///
/// The row scrolls sideways and the cards are deliberately small: this is
/// evidence beside the reply, not the reply. Tapping a web source opens it;
/// tapping anything else shows the passage that matched, since a note in a
/// garden has nowhere to open to.
struct SourcesCard: View {
    @Environment(\.mauriceTheme) private var theme
    let data: JSONValue

    @State private var shown: Int?

    private var origin: String { data.string("origin") }
    private var isWeb: Bool { origin == "web" }
    private var results: [JSONValue] { data["results"]?.arrayValue ?? [] }

    /// The server caps the cards it sends but reports the true total, so the
    /// header can say "12 of 30" honestly rather than quietly losing eighteen.
    private var total: Int { data.int("count") }

    private var headline: String {
        let n = results.count
        let key = isWeb ? "sources.web" : "sources.corpus"
        return total > n ? L("sources.more", L(key, n), total) : L(key, n)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 8) {
                    ForEach(Array(results.enumerated()), id: \.offset) { index, item in
                        SourceCardCell(item: item, isWeb: isWeb, showing: shown == index) {
                            withAnimation(.easeOut(duration: 0.15)) {
                                shown = shown == index ? nil : index
                            }
                        }
                    }
                }
                .padding(.horizontal, 2)
            }
            if let shown, shown < results.count { passage(results[shown]) }
        }
        .padding(.vertical, 2)
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: isWeb ? "globe" : "tray.full")
                .font(.system(size: 11))
            Text(headline)
                .font(.system(size: 12, weight: .medium))
            if !data.string("query").isEmpty {
                Text("« \(data.string("query")) »")
                    .font(.system(size: 11))
                    .lineLimit(1)
                    .foregroundStyle(theme.inkMute)
            }
        }
        .foregroundStyle(theme.inkSoft)
    }

    /// The matching passage, under the row, for a source with nowhere to open.
    private func passage(_ item: JSONValue) -> some View {
        Text(item.string("snippet"))
            .font(.system(size: 12))
            .foregroundStyle(theme.inkSoft)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 6).fill(theme.inkMute.opacity(0.06)))
    }
}

/// One card. A web result is a link; everything else toggles its passage.
private struct SourceCardCell: View {
    @Environment(\.mauriceTheme) private var theme
    @Environment(SessionStore.self) private var session
    let item: JSONValue
    let isWeb: Bool
    let showing: Bool
    let tapped: () -> Void

    private var url: URL? {
        let raw = item.string("url")
        guard !raw.isEmpty else { return nil }
        return URL(string: raw)
    }

    var body: some View {
        if let url, isWeb {
            Link(destination: url) { card }.buttonStyle(.plain)
        } else {
            Button(action: tapped) { card }.buttonStyle(.plain)
        }
    }

    private var card: some View {
        HStack(alignment: .top, spacing: 8) {
            SourceThumb(item: item, isWeb: isWeb)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.string("title"))
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(theme.ink)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                if !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.system(size: 11))
                        .foregroundStyle(theme.inkMute)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            Spacer(minLength: 0)
        }
        .padding(8)
        .frame(width: 208, height: 74, alignment: .topLeading)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(theme.inkMute.opacity(showing ? 0.12 : 0.06))
        )
    }

    /// Where it came from: the domain on the web, and in the garden the nature
    /// of the thing first — a note of yours and a page of someone else's book
    /// are not the same evidence — then whatever identifies it.
    private var subtitle: String {
        let given = item.string("subtitle")
        if isWeb { return given }
        let kind = L("sources.kind.\(item.string("kind"))")
        return given.isEmpty ? kind : "\(kind) · \(given)"
    }
}

/// The cover when the garden has one, else the mark of what this is: a site's
/// initial for the web, the icon of its nature for everything else.
private struct SourceThumb: View {
    @Environment(\.mauriceTheme) private var theme
    @Environment(SessionStore.self) private var session
    let item: JSONValue
    let isWeb: Bool

    private static let icons: [String: String] = [
        "note": "note.text",
        "fiche": "doc.richtext",
        "card": "rectangle.portrait.on.rectangle.portrait",
        "fragment": "text.append",
        "conversation": "bubble.left.and.bubble.right",
        "book": "book.closed",
        "dossier": "folder",
        "thought": "brain",
        "web": "globe",
    ]

    private var url: URL? {
        let path = item.string("image")
        guard !path.isEmpty else { return nil }
        if path.hasPrefix("http") { return URL(string: path) }
        guard let base = session.serverURL else { return nil }
        return URL(string: base + path)
    }

    var body: some View {
        Group {
            if let url {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image): image.resizable().aspectRatio(contentMode: .fill)
                    default: mark
                    }
                }
            } else {
                mark
            }
        }
        .frame(width: 40, height: 58)
        .clipShape(RoundedRectangle(cornerRadius: 4))
    }

    /// No cover: a letter for a site, an icon for a kind of memory. Both beat
    /// an empty grey box at saying what you are about to open.
    private var mark: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 4).fill(theme.inkMute.opacity(0.15))
            if isWeb, let initial = item.string("subtitle").first {
                Text(String(initial).uppercased())
                    .font(.system(size: 17, weight: .semibold, design: .serif))
                    .foregroundStyle(theme.inkMute)
            } else {
                Image(systemName: Self.icons[item.string("kind")] ?? "doc")
                    .font(.system(size: 14))
                    .foregroundStyle(theme.inkMute)
            }
        }
    }
}
