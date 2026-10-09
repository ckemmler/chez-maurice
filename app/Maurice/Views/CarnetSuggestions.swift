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
    /// Where the entry reads in your garden, once there is one.
    let web_path: String?

    var isKept: Bool { state == "kept" }
}

private struct SuggestionList: Decodable {
    let suggestions: [EntrySuggestion]
    let pending: Int
    let kept: Int
}

private struct KeepBody: Encodable { let candidate: String? }

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
        if !count.isEmpty {
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
    private var kept: [EntrySuggestion] { rows.filter(\.isKept) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if !pending.isEmpty {
                        section(L("suggest.section_pending")) {
                            ForEach(pending) { row in
                                SuggestionRow(row: row, onKeep: { await keep(row, candidate: $0) }, onDismiss: { dismissRow(row) })
                            }
                        }
                    }
                    if !kept.isEmpty {
                        section(L("suggest.section_kept")) {
                            ForEach(kept) { row in KeptRow(row: row) }
                        }
                    }
                    if loaded && rows.isEmpty {
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

    private func keep(_ row: EntrySuggestion, candidate: String?) async -> Bool {
        guard let api else { return false }
        do {
            let _: EntrySuggestion = try await api.client.post("/api/suggestions/\(row.id)/keep", body: KeepBody(candidate: candidate), token: api.token)
            await load()
            return true
        } catch {
            failed = true
            return false
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
    let onKeep: (String?) async -> Bool
    let onDismiss: () -> Void

    @State private var working = false
    @State private var picked: String?

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

            // The note, as it will read on the entry.
            Text(row.note)
                .font(.system(size: 14))
                .foregroundStyle(theme.ink)
                .fixedSize(horizontal: false, vertical: true)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8).fill(theme.inkMute.opacity(0.07)))

            if needsPick { candidates }

            HStack(spacing: 10) {
                Button {
                    working = true
                    Task {
                        _ = await onKeep(picked)
                        working = false
                    }
                } label: {
                    Text(row.existing ? L("suggest.add_note") : L("suggest.keep"))
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
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12).fill(theme.bg))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(theme.rule, lineWidth: 1))
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

/// Kept: the entry, and the way to it in the garden.
private struct KeptRow: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.mauriceTheme) private var theme
    let row: EntrySuggestion

    var body: some View {
        Button {
            guard let path = row.web_path else { return }
            Task { await openInGarden(path, session: session) }
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
}
