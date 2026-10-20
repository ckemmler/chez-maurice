import SwiftUI

// What a conversation is worth keeping in your garden
// (server/src/services/entrySuggestions.ts, specs/carnet-suggestions.md).
//
// After each reply of a conversation you have alone with Maurice, the server
// names the works and people the exchange was about. They wait behind one mark
// in the conversation's header — the conversation's list, one row per subject
// — and nothing reaches the garden until you keep a row: the tap is the
// gesture that opens the entry and files what was said on it.

// MARK: - Model

struct EntrySuggestion: Decodable, Identifiable, Equatable {
    struct Candidate: Decodable, Identifiable, Equatable {
        let id: String
        let title: String
        let year: Int?
        let subtitle: String?
        let image: String?
    }

    let id: String
    let kind: String
    let title: String
    let year: Int?
    let subtitle: String?
    let image: String?
    let note: String
    let state: String
    /// Already an entry of yours: keeping it adds the note and nothing else.
    let existing: Bool
    /// Several possible identities: one must be picked to keep it.
    let candidates: [Candidate]
    /// The garden entry this is, `<collection>/<locale>/<slug>`, once there
    /// is one — what Carnet opens.
    let entry: String?
    /// Where the entry reads in your garden, once there is one.
    let web_path: String?
    /// The last term searched for it, once you asked for another look.
    let query: String?
    /// Whether another look makes sense: not for the conversation's own
    /// entry, nor for someone from your life, who is never looked up.
    let searchable: Bool?

    var isKept: Bool { state == "kept" }
}

private struct SuggestionList: Decodable {
    let suggestions: [EntrySuggestion]
    let pending: Int
    let kept: Int
}

private struct KeepBody: Encodable { let candidate: String?; let episodes: [String] }

/// A podcast's recent episodes, and the one Maurice reads the conversation as
/// being about (`GET /api/suggestions/:id/episodes`).
struct EpisodeList: Decodable, Equatable {
    struct Episode: Decodable, Identifiable, Equatable {
        let id: String
        let title: String
        let date: String?
        let description: String
        let image: String
        let duration: Int?
    }
    let feed: String
    let episodes: [Episode]
    let suggested: String?
}
private struct SearchBody: Encodable { let query: String? }
private struct SearchAnswer: Decodable { let found: Int }

// MARK: - The mark in the header

/// The Carnet mark: absent while the conversation offers nothing, carrying the
/// count of what waits, pulsing once when a turn adds an offer, and staying —
/// quiet — as the way back to what was kept. `inToolbar` draws a bare system
/// toolbar button (macOS, iPad) instead of the 44pt glyph of the iPhone capsule.
struct CarnetSuggestionsButton: View {
    @Environment(ChatService.self) private var chat
    @Environment(SessionStore.self) private var session
    @Environment(\.mauriceTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let conversation: ServerConversation
    var inToolbar = false
    @State private var showDrawer = false
    @State private var bumped = false

    private var count: SuggestionCount { chat.suggestionCount(for: conversation.id) }
    private var pulse: Int { reduceMotion ? 0 : (chat.suggestionPulse[conversation.id] ?? 0) }

    var body: some View {
        // Held from an entry, the drawer has it from the start, before
        // anything was offered.
        if !count.isEmpty || conversation.entry_ref != nil {
            Button { showDrawer = true } label: { label }
                .buttonStyle(.plain)
                .help(L("suggest.help"))
                .accessibilityLabel(count.pending > 0 ? L("suggest.a11y_pending", count.pending) : L("suggest.help"))
                .sheet(isPresented: $showDrawer) {
                    SuggestionsDrawer(conversationId: conversation.id)
                        #if os(iOS)
                        .presentationDetents([.medium, .large])
                        .presentationDragIndicator(.visible)
                        #else
                        .frame(minWidth: 440, minHeight: 420)
                        #endif
                }
        }
    }

    private var label: some View {
        HStack(spacing: 3) {
            // Carnet's pipe, cut from its app icon (Assets: CarnetPipe, a
            // template image): the two apps go together, and this is where
            // one hands over to the other.
            Image("CarnetPipe")
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: inToolbar ? 22 : 26)
                .scaleEffect(bumped ? 1.3 : 1)
                .onChange(of: pulse) { _, _ in
                    // One pulse, out and back.
                    withAnimation(.spring(duration: 0.25, bounce: 0.5)) { bumped = true }
                    withAnimation(.spring(duration: 0.4, bounce: 0.4).delay(0.25)) { bumped = false }
                }
            if count.pending > 0 {
                Text("\(count.pending)")
                    .font(.system(size: 12, weight: .semibold).monospacedDigit())
                    .contentTransition(.numericText())
            }
        }
        .foregroundStyle(count.pending > 0 ? theme.ink : theme.inkSoft)
        // In the iPhone capsule the mark is its first item: the pipe and its
        // count are wider than a 44pt glyph, so the air is asked for outright.
        // The toolbar's group (macOS, iPad) gives a plain button no inset of
        // its own either, so the pipe sat against the capsule's edge there too.
        .padding(.leading, inToolbar ? 10 : 16)
        .padding(.trailing, inToolbar ? 4 : 6)
        .frame(minWidth: inToolbar ? nil : 44, minHeight: inToolbar ? nil : 44)
        .contentShape(Rectangle())
        .animation(.default, value: count)
    }
}

// MARK: - The drawer

struct SuggestionsDrawer: View {
    @Environment(ChatService.self) private var chat
    @Environment(SessionStore.self) private var session
    @Environment(\.mauriceTheme) private var theme
    @Environment(\.dismiss) private var dismiss
    let conversationId: String

    @State private var rows: [EntrySuggestion] = []
    @State private var loaded = false
    @State private var failed = false

    private var pending: [EntrySuggestion] { rows.filter { !$0.isKept } }
    /// What was kept — but the entry the conversation is held from, which has
    /// its own row above.
    private var kept: [EntrySuggestion] { rows.filter { $0.isKept && $0.entry != held?.ref } }
    /// The entry the conversation is held from, when it is: the drawer's
    /// first row.
    private var held: ConversationEntry? {
        chat.activeConversationId == conversationId ? chat.activeEntry : nil
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if let held {
                        section(L("suggest.section_entry")) { HeldEntryRow(entry: held) }
                    }
                    if !pending.isEmpty {
                        section(L("suggest.section_pending")) {
                            ForEach(pending) { row in
                                SuggestionRow(row: row, onKeep: { await keep(row, candidate: $0, episodes: $1) },
                                              onEpisodes: { await episodes(row, feed: $0) },
                                              onSearch: { await search(row, query: $0) }, onDismiss: { dismissRow(row) })
                            }
                        }
                    }
                    if !kept.isEmpty {
                        section(L("suggest.section_kept")) {
                            ForEach(kept) { row in KeptRow(row: row) }
                        }
                    }
                    if loaded && rows.isEmpty && held == nil {
                        Text(L("suggest.empty"))
                            .font(.system(size: 14))
                            .foregroundStyle(theme.inkMute)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding(.top, 40)
                    }
                    if failed {
                        Text(L("suggest.failed")).font(.system(size: 12)).foregroundStyle(.red)
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(theme.surface)
            .navigationTitle(L("suggest.title"))
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L("common.done")) { dismiss() }.tint(theme.ink)
                }
            }
        }
        .task { await load() }
        // A turn that ends while the drawer is open adds its rows to it.
        .onChange(of: chat.suggestionCount(for: conversationId)) { _, _ in Task { await load() } }
    }

    private func section<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title.uppercased())
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(theme.inkMute)
            content()
        }
    }

    private var api: (client: APIClient, token: String)? {
        guard let base = session.serverURL, let token = session.tokenForActiveUser else { return nil }
        return (APIClient(baseURL: base), token)
    }

    private func load() async {
        guard let api else { return }
        do {
            let list: SuggestionList = try await api.client.get("/api/suggestions?conversation=\(conversationId)", token: api.token)
            rows = list.suggestions
            chat.suggestionCounts[conversationId] = SuggestionCount(pending: list.pending, kept: list.kept)
            failed = false
        } catch {
            failed = true
        }
        loaded = true
    }

    private func keep(_ row: EntrySuggestion, candidate: String?, episodes: [String]) async -> Bool {
        guard let api else { return false }
        do {
            let _: EntrySuggestion = try await api.client.post(
                "/api/suggestions/\(row.id)/keep", body: KeepBody(candidate: candidate, episodes: episodes), token: api.token, timeout: 40)
            // Linked to an entry (a shared article, a fiche in the context):
            // the conversation may be held from it now.
            if row.note.isEmpty { await chat.refreshActiveEntry() }
            await load()
            return true
        } catch {
            failed = true
            return false
        }
    }

    /// A podcast's episodes, for the show picked (`feed`) or the one the row
    /// already settled on. Nil when there is none to list.
    private func episodes(_ row: EntrySuggestion, feed: String?) async -> EpisodeList? {
        guard let api else { return nil }
        let query = feed.map { "?feed=\($0)" } ?? ""
        return try? await api.client.get("/api/suggestions/\(row.id)/episodes\(query)", token: api.token, timeout: 40)
    }

    /// Another look: `query` is your own term; without it Maurice rephrases
    /// the search. The number found, or nil when the call failed.
    private func search(_ row: EntrySuggestion, query: String?) async -> Int? {
        guard let api else { return nil }
        do {
            let answer: SearchAnswer = try await api.client.post(
                "/api/suggestions/\(row.id)/search", body: SearchBody(query: query), token: api.token, timeout: 40)
            await load()
            return answer.found
        } catch {
            failed = true
            return nil
        }
    }

    private func dismissRow(_ row: EntrySuggestion) {
        guard let api else { return }
        // Gone at once; the server's answer only confirms it.
        withAnimation { rows.removeAll { $0.id == row.id } }
        Task {
            do {
                let _: EntrySuggestion = try await api.client.post("/api/suggestions/\(row.id)/dismiss", body: [String: String](), token: api.token)
            } catch {
                failed = true
            }
            await load()
        }
    }
}

// MARK: - Rows

/// What a kind of entry is called, and the glyph that stands in for a cover.
private enum SuggestionKind {
    static func label(_ kind: String) -> String { L("suggest.kind.\(kind)") }
    static func symbol(_ kind: String) -> String {
        switch kind {
        case "movies": return "film"
        case "series": return "tv"
        case "books": return "book"
        case "music": return "music.note"
        case "podcasts": return "mic"
        case "games": return "gamecontroller"
        case "people": return "person"
        case "articles": return "doc.text"
        default: return "doc"
        }
    }
}

private struct SuggestionCover: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.mauriceTheme) private var theme
    let image: String?
    let kind: String
    var width: CGFloat = 46

    private var url: URL? {
        guard let image, !image.isEmpty else { return nil }
        if image.hasPrefix("http") { return URL(string: image) }
        guard let base = session.serverURL else { return nil }
        return URL(string: base + image)
    }

    /// A portrait for a person, a sleeve for an album, a poster otherwise.
    private var height: CGFloat { kind == "music" || kind == "podcasts" || kind == "people" ? width : width * 3 / 2 }

    var body: some View {
        Group {
            if let url {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let img): img.resizable().aspectRatio(contentMode: .fill)
                    default: placeholder
                    }
                }
            } else {
                placeholder
            }
        }
        .frame(width: width, height: height)
        .clipShape(kind == "people" ? AnyShape(Circle()) : AnyShape(RoundedRectangle(cornerRadius: 5)))
    }

    private var placeholder: some View {
        ZStack {
            theme.inkMute.opacity(0.12)
            Image(systemName: SuggestionKind.symbol(kind))
                .font(.system(size: width * 0.36))
                .foregroundStyle(theme.inkMute)
        }
    }
}

/// One line of identity under a title: kind, year, who made it.
private func identityLine(kind: String, year: Int?, subtitle: String?) -> String {
    var parts = [SuggestionKind.label(kind)]
    if let year { parts.append(String(year)) }
    if let subtitle, !subtitle.isEmpty { parts.append(subtitle) }
    return parts.joined(separator: " · ")
}

/// An offer: who or what it is, whether you already have it, the note that
/// would be filed — in full, so you read what is written before it is — and
/// one button. Several possible identities unfold into a pick first.
private struct SuggestionRow: View {
    @Environment(\.mauriceTheme) private var theme
    let row: EntrySuggestion
    let onKeep: (String?, [String]) async -> Bool
    let onEpisodes: (String?) async -> EpisodeList?
    let onSearch: (String?) async -> Int?
    let onDismiss: () -> Void

    @State private var working = false
    @State private var picked: String?
    /// For a podcast: the episodes ticked, in the order they were — none for
    /// the show itself.
    @State private var episodes: [String] = []
    @State private var searching = false
    @State private var refining = false
    @State private var term = ""
    /// What the last look came back with, when it found nothing.
    @State private var nothing: String?
    @FocusState private var termFocused: Bool

    private var needsPick: Bool { !row.candidates.isEmpty }
    private var canKeep: Bool { !needsPick || picked != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                SuggestionCover(image: row.image, kind: row.kind)
                VStack(alignment: .leading, spacing: 3) {
                    Text(row.title)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(theme.ink)
                    Text(identityLine(kind: row.kind, year: row.year, subtitle: row.subtitle))
                        .font(.system(size: 12))
                        .foregroundStyle(theme.inkSoft)
                    Text(row.existing ? L("suggest.state_existing") : needsPick ? L("suggest.state_pick", row.candidates.count) : L("suggest.state_new"))
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(theme.inkMute)
                        .padding(.top, 1)
                }
                Spacer(minLength: 4)
                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(theme.inkMute)
                        .frame(width: 30, height: 30)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L("suggest.dismiss"))
            }

            // The note, as it will read on the entry. A shared article has
            // none: keeping it saves the article.
            if !row.note.isEmpty {
                Text(row.note)
                    .font(.system(size: 14))
                    .foregroundStyle(theme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 8).fill(theme.inkMute.opacity(0.07)))
            }

            if needsPick { candidates }

            // A show: which episode? Listed once the show is settled — the
            // row's own, or the candidate picked.
            if row.kind == "podcasts", !needsPick || picked != nil {
                EpisodePicker(feed: needsPick ? picked : nil, onEpisodes: onEpisodes, selection: $episodes)
                    .id("\(row.candidates.map(\.id).joined(separator: ","))|\(picked ?? "")")
            }

            HStack(spacing: 10) {
                Button {
                    working = true
                    Task {
                        _ = await onKeep(picked, episodes)
                        working = false
                    }
                } label: {
                    Text(episodes.count > 1 ? L("suggest.keep_episodes", episodes.count)
                         : episodes.count == 1 ? L("suggest.keep_episode")
                         // No note to file: keeping says the conversation is
                         // about it — an entry in the context, a shared article.
                         : row.note.isEmpty ? (row.existing ? L("suggest.link_entry") : L("suggest.add_to_carnet"))
                         : row.existing ? L("suggest.add_note") : L("suggest.keep"))
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(theme.bg)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                        .background(Capsule().fill(theme.ink.opacity(canKeep ? 1 : 0.3)))
                }
                .buttonStyle(.plain)
                .disabled(working || !canKeep)
                if working { ProgressView().controlSize(.small) }
            }

            if row.searchable == true { lookAgain }
        }
        // One possibility is the one: picked at once, so a show lists its
        // episodes without a tap that says nothing.
        .onChange(of: row.candidates.map(\.id), initial: true) { _, ids in
            if ids.count == 1 { picked = ids[0] }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12).fill(theme.bg))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(theme.rule, lineWidth: 1))
    }

    /// Not the right one: Maurice looks again, or you say what to look for.
    private var lookAgain: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 16) {
                Button { Task { await search(nil) } } label: {
                    Label(L("suggest.search_again"), systemImage: "arrow.clockwise")
                }
                Button {
                    refining.toggle()
                    if refining {
                        term = row.query ?? row.title
                        termFocused = true
                    }
                } label: {
                    Label(L("suggest.search_refine"), systemImage: "magnifyingglass")
                }
                if searching { ProgressView().controlSize(.small) }
            }
            .buttonStyle(.plain)
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(theme.inkSoft)
            .disabled(searching || working)

            if refining {
                HStack(spacing: 8) {
                    TextField(L("suggest.search_placeholder"), text: $term)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 13))
                        .focused($termFocused)
                        .searchReturnKey(isEmpty: term.trimmingCharacters(in: .whitespaces).isEmpty,
                                         focus: $termFocused) { Task { await search(term) } }
                    Button(L("suggest.search_go")) { Task { await search(term) } }
                        .buttonStyle(.plain)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(theme.ink)
                        .disabled(searching || term.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }

            if let nothing {
                Text(nothing).font(.system(size: 11)).foregroundStyle(theme.inkMute)
            }
        }
    }

    private func search(_ query: String?) async {
        let typed = query?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let typed, typed.isEmpty { return }
        searching = true
        nothing = nil
        let found = await onSearch(typed)
        searching = false
        guard let found else { return }
        if found == 0 {
            nothing = typed.map { L("suggest.search_nothing", $0) } ?? L("suggest.search_nothing_new")
        } else {
            // A new list: the pick made on the old one no longer holds.
            picked = nil
            refining = false
        }
    }

    /// Which of these did the conversation mean?
    private var candidates: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(row.candidates) { c in
                Button { picked = c.id } label: {
                    HStack(spacing: 10) {
                        Image(systemName: picked == c.id ? "largecircle.fill.circle" : "circle")
                            .font(.system(size: 15))
                            .foregroundStyle(picked == c.id ? theme.ink : theme.inkMute)
                        SuggestionCover(image: c.image, kind: row.kind, width: 28)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(c.title).font(.system(size: 13, weight: .medium)).foregroundStyle(theme.ink)
                            Text([c.year.map(String.init), c.subtitle].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                                .font(.system(size: 11))
                                .foregroundStyle(theme.inkSoft)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }
}

/// A show's recent episodes, laid out as a podcast app lists them: the day
/// it came out, the title, what it is about, its length, and its art — the
/// one Maurice reads the conversation as being about ticked in advance. Each
/// is ticked on its own; none ticked leaves the show itself to be kept.
private struct EpisodePicker: View {
    @Environment(\.mauriceTheme) private var theme
    @Environment(SessionStore.self) private var session
    let feed: String?
    let onEpisodes: (String?) async -> EpisodeList?
    @Binding var selection: [String]

    @State private var list: EpisodeList?
    @State private var loading = true
    @State private var shown = 5

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if loading {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(L("suggest.episodes_loading")).font(.system(size: 12)).foregroundStyle(theme.inkMute)
                }
                .padding(.vertical, 6)
            } else if let list, !list.episodes.isEmpty {
                Text(L("suggest.episodes").uppercased())
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(theme.inkMute)
                    .padding(.bottom, 4)
                ForEach(Array(list.episodes.prefix(shown).enumerated()), id: \.element.id) { i, ep in
                    if i > 0 { Rectangle().fill(theme.rule).frame(height: 1) }
                    episodeRow(ep, suggested: ep.id == list.suggested)
                }
                if list.episodes.count > shown {
                    Button(L("suggest.episodes_more")) { withAnimation { shown += 10 } }
                        .buttonStyle(.plain)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(theme.inkSoft)
                        .padding(.top, 8)
                }
                Text(L("suggest.episodes_hint"))
                    .font(.system(size: 11))
                    .foregroundStyle(theme.inkMute)
                    .padding(.top, 6)
            }
        }
        .task {
            let got = await onEpisodes(feed)
            list = got
            if let got, let suggested = got.suggested, let at = got.episodes.firstIndex(where: { $0.id == suggested }) {
                selection = [suggested]
                shown = max(shown, at + 1)
            } else {
                selection = []
            }
            loading = false
        }
    }

    private func episodeRow(_ ep: EpisodeList.Episode, suggested: Bool) -> some View {
        let on = selection.contains(ep.id)
        return Button {
            if on { selection.removeAll { $0 == ep.id } } else { selection.append(ep.id) }
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: on ? "checkmark.square.fill" : "square")
                    .font(.system(size: 15))
                    .foregroundStyle(on ? theme.ink : theme.inkMute)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        if let when = Self.when(ep.date, locale: session.resolvedLocale) {
                            Text(when).font(.system(size: 11, weight: .semibold)).foregroundStyle(theme.inkMute)
                        }
                        if suggested {
                            Text(L("suggest.episode_suggested"))
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(theme.inkSoft)
                                .padding(.horizontal, 6).padding(.vertical, 1)
                                .background(Capsule().fill(theme.inkMute.opacity(0.12)))
                        }
                    }
                    Text(ep.title)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(theme.ink)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    if !ep.description.isEmpty {
                        Text(ep.description)
                            .font(.system(size: 12))
                            .foregroundStyle(theme.inkSoft)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                    if let length = Self.length(ep.duration) {
                        Text(length)
                            .font(.system(size: 11, weight: .semibold).monospacedDigit())
                            .foregroundStyle(theme.inkSoft)
                            .padding(.horizontal, 8).padding(.vertical, 2)
                            .background(Capsule().fill(theme.inkMute.opacity(0.1)))
                            .padding(.top, 2)
                    }
                }
                Spacer(minLength: 6)
                SuggestionCover(image: ep.image.isEmpty ? nil : ep.image, kind: "podcasts", width: 56)
            }
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// "il y a 20 h" within the week, the day otherwise — the year only when
    /// it is not this one.
    static func when(_ iso: String?, locale: Locale) -> String? {
        guard let iso else { return nil }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = parser.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return nil }
        if Date().timeIntervalSince(date) < 7 * 86_400 {
            let f = RelativeDateTimeFormatter()
            f.locale = locale
            f.unitsStyle = .short
            return f.localizedString(for: date, relativeTo: Date())
        }
        let sameYear = Calendar.current.isDate(date, equalTo: Date(), toGranularity: .year)
        let style = sameYear
            ? Date.FormatStyle(locale: locale).day().month(.abbreviated)
            : Date.FormatStyle(locale: locale).day().month(.abbreviated).year()
        return date.formatted(style)
    }

    /// "33 min", "1 h 5 min".
    static func length(_ seconds: Int?) -> String? {
        guard let seconds, seconds > 0 else { return nil }
        let f = DateComponentsFormatter()
        f.allowedUnits = seconds >= 3600 ? [.hour, .minute] : [.minute]
        f.unitsStyle = .short
        return f.string(from: TimeInterval(seconds))
    }
}

/// The entry the conversation is held from: its cover and title, opening it
/// in Carnet — or, where Carnet is not, its page in the garden.
private struct HeldEntryRow: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.mauriceTheme) private var theme
    let entry: ConversationEntry

    var body: some View {
        Button {
            Task { await open() }
        } label: {
            HStack(spacing: 12) {
                SuggestionCover(image: entry.image, kind: entry.collection, width: 32)
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.title).font(.system(size: 14, weight: .medium)).foregroundStyle(theme.ink)
                        .lineLimit(2)
                    Text(SuggestionKind.label(entry.collection))
                        .font(.system(size: 11))
                        .foregroundStyle(theme.inkSoft)
                }
                Spacer(minLength: 4)
                Image(systemName: "arrow.up.right").font(.system(size: 11, weight: .medium)).foregroundStyle(theme.inkMute)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    @MainActor
    private func open() async {
        #if os(iOS)
        if let url = URL(string: "carnet://entry/\(entry.ref)"), await UIApplication.shared.open(url) { return }
        #endif
        guard let path = entry.web_path else { return }
        await openInGarden(path, session: session)
    }
}

/// Kept: the entry, and the way to it in the garden.
private struct KeptRow: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.mauriceTheme) private var theme
    let row: EntrySuggestion

    var body: some View {
        Button {
            Task { await open() }
        } label: {
            HStack(spacing: 12) {
                SuggestionCover(image: row.image, kind: row.kind, width: 32)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title).font(.system(size: 14, weight: .medium)).foregroundStyle(theme.ink)
                    Text(identityLine(kind: row.kind, year: row.year, subtitle: nil))
                        .font(.system(size: 11))
                        .foregroundStyle(theme.inkSoft)
                }
                Spacer(minLength: 4)
                Image(systemName: "checkmark.circle.fill").font(.system(size: 13)).foregroundStyle(theme.inkMute)
                if row.web_path != nil {
                    Image(systemName: "arrow.up.right").font(.system(size: 11, weight: .medium)).foregroundStyle(theme.inkMute)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(row.web_path == nil)
    }

    /// In Carnet, where the entry lives on the phone — `carnet://entry/…`.
    /// The garden's page is the fallback: when Carnet is not installed, on
    /// the Mac (Carnet is iOS-only), and for a person, whom Carnet's list
    /// does not hold.
    @MainActor
    private func open() async {
        #if os(iOS)
        if row.kind != "people", let entry = row.entry, let url = URL(string: "carnet://entry/\(entry)"),
           await UIApplication.shared.open(url) {
            return
        }
        #endif
        guard let path = row.web_path else { return }
        await openInGarden(path, session: session)
    }
}
