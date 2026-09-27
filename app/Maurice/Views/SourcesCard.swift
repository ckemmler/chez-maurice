import SwiftUI

/// What a turn went and looked at — one line under the reply, and everything
/// behind it in a drawer when you tap it.
///
/// Both searches, the corpus and the web, send the same payload
/// (`card: "sources"`, built in `server/src/services/sourceCards.ts`): a title,
/// where it came from, an optional cover, and the passage that matched. Every
/// other tool that returns rows sends them bare.
///
/// The first version drew the sources as a scrolling row of cards, which took
/// more room under every reply than the reply itself; then as a row of pills
/// per place searched, with the other tools' results under a disclosure of
/// their own further down. Evidence should be *at hand*, not in the way: what
/// stays in the transcript is one line — the thumbnails and a tally, « 2
/// recherches web, 3 appels d'outils › » — and the rest lives one tap away.
struct TurnTally: Equatable {
    var web = 0
    var memory = 0
    var tools = 0

    /// From the steps when the turn was watched: they know every call,
    /// including the ones that returned nothing to draw. A thread reloaded
    /// from scratch has only the blocks — one `sources` payload per search,
    /// one block per call that returned rows.
    ///
    /// A live turn counts what is done; the call running is named beside the
    /// tally until it ends.
    init(steps: [ToolStep], blocks: [DataBlock], doneOnly: Bool = false) {
        if steps.isEmpty {
            for block in blocks {
                switch block.data.cardKind {
                case "sources": block.data.string("origin") == "web" ? (web += 1) : (memory += 1)
                // A purpose-built card is drawn under the reply already.
                case nil: tools += 1
                default: break
                }
            }
            return
        }
        for step in steps {
            let n = step.count - (doneOnly && step.running ? 1 : 0)
            switch step.tool {
            case "web_search": web += n
            case "corpus__search": memory += n
            default: tools += n
            }
        }
    }

    var isEmpty: Bool { web + memory + tools == 0 }

    var text: String {
        [("web", web), ("memory", memory), ("tools", tools)]
            .filter { $0.1 > 0 }
            .map { L("chat.tally.\($0.0).\($0.1 == 1 ? "one" : "other")", $0.1) }
            .joined(separator: ", ")
    }
}

/// A turn's searches, one group per place searched.
///
/// One search sends one `sources` payload, and a turn may run several: on
/// 21 September 2026 a question about three school apps ran six web searches
/// and two corpus ones, and the reply arrived under eight rows of pills. The
/// budget in `server/src/services/searchBudget.ts` caps how many a turn may
/// run; this is the other half — however many it ran, the same page found
/// twice is counted once, in the order the first search of each place ran.
enum TurnSources {
    static func byOrigin(_ blocks: [DataBlock]) -> [(origin: String, payloads: [JSONValue])] {
        var out: [(origin: String, payloads: [JSONValue])] = []
        for block in blocks where block.data.cardKind == "sources" {
            let origin = block.data.string("origin")
            if let i = out.firstIndex(where: { $0.origin == origin }) {
                out[i].payloads.append(block.data)
            } else {
                out.append((origin, [block.data]))
            }
        }
        return out
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

    /// The sources of every search of one place, in order, each one kept the
    /// first time it appears.
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
}

/// The thumbnails that lead the line: the first few sources the turn found,
/// every place searched together. Nothing when it searched nothing.
struct SourceStack: View {
    @Environment(\.mauriceTheme) private var theme
    let blocks: [DataBlock]

    /// How many thumbnails the stack shows; the drawer has the rest.
    private static let shown = 4

    private var items: [(item: JSONValue, isWeb: Bool)] {
        TurnSources.byOrigin(blocks).flatMap { group in
            TurnSources.distinct(group.payloads).map { ($0, group.origin == "web") }
        }
    }

    var body: some View {
        let items = items.prefix(Self.shown)
        if !items.isEmpty {
            HStack(spacing: -7) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, entry in
                    SourceThumb(item: entry.item, isWeb: entry.isWeb, side: 20)
                        .overlay(
                            RoundedRectangle(cornerRadius: 5)
                                .strokeBorder(theme.surface, lineWidth: 1.5)
                        )
                }
            }
        }
    }
}

/// The drawer: what the turn did, step by step, then every source each search
/// returned, then the rows the other tools handed back — at a size where the
/// cover, the matching passage and the fields are actually readable.
struct TurnDrawer: View {
    @Environment(\.mauriceTheme) private var theme
    @Environment(\.dismiss) private var dismiss
    let activity: TurnActivity
    let blocks: [DataBlock]

    private var sources: [(origin: String, payloads: [JSONValue])] { TurnSources.byOrigin(blocks) }
    private var toolBlocks: [DataBlock] { blocks.filter { $0.data.cardKind == nil } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if !activity.steps.isEmpty { steps }
                    ForEach(sources, id: \.origin) { group in
                        SourcesSection(cards: group.payloads)
                    }
                    if !toolBlocks.isEmpty { tools }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(theme.surface)
            .navigationTitle(L("chat.tally.title"))
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

    /// Every step on its own line, in the order the turn first took it.
    private var steps: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(activity.steps) { step in
                HStack(spacing: 6) {
                    Image(systemName: step.running ? "arrow.right" : "checkmark")
                        .font(.system(size: 9, weight: .semibold))
                        .frame(width: 12)
                    Text(step.name + (step.running ? "…" : ""))
                }
                .foregroundStyle(step.running ? theme.inkSoft : theme.inkMute)
            }
        }
        .font(.system(size: 13))
    }

    /// Each call's rows under the name of the tool that returned them.
    private var tools: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(L("chat.tally.toolsHeader"))
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(theme.ink)
            ForEach(Array(toolBlocks.enumerated()), id: \.offset) { _, block in
                VStack(alignment: .leading, spacing: 4) {
                    Text(blockTitle(block))
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(theme.inkMute)
                    DataBlockBody(data: block.data)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8).fill(theme.inkMute.opacity(0.06)))
            }
        }
    }
}

/// The searches of one place: the questions asked, then what they found.
private struct SourcesSection: View {
    @Environment(\.mauriceTheme) private var theme
    /// Every search of one origin made on this turn, in the order it ran them.
    let cards: [JSONValue]

    private var isWeb: Bool { cards.first?.string("origin") == "web" }
    private var results: [JSONValue] { TurnSources.distinct(cards) }
    /// The server caps the cards it sends but reports the true total, so the
    /// count is honest rather than quietly eighteen short. Across several
    /// searches: the distinct sources at hand, plus what each search said it
    /// had found and did not carry.
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
        VStack(alignment: .leading, spacing: 10) {
            Text(headline)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(theme.ink)
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
