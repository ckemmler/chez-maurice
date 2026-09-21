import SwiftUI

/// What a search found — a line of pills under the reply, and the sources
/// themselves in a drawer when you tap it.
///
/// Both searches, the corpus and the web, send the same payload
/// (`card: "sources"`, built in `server/src/services/sourceCards.ts`): a title,
/// where it came from, an optional cover, and the passage that matched.
///
/// The first version drew that as a scrolling row of cards, which took more
/// room under every reply than the reply itself. Evidence should be *at hand*,
/// not in the way: what stays in the transcript is now a stack of thumbnails
/// and a count, the size of a line of text, and the cards live one tap away.
struct SourcesCard: View {
    @Environment(\.mauriceTheme) private var theme
    /// Every search of one origin made on this turn, in the order it ran them.
    /// Usually one; a turn that searched four times hands over four, and they
    /// are drawn as a single row (see `DataCardStack.typedItems`).
    let cards: [JSONValue]

    @State private var open = false

    private var isWeb: Bool { cards.first?.string("origin") == "web" }
    private var results: [JSONValue] { SourcesCard.distinct(cards) }
    /// The server caps the cards it sends but reports the true total, so the
    /// count is honest rather than quietly eighteen short. Across several
    /// searches: the distinct sources at hand, plus what each search said it
    /// had found and did not carry.
    private var total: Int {
        let uncarried = cards.reduce(0) { $0 + max(0, $1.int("count") - ($1["results"]?.arrayValue ?? []).count) }
        return results.count + uncarried
    }

    /// The same page found by two searches is one source. A web result is its
    /// URL, bare of the differences that are not ones; anything else is what
    /// it is called and where it comes from — a note has no address.
    static func key(_ item: JSONValue, isWeb: Bool) -> String {
        if isWeb {
            let url = item.string("url").lowercased()
            if !url.isEmpty {
                return url
                    .replacingOccurrences(of: "https://", with: "")
                    .replacingOccurrences(of: "http://", with: "")
                    .replacingOccurrences(of: "www.", with: "")
                    .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            }
        }
        return item.string("title") + "|" + item.string("subtitle")
    }

    /// The sources of every search, in order, each one kept the first time it
    /// appears.
    static func distinct(_ cards: [JSONValue]) -> [JSONValue] {
        let isWeb = cards.first?.string("origin") == "web"
        var seen = Set<String>()
        var out: [JSONValue] = []
        for card in cards {
            for item in card["results"]?.arrayValue ?? [] where seen.insert(key(item, isWeb: isWeb)).inserted {
                out.append(item)
            }
        }
        return out
    }

    /// How many thumbnails the stack shows before it is just a count.
    private static let shown = 4

    var body: some View {
        if !results.isEmpty {
            Button { open = true } label: { pills }
                .buttonStyle(.plain)
                .sheet(isPresented: $open) {
                    SourcesDrawer(cards: cards)
                    #if os(iOS)
                        .presentationDetents([.medium, .large])
                        .presentationDragIndicator(.visible)
                    #endif
                }
        }
    }

    private var pills: some View {
        HStack(spacing: 6) {
            HStack(spacing: -7) {
                ForEach(Array(results.prefix(Self.shown).enumerated()), id: \.offset) { _, item in
                    SourceThumb(item: item, isWeb: isWeb, side: 20)
                        .overlay(
                            RoundedRectangle(cornerRadius: 5)
                                .strokeBorder(theme.surface, lineWidth: 1.5)
                        )
                }
            }
            Text(L("sources.count", total))
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(theme.inkSoft)
            Image(systemName: "chevron.right")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(theme.inkMute)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }
}

/// The drawer: every source the search returned, at a size where the cover and
/// the matching passage are actually readable.
private struct SourcesDrawer: View {
    @Environment(\.mauriceTheme) private var theme
    @Environment(\.dismiss) private var dismiss
    let cards: [JSONValue]

    private var isWeb: Bool { cards.first?.string("origin") == "web" }
    private var results: [JSONValue] { SourcesCard.distinct(cards) }
    private var total: Int {
        let uncarried = cards.reduce(0) { $0 + max(0, $1.int("count") - ($1["results"]?.arrayValue ?? []).count) }
        return results.count + uncarried
    }

    /// What was actually asked. Several searches means several questions, and
    /// they are the honest account of how the answer was arrived at — worth a
    /// line each in the drawer, where there is room, and nowhere else.
    private var queries: [String] {
        var seen = Set<String>()
        return cards.map { $0.string("query") }.filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    private var headline: String {
        let key = isWeb ? "sources.web" : "sources.corpus"
        return total > results.count ? L("sources.more", L(key, results.count), total) : L(key, total)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if !queries.isEmpty {
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(queries, id: \.self) { query in
                                Text("« \(query) »")
                                    .font(.system(size: 13))
                                    .foregroundStyle(theme.inkMute)
                            }
                        }
                        .padding(.bottom, 2)
                    }
                    ForEach(Array(results.enumerated()), id: \.offset) { _, item in
                        SourceRow(item: item, isWeb: isWeb)
                    }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(theme.surface)
            .navigationTitle(headline)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L("common.done")) { dismiss() }.tint(theme.ink)
                }
            }
        }
    }
}

/// One source, full size. A web result is a link; a garden one shows the
/// passage that answered, having nowhere to open to.
private struct SourceRow: View {
    @Environment(\.mauriceTheme) private var theme
    let item: JSONValue
    let isWeb: Bool

    private var url: URL? {
        let raw = item.string("url")
        guard !raw.isEmpty else { return nil }
        return URL(string: raw)
    }

    var body: some View {
        if let url {
            Link(destination: url) { row }.buttonStyle(.plain)
        } else {
            row
        }
    }

    private var row: some View {
        HStack(alignment: .top, spacing: 10) {
            SourceThumb(item: item, isWeb: isWeb, side: 44)
            VStack(alignment: .leading, spacing: 4) {
                Text(item.string("title"))
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(theme.ink)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                if !subtitle.isEmpty {
                    HStack(spacing: 4) {
                        Text(subtitle)
                        if url != nil {
                            Image(systemName: "arrow.up.forward.square").font(.system(size: 9))
                        }
                    }
                    .font(.system(size: 11))
                    .foregroundStyle(theme.inkMute)
                }
                if !item.string("snippet").isEmpty {
                    Text(item.string("snippet"))
                        .font(.system(size: 12))
                        .foregroundStyle(theme.inkSoft)
                        .lineLimit(4)
                        .multilineTextAlignment(.leading)
                        .padding(.top, 1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(theme.inkMute.opacity(0.06)))
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
/// initial for the web, the icon of its nature for everything else. Square, so
/// the same view works as a 20-point pill and a 44-point thumbnail.
private struct SourceThumb: View {
    @Environment(\.mauriceTheme) private var theme
    @Environment(SessionStore.self) private var session
    let item: JSONValue
    let isWeb: Bool
    var side: CGFloat = 44

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
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: side > 28 ? 6 : 5))
    }

    /// No cover: a letter for a site, an icon for a kind of memory. Both beat
    /// an empty grey box at saying what you are about to open.
    private var mark: some View {
        ZStack {
            RoundedRectangle(cornerRadius: side > 28 ? 6 : 5).fill(theme.inkMute.opacity(0.15))
            if isWeb, let initial = item.string("subtitle").first {
                Text(String(initial).uppercased())
                    .font(.system(size: side * 0.5, weight: .semibold, design: .serif))
                    .foregroundStyle(theme.inkMute)
            } else {
                Image(systemName: Self.icons[item.string("kind")] ?? "doc")
                    .font(.system(size: side * 0.42))
                    .foregroundStyle(theme.inkMute)
            }
        }
    }
}
