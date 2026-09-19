import SwiftUI

// MARK: - The domain's brief
//
// A Maurice of the member's own is, seen from the other side, a *domain*: a
// part of their life Maurice follows, with a brief he keeps on it — his
// working memory on that domain, made visible. This sheet is the page of a
// domain: the brief as it stands, editable (what the member writes is what
// Maurice reads from the next turn on) and erasable, with when it was last
// rewritten and by whom, a "rewrite now" that asks the night's model for a
// fresh one, and "talk about it", a new conversation with the domain's
// bound context preloaded. Opened from the domains list and the greeting.

struct DomainBriefSheet: View {
    @Environment(MauriceStore.self) private var store
    @Environment(SessionStore.self) private var session
    @Environment(ChatService.self) private var chat
    @Environment(DomainsState.self) private var domains
    @Environment(\.mauriceTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    let maurice: Maurice
    /// Called after a conversation is opened, so the compact layout can slide
    /// from the sidebar to the chat.
    var onOpen: () -> Void = {}

    @State private var loaded = false
    @State private var found = true
    @State private var brief: DomainBrief?
    @State private var text = ""
    @State private var saving = false
    @State private var refreshing = false
    @State private var notice: String?
    @State private var confirmErase = false
    @FocusState private var editing: Bool

    private let eraseTint = Color(hex: "a6452e")
    private var accent: Color { session.activeDeviceUser?.color ?? .blue }
    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var changed: Bool { trimmed != (brief?.text ?? "") }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    header
                    if !loaded {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 24)
                    } else if !found {
                        Text(session.localized("brief.unreachable"))
                            .font(.system(size: 13)).foregroundStyle(theme.inkSoft)
                    } else {
                        status
                        editor
                        if let notice {
                            Text(notice).font(.system(size: 12)).foregroundStyle(theme.inkSoft)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        actions
                        Text(session.localized("brief.explainer"))
                            .font(.system(size: 12)).foregroundStyle(theme.inkMute)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 6)
                    }
                }
                .padding(18)
            }
            .background(theme.surface)
            .navigationTitle(session.localized("brief.title"))
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
        .frame(minWidth: 520, idealWidth: 560, minHeight: 520, idealHeight: 640)
        #endif
        .task { await load() }
        .alert(session.localized("brief.erase.title"), isPresented: $confirmErase) {
            Button(session.localized("brief.erase"), role: .destructive) { Task { await erase() } }
            Button(session.localized("common.cancel"), role: .cancel) {}
        } message: {
            Text(session.localized("brief.erase.message"))
        }
    }

    // MARK: header

    private var header: some View {
        HStack(spacing: 14) {
            DomainMark(maurice: maurice, size: 52)
            VStack(alignment: .leading, spacing: 3) {
                Text(session.localized("brief.kicker"))
                    .font(.system(size: 9, design: .monospaced)).tracking(0.8)
                    .foregroundStyle(theme.inkMute)
                Text(maurice.name)
                    .font(.system(size: 22, design: .serif))
                    .foregroundStyle(theme.ink)
                    .lineLimit(2)
                if !maurice.tagline.isEmpty {
                    Text(maurice.tagline).font(.system(size: 12)).foregroundStyle(theme.inkSoft).lineLimit(2)
                }
            }
            Spacer(minLength: 0)
        }
    }

    // MARK: status line

    @ViewBuilder
    private var status: some View {
        if let brief {
            HStack(spacing: 6) {
                Image(systemName: brief.byMember ? "person" : "moon.stars").font(.system(size: 11))
                Text(brief.byMember
                     ? String(format: session.localized("brief.by_you"), stamp(brief.updatedAt))
                     : String(format: session.localized("brief.by_maurice"), stamp(brief.updatedAt)))
                if !brief.byMember, !brief.sources.isEmpty {
                    Text("·")
                    Text(String(format: brief.sources.count == 1
                                ? session.localized("brief.sources_one")
                                : session.localized("brief.sources_other"), brief.sources.count))
                }
            }
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(theme.inkMute)
        } else {
            Text(session.localized("brief.none"))
                .font(.system(size: 13)).foregroundStyle(theme.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// "today · 3d · 2w" beside the absolute date, so both readings are there.
    private func stamp(_ raw: String) -> String {
        let age = gardenAge(raw, session: session)
        let abs = parseServerDate(raw)?.formatted(date: .abbreviated, time: .shortened) ?? raw
        return age.isEmpty ? abs : "\(age) · \(abs)"
    }

    // MARK: editor

    private var editor: some View {
        TextEditor(text: $text)
            .font(.system(size: 13.5))
            .foregroundStyle(theme.ink)
            .focused($editing)
            .scrollContentBackground(.hidden)
            .frame(minHeight: 220)
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 10).fill(theme.bg))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(editing ? accent : theme.rule, lineWidth: editing ? 1 : 0.5))
            .overlay(alignment: .topLeading) {
                if text.isEmpty {
                    Text(session.localized("brief.placeholder"))
                        .font(.system(size: 13.5)).foregroundStyle(theme.inkMute)
                        .padding(.horizontal, 15).padding(.vertical, 18)
                        .allowsHitTesting(false)
                }
            }
            .disabled(refreshing || saving)
    }

    // MARK: actions

    private var actions: some View {
        FlowLayout(spacing: 8) {
            // Save: the member's words replace the brief. Empty = erase.
            Button { Task { await save() } } label: {
                Text(session.localized("common.save"))
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16).padding(.vertical, 7)
                    .background(changed && !saving ? accent : theme.inkMute.opacity(0.4))
                    .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .disabled(!changed || saving || refreshing)

            pill(refreshing ? "hourglass" : "arrow.clockwise", session.localized("brief.rewrite"), disabled: refreshing || saving) {
                Task { await rewrite() }
            }

            pill("bubble.left", session.localized("brief.talk"), disabled: refreshing || saving) {
                Task {
                    await chat.createConversation(mauriceId: maurice.rawId, force: true)
                    dismiss()
                    onOpen()
                }
            }

            if brief != nil {
                pill("trash", session.localized("brief.erase"), tint: eraseTint, disabled: refreshing || saving) {
                    confirmErase = true
                }
            }

            // The domain itself — name, statement, context, model — is edited
            // in the editor, which takes this sheet's place.
            pill("pencil", session.localized("domain.edit"), disabled: refreshing || saving) {
                domains.openEditor(maurice, isEdit: true)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private func pill(_ icon: String, _ label: String, tint: Color? = nil, disabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: icon).font(.system(size: 11))
                Text(label).font(.system(size: 11, design: .monospaced))
            }
            .foregroundStyle(tint ?? theme.inkSoft)
            .padding(.horizontal, 12).padding(.vertical, 7)
            .overlay(Capsule().strokeBorder(tint?.opacity(0.5) ?? theme.ruleHard, lineWidth: 0.5))
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1)
    }

    // MARK: server

    private func load() async {
        guard let id = maurice.rawId else { return }
        let r = await store.loadBrief(id)
        found = r.found
        brief = r.brief
        text = r.brief?.text ?? ""
        loaded = true
    }

    private func save() async {
        guard let id = maurice.rawId, changed else { return }
        saving = true
        defer { saving = false }
        let r = await store.saveBrief(id, text: trimmed)
        guard r.ok else {
            notice = session.localized("brief.save_failed")
            return
        }
        brief = r.brief
        text = r.brief?.text ?? ""
        notice = r.brief == nil ? session.localized("brief.erased") : session.localized("brief.saved")
    }

    private func erase() async {
        guard let id = maurice.rawId else { return }
        saving = true
        defer { saving = false }
        guard await store.deleteBrief(id) else {
            notice = session.localized("brief.save_failed")
            return
        }
        brief = nil
        text = ""
        notice = session.localized("brief.erased")
    }

    private func rewrite() async {
        guard let id = maurice.rawId else { return }
        refreshing = true
        notice = session.localized("brief.rewriting")
        defer { refreshing = false }
        let r = await store.refreshBrief(id)
        if let b = r.brief {
            brief = b
            text = b.text
        }
        switch r.outcome {
        case .written(let n):
            notice = String(format: n == 1 ? session.localized("brief.outcome.written_one") : session.localized("brief.outcome.written_other"), n)
        case .unchanged:
            notice = session.localized("brief.outcome.unchanged")
        case .capped:
            notice = session.localized("brief.outcome.capped")
        case .failed(let why):
            notice = String(format: session.localized("brief.outcome.failed"), why)
        }
    }
}
