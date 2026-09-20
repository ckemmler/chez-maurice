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

    private var accent: Color { session.activeDeviceUser?.color ?? .blue }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    if store.domains.isEmpty && store.companions.isEmpty {
                        Text(session.localized("domains.empty"))
                            .font(.system(size: 13)).foregroundStyle(theme.inkSoft)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.bottom, 6)
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
                }
                .padding(18)
            }
            .background(theme.surface)
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
        .task { await store.loadOverview() }
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

// MARK: - The drawer "Define my domains" (P2-D, 20 September 2026)
//
// Under the message Maurice opened the conversation with, while the server
// lists open proposals (GET /api/domains/proposals), a button opens this
// drawer — a sheet from the bottom on the phone, a sheet on the Mac. Each
// proposal is a row: its weight on five dots, its numbers, a box to adopt
// it, the name and the one-line summary editable in place, "put away" to
// dismiss it, and — only once the row is ticked — a second box, off by
// default, to have Maurice seed the garden with a few notes on it: a yes to
// the domain is not a yes to the notes, and the notes carry what the
// conversations say, so the decision is taken domain by domain. "Apply"
// sends the lot in one request; what was done comes back into the thread
// as a message of Maurice's.

/// The way into the drawer, drawn under the opening message.
struct DefineDomainsButton: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.mauriceTheme) private var theme
    let count: Int
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: "checklist").font(.system(size: 13, weight: .medium))
                Text(session.localized("proposals.cta"))
                    .font(.system(size: 14, weight: .medium))
                Text("\(count)")
                    .font(.system(size: 11, design: .monospaced))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Capsule().fill(theme.ink.opacity(0.12)))
            }
            .padding(.horizontal, 16).padding(.vertical, 10)
        }
        .glassProminentButton()
        .tint(session.activeDeviceUser?.color ?? .blue)
        .help(session.localized("proposals.cta.help"))
        .padding(.top, 2)
    }
}

/// One row's draft: what the member decided and wrote.
private struct ProposalDraft: Identifiable, Equatable {
    let id: String
    var name: String
    var summary: String
    var adopt = false
    var dismiss = false
    var seed = false
}

struct DomainProposalsSheet: View {
    @Environment(ChatService.self) private var chat
    @Environment(MauriceStore.self) private var store
    @Environment(SessionStore.self) private var session
    @Environment(\.mauriceTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    @State private var drafts: [ProposalDraft] = []
    @State private var applying = false
    @State private var failed = false

    private var accent: Color { session.activeDeviceUser?.color ?? .blue }
    private var byId: [String: DomainProposal] { Dictionary(chat.openProposals.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }) }
    private var decided: Int { drafts.filter { $0.adopt || $0.dismiss }.count }
    private var changed: Bool {
        drafts.contains { d in
            guard let p = byId[d.id] else { return false }
            return d.adopt || d.dismiss || d.name.trimmingCharacters(in: .whitespaces) != p.name || d.summary.trimmingCharacters(in: .whitespaces) != (p.one_line ?? p.summary)
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    Text(session.localized("proposals.explainer"))
                        .font(.system(size: 13)).foregroundStyle(theme.inkSoft)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.bottom, 4)

                    if drafts.isEmpty {
                        Text(session.localized("proposals.empty"))
                            .font(.system(size: 13)).foregroundStyle(theme.inkMute)
                    }

                    // Rows are bound by id, never by position: the list can
                    // shrink under an open drawer (Apply, a tool call in the
                    // thread, another device) and a positional binding then
                    // read past the end — that was a crash on the first Apply.
                    ForEach(drafts) { d in
                        if let p = byId[d.id] {
                            ProposalRow(proposal: p, draft: draftBinding(d.id), total: chat.proposalsTotalConversations, accent: accent)
                        }
                    }

                    if failed {
                        Text(session.localized("proposals.failed"))
                            .font(.system(size: 12)).foregroundStyle(Color(hex: "a6452e"))
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Text(session.localized("proposals.rule"))
                        .font(.system(size: 12)).foregroundStyle(theme.inkMute)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 6)
                }
                .padding(18)
            }
            .background(theme.surface)
            .navigationTitle(session.localized("proposals.title"))
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(session.localized("common.cancel")) { dismiss() }.tint(theme.ink).disabled(applying)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await apply() } } label: {
                        if applying { ProgressView().controlSize(.small) }
                        else { Text(decided > 0 ? String(format: session.localized("proposals.apply.count"), decided) : session.localized("proposals.apply")) }
                    }
                    .disabled(!changed || applying)
                    .tint(accent)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 520, idealWidth: 580, minHeight: 520, idealHeight: 680)
        #endif
        .task {
            await chat.loadProposals()
            reset()
        }
        .onChange(of: chat.openProposals) { _, _ in
            // The server's list moved (a tool call in the thread, another
            // device): keep what the member typed, drop the rows that went.
            // Not while we are the ones moving it: Apply dismisses on its own.
            if applying { return }
            let kept = Dictionary(drafts.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            drafts = chat.openProposals.map { p in kept[p.id] ?? ProposalDraft(id: p.id, name: p.name, summary: p.one_line ?? p.summary) }
        }
        .interactiveDismissDisabled(applying)
    }

    private func reset() {
        drafts = chat.openProposals.map { ProposalDraft(id: $0.id, name: $0.name, summary: $0.one_line ?? $0.summary) }
    }

    /// A binding to one draft found by id. Reading a row that has gone gives
    /// its last value back (an inert placeholder), writing to it does nothing.
    private func draftBinding(_ id: String) -> Binding<ProposalDraft> {
        Binding(
            get: { drafts.first { $0.id == id } ?? ProposalDraft(id: id, name: "", summary: "") },
            set: { new in if let i = drafts.firstIndex(where: { $0.id == id }) { drafts[i] = new } }
        )
    }

    private func apply() async {
        applying = true
        failed = false
        defer { applying = false }
        var items: [DomainProposalApplyItem] = []
        for d in drafts {
            guard let p = byId[d.id] else { continue }
            let name = d.name.trimmingCharacters(in: .whitespacesAndNewlines)
            let summary = d.summary.trimmingCharacters(in: .whitespacesAndNewlines)
            let renamed = name != p.name && !name.isEmpty
            let resummarised = summary != (p.one_line ?? p.summary) && !summary.isEmpty
            let action = d.adopt ? "adopt" : d.dismiss ? "dismiss" : "keep"
            if action == "keep" && !renamed && !resummarised { continue }
            items.append(DomainProposalApplyItem(id: d.id, action: action,
                                                 name: renamed ? name : nil,
                                                 summary: resummarised ? summary : nil,
                                                 seed: d.adopt && d.seed))
        }
        guard !items.isEmpty else { return }
        guard let result = await chat.applyProposals(items) else { failed = true; return }
        if !result.adopted.isEmpty {
            // The new domains join the list and the sidebar's overview.
            await store.loadMaurices()
        }
        if !result.errors.isEmpty && result.adopted.isEmpty && result.dismissed.isEmpty && result.renamed.isEmpty {
            failed = true
            return
        }
        dismiss()
    }
}

/// One proposal in the drawer.
private struct ProposalRow: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.mauriceTheme) private var theme
    let proposal: DomainProposal
    @Binding var draft: ProposalDraft
    let total: Int
    let accent: Color

    private var numbers: String {
        var bits: [String] = []
        bits.append(String(format: session.localized(proposal.conversations == 1 ? "proposals.conversations.one" : "proposals.conversations.other"), proposal.conversations))
        if proposal.share > 0 { bits.append("\(proposal.share) %") }
        if let r = proposal.recent_90_days, r > 0 { bits.append(String(format: session.localized("proposals.recent"), r)) }
        if !proposal.isAlive, let to = proposal.to { bits.append(String(format: session.localized("proposals.quiet_since"), String(to.prefix(7)))) }
        return bits.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 12) {
                // Adopt: the box.
                Button {
                    draft.adopt.toggle()
                    if draft.adopt { draft.dismiss = false } else { draft.seed = false }
                } label: {
                    Image(systemName: draft.adopt ? "checkmark.square.fill" : "square")
                        .font(.system(size: 22, weight: .regular))
                        .foregroundStyle(draft.adopt ? accent : theme.inkMute)
                }
                .buttonStyle(.plain)
                .disabled(draft.dismiss)
                .help(session.localized("proposals.adopt"))
                .padding(.top, 2)

                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 8) {
                        Text(dots(proposal.weight))
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(proposal.isAlive ? accent.legible(onDark: theme.isDark) : theme.inkMute)
                            .accessibilityLabel(String(format: session.localized("proposals.weight"), proposal.weight, 5))
                        Text(numbers)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(theme.inkMute)
                            .lineLimit(2)
                    }
                    TextField(session.localized("proposals.name"), text: $draft.name)
                        .textFieldStyle(.plain)
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(theme.ink)
                        .disabled(draft.dismiss)
                    TextField(session.localized("proposals.summary"), text: $draft.summary, axis: .vertical)
                        .textFieldStyle(.plain)
                        .lineLimit(1...4)
                        .font(.system(size: 13))
                        .foregroundStyle(theme.inkSoft)
                        .disabled(draft.dismiss)
                    if let hint = proposal.split_hint, !hint.isEmpty {
                        Text(String(format: session.localized("proposals.split_hint"), hint))
                            .font(.system(size: 11)).italic().foregroundStyle(theme.inkMute)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if draft.adopt {
                        Toggle(isOn: $draft.seed) {
                            Text(session.localized("proposals.seed"))
                                .font(.system(size: 12)).foregroundStyle(theme.inkSoft)
                        }
                        .toggleStyle(.switch)
                        .tint(accent)
                        #if os(macOS)
                        .controlSize(.small)
                        #endif
                        .padding(.top, 2)
                    }
                }

                Spacer(minLength: 0)

                // Put away: the proposal is not a domain.
                Button {
                    draft.dismiss.toggle()
                    if draft.dismiss { draft.adopt = false; draft.seed = false }
                } label: {
                    Image(systemName: draft.dismiss ? "arrow.uturn.backward.circle" : "xmark.circle")
                        .font(.system(size: 18))
                        .foregroundStyle(draft.dismiss ? accent : theme.inkMute)
                }
                .buttonStyle(.plain)
                .help(session.localized(draft.dismiss ? "proposals.undo_dismiss" : "proposals.dismiss"))
                .padding(.top, 2)
            }
            if draft.dismiss {
                Text(session.localized("proposals.dismissed"))
                    .font(.system(size: 11)).foregroundStyle(theme.inkMute)
                    .padding(.leading, 34)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 12).fill(theme.bg))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(draft.adopt ? accent.opacity(0.6) : theme.ruleHard, lineWidth: draft.adopt ? 1 : 0.5))
        .opacity(draft.dismiss ? 0.55 : 1)
    }

    private func dots(_ w: Int) -> String {
        let n = max(0, min(5, w))
        return String(repeating: "●", count: n) + String(repeating: "○", count: 5 - n)
    }
}
