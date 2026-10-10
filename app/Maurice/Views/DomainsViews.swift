import SwiftUI

// MARK: - Domains
//
// One Maurice. What used to be the Studio — a picker of personas to summon,
// each with a hat — is now the list of the member's **domains**, each opening
// its page with the brief Maurice keeps on it (DomainBriefView.swift), and
// their **reading companions**, each opening its pinned conversation; Maurice
// Maurice stays on the list while he is still a persona (until the
// documentation tool replaces him). This file holds the shared UI state, the
// mark that stands where a hat used to, the list sheet, and the greeting of a
// conversation bound to a domain. The editor lives in DomainEditorView.swift.

/// Shared UI state: which sheet is open — the list, a domain's page, the editor.
@Observable @MainActor
final class DomainsState {
    var showList = false

    /// The domain being created/edited; nil = editor closed.
    var draft: Maurice?
    var draftIsEdit = false

    /// The domain whose page (brief) is open; nil = closed.
    var briefFor: Maurice?

    func openList() { showList = true }

    func openBrief(_ maurice: Maurice) {
        briefFor = maurice
        showList = false
    }

    /// Open the editor. The list and the page are sheets too, so when one of
    /// them is up it is dismissed first and the editor presented once the
    /// dismissal has settled (a sheet presented mid-dismiss is dropped).
    func openEditor(_ maurice: Maurice?, isEdit: Bool) {
        let wasUp = showList || briefFor != nil
        showList = false
        briefFor = nil
        let next = maurice ?? Maurice.blank()
        if wasUp {
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(0.35))
                draft = next
                draftIsEdit = isEdit
            }
        } else {
            draft = next
            draftIsEdit = isEdit
        }
    }

    func closeEditor() { draft = nil }

    /// Back out of the editor to the list — not all the way out to the chat.
    func backToList() {
        draft = nil
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(0.35))
            showList = true
        }
    }
}

// MARK: - Creativity / pills helpers

/// Maps a 0…1 temperature to the design's label.
func creativityLabel(_ temp: Double) -> String {
    if temp <= 0.3 { return L("persona.creativity.precise") }
    if temp >= 0.75 { return L("persona.creativity.creative") }
    return L("persona.creativity.balanced")
}

/// The domain's reasoning choice as a label; nil = the provider's default.
func reasoningLabel(_ thinking: Bool?) -> String {
    switch thinking {
    case .some(true): return L("persona.reasoning.on")
    case .some(false): return L("persona.reasoning.off")
    case .none: return L("persona.reasoning.auto")
    }
}

/// A small mono pill used in greetings and previews.
struct InfoPill: View {
    @Environment(\.mauriceTheme) private var theme
    let icon: String
    let text: String
    var tint: Color? = nil

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: icon).font(.system(size: 9))
            Text(text).font(.system(size: 10, design: .monospaced))
        }
        .foregroundStyle(tint ?? theme.inkSoft)
        .padding(.horizontal, 9).padding(.vertical, 5)
        .overlay(Capsule().strokeBorder(theme.ruleHard, lineWidth: 0.5))
    }
}

// MARK: - The mark

/// What stands where a hat used to: a glyph on the member's accent — a closed
/// book for a domain, open pages for a reading companion. Nothing for the
/// everyday Maurice (he needs no badge).
struct DomainMark: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.mauriceTheme) private var theme
    let maurice: Maurice
    var size: CGFloat = 30
    var radius: CGFloat? = nil

    var body: some View {
        let accent = session.activeDeviceUser?.color ?? .blue
        let ink = accent.legible(onDark: theme.isDark)
        RoundedRectangle(cornerRadius: radius ?? (size * 0.28), style: .continuous)
            .fill(accent.opacity(0.14))
            .frame(width: size, height: size)
            .overlay {
                Image(systemName: maurice.symbol)
                    .font(.system(size: size * 0.42, weight: .medium))
                    .foregroundStyle(ink)
            }
            .overlay(
                RoundedRectangle(cornerRadius: radius ?? (size * 0.28), style: .continuous)
                    .strokeBorder(theme.ruleHard, lineWidth: 0.5)
            )
    }
}

// MARK: - The icons

/// The symbols a domain can wear. The same short list the server's night
/// chooses from (`services/domainIcons.ts`), in the same order — the editor
/// offers it to the member, whose choice prevails.
enum DomainIcons {
    static let fallback = "book.closed"

    static let all: [String] = [
        "cross.case", "brain.head.profile", "moon.zzz", "figure.run", "figure.pool.swim", "bicycle",
        "figure.mind.and.body", "mountain.2", "fork.knife", "wineglass", "leaf", "pawprint",
        "house", "hammer", "building.2", "building.columns", "banknote", "briefcase",
        "lightbulb", "megaphone", "chevron.left.forwardslash.chevron.right", "server.rack", "cpu", "graduationcap",
        "character.book.closed", "books.vertical", "pencil.and.outline", "text.quote", "clock.arrow.circlepath", "atom",
        "music.note", "guitars", "pianokeys", "paintpalette", "camera", "film",
        "theatermasks", "gamecontroller", "airplane", "car", "sailboat", "globe.europe.africa",
        "person.2", "figure.2.and.child.holdinghands", "heart", "sparkles", "envelope", "cart",
        "tshirt", "calendar", "trophy", "bolt", "shield", "newspaper",
    ]

    /// Whether this system has a glyph by that name.
    static func exists(_ symbol: String) -> Bool {
        #if os(macOS)
        NSImage(systemSymbolName: symbol, accessibilityDescription: nil) != nil
        #else
        UIImage(systemName: symbol) != nil
        #endif
    }
}

// MARK: - The pastilles

/// One mark beside the back button, and why it is there.
struct DomainPastille: Identifiable, Equatable {
    enum Kind: Equatable {
        /// The conversation is bound to the domain (`auto`: the night filed it).
        case bound(auto: Bool)
        /// Maurice read its brief on the way.
        case read
        /// The server recognised the domain in what the member said; nothing
        /// was read, nothing is bound.
        case recognised
    }
    let maurice: Maurice
    let kind: Kind
    var id: String { maurice.id }
}

/// The domains a conversation has to do with, as round marks beside the back
/// button: the one it is bound to, each one whose brief Maurice read on the
/// way (the `domain_brief` tool's data, kept on the reply), and the one the
/// server recognised in the member's last turns (`domain_recognised`, drawn
/// with a dashed ring: recognised is not read). A tap opens a short menu:
/// the domain's page, and binding the conversation to it or taking it out.
struct DomainPastilles: View {
    @Environment(ChatService.self) private var chat
    @Environment(MauriceStore.self) private var store
    @Environment(SessionStore.self) private var session
    @Environment(DomainsState.self) private var domains
    @Environment(\.mauriceTheme) private var theme
    var size: CGFloat = 30
    /// More than this many and the rest fold into a "+N" menu.
    var max = 4
    /// iPhone: the marks float over the stream, on their own glass.
    var glass = false

    /// The member's own domains this conversation has to do with, in the
    /// order they came in. Only their own: a brief is its creator's, and so
    /// is the page a pastille opens.
    @MainActor
    static func mobilised(chat: ChatService, store: MauriceStore, session: SessionStore) -> [DomainPastille] {
        let own = store.domains.filter { $0.isDomain(of: session.activeUserId) }
        guard !own.isEmpty else { return [] }
        var out: [DomainPastille] = []
        func add(_ m: Maurice?, _ kind: DomainPastille.Kind) {
            guard let m, !out.contains(where: { $0.maurice.id == m.id }) else { return }
            out.append(DomainPastille(maurice: m, kind: kind))
        }
        func domain(of block: DataBlock) -> Maurice? {
            // Replies older than the id in the payload carry the name only.
            let id = block.data["domain_id"]?.stringValue
            let name = block.data["domain"]?.stringValue
            return own.first { $0.rawId == id } ?? own.first { $0.name == name }
        }
        if let convo = chat.activeConversation, let bound = convo.maurice_id {
            add(own.first { $0.rawId == bound }, .bound(auto: convo.maurice_bound_by == "auto"))
        }
        let blocks = chat.messages.flatMap { $0.data ?? [] } + chat.streamingData
        for block in blocks where block.tool == "domain_brief" { add(domain(of: block), .read) }
        // Only the latest recognition: what the conversation is about now.
        if let last = blocks.last(where: { $0.tool == "domain_recognised" }) { add(domain(of: last), .recognised) }
        return out
    }

    var body: some View {
        let all = Self.mobilised(chat: chat, store: store, session: session)
        if !all.isEmpty {
            let shown = Array(all.prefix(max))
            let rest = Array(all.dropFirst(max))
            let row = HStack(spacing: 5) {
                ForEach(shown) { p in
                    Menu { actions(p) } label: {
                        mark(p).contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .help(label(p))
                    .accessibilityLabel(label(p))
                }
                if !rest.isEmpty {
                    Menu {
                        ForEach(rest) { p in
                            Menu { actions(p) } label: { Label(p.maurice.name, systemImage: p.maurice.symbol) }
                        }
                    } label: {
                        Text("+\(rest.count)")
                            .font(.system(size: size * 0.38, weight: .medium))
                            .foregroundStyle(theme.inkSoft)
                            .frame(minWidth: size, minHeight: size)
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .menuIndicator(.hidden)
                    .fixedSize()
                }
            }
            .animation(.easeOut(duration: 0.2), value: all)
            if glass {
                row.padding(.horizontal, 7).frame(height: 44)
                    .glassControl(theme, in: Capsule())
            } else {
                row
            }
        }
    }

    /// The mark: full for a bound domain and a brief read, a dashed ring and
    /// a paler glyph for one only recognised.
    @ViewBuilder
    private func mark(_ p: DomainPastille) -> some View {
        if p.kind == .recognised {
            let accent = session.activeDeviceUser?.color ?? .blue
            Circle()
                .strokeBorder(accent.legible(onDark: theme.isDark).opacity(0.7), style: StrokeStyle(lineWidth: 1, dash: [3, 2.5]))
                .frame(width: size, height: size)
                .overlay {
                    Image(systemName: p.maurice.symbol)
                        .font(.system(size: size * 0.42, weight: .medium))
                        .foregroundStyle(accent.legible(onDark: theme.isDark).opacity(0.75))
                }
        } else {
            DomainMark(maurice: p.maurice, size: size, radius: size / 2)
        }
    }

    private func label(_ p: DomainPastille) -> String {
        switch p.kind {
        case .bound(let auto): return String(format: session.localized(auto ? "pastille.bound.auto" : "pastille.bound"), p.maurice.name)
        case .read: return String(format: session.localized("pastille.read"), p.maurice.name)
        case .recognised: return String(format: session.localized("pastille.recognised"), p.maurice.name)
        }
    }

    @ViewBuilder
    private func actions(_ p: DomainPastille) -> some View {
        Section(label(p)) {
            Button { domains.openBrief(p.maurice) } label: {
                Label(session.localized("pastille.open"), systemImage: "book.closed")
            }
            // Binding is the member's own conversation's business, not a room's.
            if chat.participants.count <= 1, let id = chat.activeConversationId {
                if case .bound = p.kind {
                    Button(role: .destructive) { Task { await chat.setDomain(nil, forConversation: id) } } label: {
                        Label(session.localized("pastille.detach"), systemImage: "link.badge.minus")
                    }
                } else {
                    Button { Task { await chat.setDomain(p.maurice.rawId, forConversation: id) } } label: {
                        Label(session.localized("pastille.attach"), systemImage: "link.badge.plus")
                    }
                }
            }
        }
    }
}

// MARK: - The list

/// The member's domains and reading companions. A domain of the member's own
/// opens its page; a domain shared with a guest or a companion opens a
/// conversation bound to it. Questions about Maurice himself need no entry
/// here: the everyday Maurice answers them from his documentation tool.
struct DomainsListSheet: View {
    @Environment(MauriceStore.self) private var store
    @Environment(DomainsState.self) private var domains
    @Environment(ChatService.self) private var chat
    @Environment(SessionStore.self) private var session
    @Environment(\.mauriceTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    /// Called after a conversation is opened, so the compact layout can slide
    /// from the sidebar to the chat.
    var onOpen: () -> Void = {}

    /// The open proposals beyond the first few, and the ones put away, stay
    /// folded until asked for.
    @State private var showAllProposals = false
    @State private var showSettled = false
    private let proposalsShown = 5

    private var accent: Color { session.activeDeviceUser?.color ?? .blue }
    /// What was put away — by the member, or by the old six-week rule — and
    /// can come back. An adopted proposal is a domain above.
    private var putAway: [DomainProposal] { chat.settledProposals.filter(\.canRestore) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    if store.domains.isEmpty && store.companions.isEmpty && chat.openProposals.isEmpty {
                        Text(session.localized("domains.empty"))
                            .font(.system(size: 13)).foregroundStyle(theme.inkSoft)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.bottom, 6)
                    }

                    // What the night proposed and the member has not settled:
                    // here, and nowhere else.
                    if !chat.openProposals.isEmpty {
                        sectionHead(String(format: session.localized("proposals.section"), chat.openProposals.count))
                        Text(session.localized("proposals.rule"))
                            .font(.system(size: 12)).foregroundStyle(theme.inkMute)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.horizontal, 4).padding(.bottom, 2)
                        let rows = showAllProposals ? chat.openProposals : Array(chat.openProposals.prefix(proposalsShown))
                        ForEach(rows) { p in
                            NavigationLink(value: p) {
                                ProposalListRow(proposal: p, accent: accent)
                            }
                            .buttonStyle(.plain)
                            .contextMenu {
                                Button { Task { await quick(p, "adopt") } } label: {
                                    Label(session.localized("proposals.adopt"), systemImage: "checkmark")
                                }
                                Button(role: .destructive) { Task { await quick(p, "dismiss") } } label: {
                                    Label(session.localized("proposals.dismiss"), systemImage: "xmark")
                                }
                            }
                        }
                        if chat.openProposals.count > proposalsShown {
                            foldButton(showAllProposals ? session.localized("proposals.show_less")
                                       : String(format: session.localized("proposals.show_all"), chat.openProposals.count),
                                       open: showAllProposals) { showAllProposals.toggle() }
                        }
                        Color.clear.frame(height: 6)
                    }

                    if !store.domains.isEmpty {
                        sectionHead(session.localized("domains.section.domains"))
                        ForEach(store.domains) { d in
                            DomainListRow(maurice: d, subtitle: subtitle(for: d)) { open(d) }
                        }
                    }

                    if !store.companions.isEmpty {
                        sectionHead(session.localized("domains.section.companions")).padding(.top, 8)
                        ForEach(store.companions) { c in
                            DomainListRow(maurice: c, subtitle: session.localized("domains.companion.hint")) { open(c) }
                        }
                    }

                    // Until Maurice proposes domains from the conversations
                    // himself, a member adds one by hand.
                    if session.activeDeviceUser?.role != "guest" {
                        Button { domains.openEditor(nil, isEdit: false) } label: {
                            HStack(spacing: 10) {
                                Image(systemName: "plus").font(.system(size: 13))
                                Text(session.localized("domains.new")).font(.system(size: 14))
                                Spacer()
                            }
                            .foregroundStyle(theme.inkSoft)
                            .padding(.horizontal, 14).padding(.vertical, 12)
                            .background(RoundedRectangle(cornerRadius: 12).strokeBorder(theme.ruleHard, style: StrokeStyle(lineWidth: 0.5, dash: [4, 3])))
                        }
                        .buttonStyle(.plain)
                        .padding(.top, 10)
                    }

                    Text(session.localized("domains.explainer"))
                        .font(.system(size: 12)).foregroundStyle(theme.inkMute)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 10)

                    // What was put away does not come back by itself; the
                    // member can come back on it.
                    if !putAway.isEmpty {
                        foldButton(String(format: session.localized("proposals.put_away"), putAway.count), open: showSettled) { showSettled.toggle() }
                            .padding(.top, 10)
                        if showSettled {
                            ForEach(putAway) { p in
                                HStack(spacing: 10) {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(p.name).font(.system(size: 14)).foregroundStyle(theme.inkSoft).lineLimit(1)
                                        Text(proposalNumbers(p, session: session))
                                            .font(.system(size: 10.5, design: .monospaced)).foregroundStyle(theme.inkMute).lineLimit(1)
                                    }
                                    Spacer(minLength: 6)
                                    Button(session.localized("proposals.restore")) { Task { _ = await chat.restoreProposal(p.id) } }
                                        .font(.system(size: 12)).tint(accent)
                                }
                                .padding(.horizontal, 12).padding(.vertical, 8)
                                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(theme.ruleHard, lineWidth: 0.5))
                            }
                        }
                    }
                }
                .padding(18)
            }
            .background(theme.surface)
            .navigationDestination(for: DomainProposal.self) { p in
                ProposalPage(proposal: p)
            }
            .navigationTitle(session.localized("domains.title"))
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(session.localized("common.done")) { dismiss() }.tint(theme.ink)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 460, idealWidth: 520, minHeight: 420, idealHeight: 600)
        #endif
        .task {
            await store.loadOverview()
            // Read the list, then say it was seen: the rows keep their "new"
            // mark for this visit, the badge on the button goes.
            await chat.loadProposals()
            await chat.markProposalsSeen()
        }
    }

    /// Adopt or put away from the row's menu, without opening the page.
    private func quick(_ p: DomainProposal, _ action: String) async {
        let r = await chat.applyProposals([DomainProposalApplyItem(id: p.id, action: action, name: nil, summary: nil, seed: false)])
        if r?.adopted.isEmpty == false {
            await store.loadMaurices()
            await store.loadOverview()
        }
    }

    private func foldButton(_ label: String, open: Bool, action: @escaping () -> Void) -> some View {
        Button { withAnimation(.easeInOut(duration: 0.18)) { action() } } label: {
            HStack(spacing: 6) {
                Image(systemName: open ? "chevron.down" : "chevron.right").font(.system(size: 9, weight: .semibold))
                Text(label).font(.system(size: 12))
                Spacer()
            }
            .foregroundStyle(theme.inkSoft)
            .padding(.horizontal, 4).padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func sectionHead(_ label: String) -> some View {
        Text(label)
            .font(.system(size: 10, design: .monospaced)).tracking(1.1).textCase(.uppercase)
            .foregroundStyle(theme.inkMute)
            .padding(.horizontal, 4).padding(.bottom, 2)
    }

    /// What the row says under a domain's name: the brief's age and hand, or
    /// that there is none yet; for a guest, that it was shared with them.
    private func subtitle(for d: Maurice) -> String {
        guard d.isDomain(of: session.activeUserId) else { return session.localized("domains.shared.hint") }
        guard let o = store.overview[d.id], let at = o.briefUpdatedAt else { return session.localized("domains.no_brief") }
        let age = gardenAge(at, session: session)
        let when = age.isEmpty ? (parseServerDate(at)?.formatted(date: .abbreviated, time: .omitted) ?? at) : age
        return String(format: session.localized(o.briefByMember ? "domains.brief.by_you" : "domains.brief.by_maurice"), when)
    }

    private func open(_ m: Maurice) {
        if m.isDomain(of: session.activeUserId) {
            domains.openBrief(m)
            return
        }
        // A companion resumes its pinned conversation; anything else without
        // a page (a shared domain) starts one bound to it.
        Task {
            if m.isCompanion, let cid = store.overview[m.id]?.conversationId {
                await chat.selectConversation(cid)
            } else {
                await chat.createConversation(mauriceId: m.rawId, force: true)
            }
            dismiss()
            onOpen()
        }
    }
}

/// One row of the list: the mark, the name, a line under it, a chevron.
private struct DomainListRow: View {
    @Environment(\.mauriceTheme) private var theme
    let maurice: Maurice
    let subtitle: String
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                DomainMark(maurice: maurice, size: 36)
                VStack(alignment: .leading, spacing: 2) {
                    Text(maurice.name)
                        .font(.system(size: 15, weight: .medium)).foregroundStyle(theme.ink).lineLimit(1)
                    Text(subtitle.isEmpty ? maurice.tagline : subtitle)
                        .font(.system(size: 11.5)).foregroundStyle(theme.inkSoft).lineLimit(2)
                }
                Spacer(minLength: 6)
                Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(theme.inkMute)
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(RoundedRectangle(cornerRadius: 12).fill(theme.bg))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(theme.ruleHard, lineWidth: 0.5))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Conversation greeting for a bound domain

/// The empty-state greeting shown when a conversation is bound to a domain or
/// a reading companion: the mark, the name and tagline, the model / context /
/// creativity pills, and the way to the page and the editor.
struct DomainGreeting: View {
    @Environment(MauriceStore.self) private var store
    @Environment(DomainsState.self) private var domains
    @Environment(SessionStore.self) private var session
    @Environment(\.mauriceTheme) private var theme
    let maurice: Maurice

    var body: some View {
        VStack(spacing: 16) {
            Spacer()

            DomainMark(maurice: maurice, size: 72)

            VStack(spacing: 6) {
                Text(session.localized(maurice.isCompanion ? "domains.kicker.companion" : "domains.kicker.domain"))
                    .font(.system(size: 9, design: .monospaced)).tracking(0.8)
                    .foregroundStyle(theme.inkMute)
                Text(maurice.name)
                    .font(.system(size: 30, design: .serif))
                    .foregroundStyle(theme.ink)
                    .multilineTextAlignment(.center)
            }

            if !maurice.tagline.isEmpty {
                Text(maurice.tagline)
                    .font(.system(size: 14))
                    .foregroundStyle(theme.inkSoft)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 48)
            }

            FlowLayout(spacing: 8) {
                InfoPill(icon: store.model(for: maurice.model)?.isLocal == true ? "lock.shield" : "cloud",
                         text: store.modelName(for: maurice))
                if maurice.count > 0 {
                    InfoPill(icon: "doc.text",
                             text: "\(String(format: maurice.count == 1 ? session.localized("persona.preview.sources.one") : session.localized("persona.preview.sources.other"), maurice.count, fmtTok(maurice.weight)))")
                }
                InfoPill(icon: "dial.medium", text: creativityLabel(maurice.temp))
                // Only a choice worth a word: the provider's default says nothing.
                if let thinking = maurice.thinking, store.model(for: maurice.model)?.thinkingIsOptional == true {
                    InfoPill(icon: thinking ? "brain" : "bolt", text: reasoningLabel(thinking))
                }
            }
            .fixedSize(horizontal: true, vertical: false)

            if maurice.isEditable {
                HStack(spacing: 8) {
                    if maurice.isDomain(of: session.activeUserId) {
                        greetingButton("book.closed", session.localized("brief.open")) { domains.openBrief(maurice) }
                    }
                    if maurice.createdBy == session.activeUserId {
                        greetingButton("pencil", session.localized("domain.edit")) { domains.openEditor(maurice, isEdit: true) }
                    }
                }
                .padding(.top, 2)
            }

            Spacer()
        }
        .frame(maxWidth: .infinity)
    }

    private func greetingButton(_ icon: String, _ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: icon).font(.system(size: 11))
                Text(label).font(.system(size: 11, design: .monospaced))
            }
            .foregroundStyle(theme.inkMute)
            .padding(.horizontal, 12).padding(.vertical, 6)
            .overlay(Capsule().strokeBorder(theme.ruleHard, lineWidth: 0.5))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Proposals (10 October 2026)
//
// What the night proposes lives in the list above, as a section of its own —
// until then it lived in a conversation Maurice opened, and a proposal made
// three weeks later was a line in a thread nobody read. A row says what the
// proposal is and what it weighs; its page is where the member decides, once
// per proposal, conversations and mail together: adopt it (with or without
// notes in the garden — a yes to the domain is not a yes to the notes),
// correct its name or its paragraph, merge it with others, cut a part out of
// it, or put it away. Nothing is said in any conversation; the list is the
// record.

/// "12 conversations · 30 mail threads · 3 % · 4 recent", in the member's language.
@MainActor
func proposalNumbers(_ p: DomainProposal, session: SessionStore) -> String {
    var bits: [String] = []
    let mail = p.mail_threads ?? 0
    if p.conversations > 0 || mail == 0 {
        bits.append(String(format: session.localized(p.conversations == 1 ? "proposals.conversations.one" : "proposals.conversations.other"), p.conversations))
    }
    if mail > 0 { bits.append(String(format: session.localized(mail == 1 ? "proposals.mail.one" : "proposals.mail.other"), mail)) }
    if let r = p.recent_90_days, r > 0 { bits.append(String(format: session.localized("proposals.recent"), r)) }
    if !p.isAlive, let to = p.to { bits.append(String(format: session.localized("proposals.quiet_since"), String(to.prefix(7)))) }
    if let at = p.created_at, let day = parseServerDate(at) { bits.append(day.formatted(date: .abbreviated, time: .omitted)) }
    return bits.joined(separator: " · ")
}

/// One open proposal in the list.
private struct ProposalListRow: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.mauriceTheme) private var theme
    let proposal: DomainProposal
    let accent: Color

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(dots(proposal.weight))
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(proposal.isAlive ? accent.legible(onDark: theme.isDark) : theme.inkMute)
                .frame(width: 36, height: 36)
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(theme.ruleHard, style: StrokeStyle(lineWidth: 0.5, dash: [3, 2.5])))
                .accessibilityLabel(String(format: session.localized("proposals.weight"), proposal.weight, 5))
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(proposal.name)
                        .font(.system(size: 15, weight: .medium)).foregroundStyle(theme.ink).lineLimit(1)
                    if proposal.is_new == true {
                        Circle().fill(accent).frame(width: 6, height: 6)
                            .accessibilityLabel(session.localized("proposals.new"))
                    }
                }
                if let line = proposal.one_line, !line.isEmpty {
                    Text(line).font(.system(size: 11.5)).foregroundStyle(theme.inkSoft).lineLimit(2)
                }
                Text(proposalNumbers(proposal, session: session))
                    .font(.system(size: 10.5, design: .monospaced)).foregroundStyle(theme.inkMute).lineLimit(1)
            }
            Spacer(minLength: 6)
            Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(theme.inkMute)
                .padding(.top, 12)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 12).fill(theme.bg))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(theme.ruleHard, lineWidth: 0.5))
        .contentShape(Rectangle())
    }

    private func dots(_ w: Int) -> String {
        let n = max(0, min(5, w))
        return String(repeating: "●", count: n) + String(repeating: "○", count: 5 - n)
    }
}

/// A proposal's page: what it is, what it holds, and the member's decision.
private struct ProposalPage: View {
    @Environment(ChatService.self) private var chat
    @Environment(MauriceStore.self) private var store
    @Environment(SessionStore.self) private var session
    @Environment(\.mauriceTheme) private var theme
    @Environment(\.dismiss) private var dismiss
    let proposal: DomainProposal

    @State private var name = ""
    @State private var summary = ""
    @State private var seed = false
    @State private var detail: DomainProposalDetail?
    @State private var working = false
    @State private var failed = false
    @State private var mode: Mode = .view
    /// Merge: the other proposals that join this one. Cut: what leaves it.
    @State private var picked = Set<String>()
    @State private var partName = ""

    enum Mode { case view, merge, cut }

    private var accent: Color { session.activeDeviceUser?.color ?? .blue }
    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedSummary: String { summary.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var renamed: Bool { !trimmedName.isEmpty && trimmedName != proposal.name }
    private var resummarised: Bool { !trimmedSummary.isEmpty && trimmedSummary != proposal.summary }
    private var others: [DomainProposal] { chat.openProposals.filter { $0.id != proposal.id } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                switch mode {
                case .view: decide
                case .merge: merge
                case .cut: cut
                }
                if failed {
                    Text(session.localized("proposals.failed"))
                        .font(.system(size: 12)).foregroundStyle(Color(hex: "a6452e"))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(18)
        }
        .background(theme.surface)
        .navigationTitle(session.localized("proposals.page.title"))
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .disabled(working)
        .task {
            name = proposal.name
            summary = proposal.summary
            detail = await chat.proposalDetail(proposal.id)
        }
    }

    // MARK: the decision

    @ViewBuilder
    private var decide: some View {
        Text(proposalNumbers(proposal, session: session))
            .font(.system(size: 11, design: .monospaced)).foregroundStyle(theme.inkMute)
        TextField(session.localized("proposals.name"), text: $name)
            .textFieldStyle(.plain)
            .font(.system(size: 22, design: .serif)).foregroundStyle(theme.ink)
        TextField(session.localized("proposals.summary"), text: $summary, axis: .vertical)
            .textFieldStyle(.plain).lineLimit(2...10)
            .font(.system(size: 14)).foregroundStyle(theme.inkSoft)
        if let hint = proposal.split_hint, !hint.isEmpty {
            Text(String(format: session.localized("proposals.split_hint"), hint))
                .font(.system(size: 12)).italic().foregroundStyle(theme.inkMute)
                .fixedSize(horizontal: false, vertical: true)
        }

        Toggle(isOn: $seed) {
            Text(session.localized("proposals.seed")).font(.system(size: 13)).foregroundStyle(theme.inkSoft)
        }
        .toggleStyle(.switch).tint(accent)

        Button { Task { await apply("adopt") } } label: {
            Text(session.localized("proposals.adopt")).font(.system(size: 15, weight: .medium))
                .frame(maxWidth: .infinity).padding(.vertical, 8)
        }
        .glassProminentButton().tint(accent)

        HStack(spacing: 8) {
            if renamed || resummarised {
                chip("checkmark", session.localized("common.save")) { Task { await apply("keep") } }
            }
            if !others.isEmpty {
                chip("arrow.triangle.merge", session.localized("proposals.merge")) { picked = []; mode = .merge }
            }
            if (detail?.conversations_list?.count ?? 0) + (detail?.mail_list?.count ?? 0) > 1 {
                chip("scissors", session.localized("proposals.cut")) { picked = []; partName = ""; mode = .cut }
            }
            chip("xmark", session.localized("proposals.dismiss"), tint: Color(hex: "a6452e")) { Task { await apply("dismiss") } }
        }
        Text(session.localized("proposals.dismiss.hint"))
            .font(.system(size: 11)).foregroundStyle(theme.inkMute)
            .fixedSize(horizontal: false, vertical: true)

        holdings(selectable: false)
    }

    // MARK: merge

    @ViewBuilder
    private var merge: some View {
        Text(String(format: session.localized("proposals.merge.explainer"), proposal.name))
            .font(.system(size: 13)).foregroundStyle(theme.inkSoft).fixedSize(horizontal: false, vertical: true)
        ForEach(others) { o in
            pickRow(id: o.id, title: o.name, sub: proposalNumbers(o, session: session))
        }
        HStack(spacing: 8) {
            chip("chevron.left", session.localized("common.cancel")) { mode = .view }
            Spacer()
            Button(session.localized("proposals.merge")) {
                Task {
                    await run { await chat.mergeProposals([proposal.id] + Array(picked), name: renamed ? trimmedName : proposal.name) }
                }
            }
            .glassProminentButton().tint(accent).disabled(picked.isEmpty)
        }
    }

    // MARK: cut

    @ViewBuilder
    private var cut: some View {
        Text(session.localized("proposals.cut.explainer"))
            .font(.system(size: 13)).foregroundStyle(theme.inkSoft).fixedSize(horizontal: false, vertical: true)
        TextField(session.localized("proposals.cut.name"), text: $partName)
            .textFieldStyle(.plain)
            .font(.system(size: 16, weight: .medium)).foregroundStyle(theme.ink)
            .padding(.horizontal, 12).padding(.vertical, 9)
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(theme.ruleHard, lineWidth: 0.5))
        holdings(selectable: true)
        HStack(spacing: 8) {
            chip("chevron.left", session.localized("common.cancel")) { mode = .view }
            Spacer()
            Button(String(format: session.localized("proposals.cut.confirm"), picked.count)) {
                Task {
                    let convs = (detail?.conversations_list ?? []).map(\.id).filter(picked.contains)
                    let mail = (detail?.mail_list ?? []).map(\.path).filter(picked.contains)
                    let part = DomainProposalSplitPart(name: partName.trimmingCharacters(in: .whitespacesAndNewlines), conversation_ids: convs, mail: mail)
                    await run { await chat.splitProposal(proposal.id, part: part) }
                }
            }
            .glassProminentButton().tint(accent)
            .disabled(picked.isEmpty || partName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    // MARK: what it holds

    @ViewBuilder
    private func holdings(selectable: Bool) -> some View {
        if let detail {
            let convs = detail.conversations_list ?? []
            let mail = detail.mail_list ?? []
            if !convs.isEmpty {
                head(String(format: session.localized(convs.count == 1 ? "proposals.conversations.one" : "proposals.conversations.other"), proposal.conversations))
                ForEach(selectable ? convs : Array(convs.prefix(12))) { c in
                    line(id: c.id, title: c.title ?? "", date: c.date, selectable: selectable)
                }
            }
            if !mail.isEmpty {
                head(String(format: session.localized(mail.count == 1 ? "proposals.mail.one" : "proposals.mail.other"), proposal.mail_threads ?? mail.count))
                ForEach(selectable ? mail : Array(mail.prefix(12))) { t in
                    line(id: t.path, title: t.title ?? "", date: t.from, selectable: selectable)
                }
            }
        } else {
            ProgressView().frame(maxWidth: .infinity).padding(.top, 8)
        }
    }

    private func head(_ label: String) -> some View {
        Text(label)
            .font(.system(size: 10, design: .monospaced)).tracking(1.1).textCase(.uppercase)
            .foregroundStyle(theme.inkMute).padding(.top, 8)
    }

    @ViewBuilder
    private func line(id: String, title: String, date: String?, selectable: Bool) -> some View {
        if selectable {
            pickRow(id: id, title: title.isEmpty ? "—" : title, sub: date ?? "")
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(String((date ?? "").prefix(7))).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(theme.inkMute)
                Text(title.isEmpty ? "—" : title).font(.system(size: 13)).foregroundStyle(theme.inkSoft).lineLimit(1)
                Spacer(minLength: 0)
            }
        }
    }

    private func pickRow(id: String, title: String, sub: String) -> some View {
        Button {
            if picked.contains(id) { picked.remove(id) } else { picked.insert(id) }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: picked.contains(id) ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 18)).foregroundStyle(picked.contains(id) ? accent : theme.inkMute)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.system(size: 13.5)).foregroundStyle(theme.ink).lineLimit(1)
                    if !sub.isEmpty {
                        Text(sub).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(theme.inkMute).lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func chip(_ icon: String, _ label: String, tint: Color? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: icon).font(.system(size: 10))
                Text(label).font(.system(size: 12))
            }
            .foregroundStyle(tint ?? theme.inkSoft)
            .padding(.horizontal, 11).padding(.vertical, 6)
            .overlay(Capsule().strokeBorder(theme.ruleHard, lineWidth: 0.5))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    // MARK: server

    private func apply(_ action: String) async {
        await run {
            let r = await chat.applyProposals([DomainProposalApplyItem(
                id: proposal.id, action: action,
                name: renamed ? trimmedName : nil,
                summary: resummarised ? trimmedSummary : nil,
                seed: action == "adopt" && seed)])
            guard let r, r.errors.isEmpty else { return false }
            if !r.adopted.isEmpty {
                // The new domain joins the list above.
                await store.loadMaurices()
                await store.loadOverview()
            }
            return true
        }
    }

    /// Run one act; back to the list when it took.
    private func run(_ act: () async -> Bool) async {
        working = true
        failed = false
        let ok = await act()
        working = false
        if ok { dismiss() } else { failed = true }
    }
}
