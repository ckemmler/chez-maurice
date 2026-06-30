import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// True when `name` is a real SF Symbol. Guards `Image(systemName:)` against
/// emoji or stray text that can land in the household icon field (e.g. a 🏠 set
/// server-side), which would otherwise log "No symbol named … found".
func isSystemSymbol(_ name: String) -> Bool {
    #if canImport(UIKit)
    return UIImage(systemName: name) != nil
    #elseif canImport(AppKit)
    return NSImage(systemSymbolName: name, accessibilityDescription: nil) != nil
    #else
    return false
    #endif
}

/// Sidebar: wordmark, conversation list, and a pinned bottom bar carrying the
/// identity chip (→ Settings) and the foyer pill (→ switcher).
struct SidebarView: View {
    @Environment(ChatService.self) private var chat
    @Environment(SessionStore.self) private var session
    @Environment(MauriceStore.self) private var maurices
    @Environment(StudioState.self) private var studio
    @Environment(GardensStore.self) private var gardens
    @Environment(\.mauriceTheme) private var theme
    @State private var showSettings = false
    @State private var showAddHousehold = false
    @State private var showFoyerSwitcher = false
    @State private var pendingAdd = false
    @State private var gardensExpanded = true

    /// Called when a conversation is opened, so the compact (iPhone) layout can
    /// slide from the sidebar to the chat. No-op on iPad/Mac (both columns show).
    var onActivateConversation: () -> Void = {}

    private var accent: Color { session.activeDeviceUser?.color ?? .blue }

    // The wordmark lockup sits smaller on macOS (narrower sidebar) so "Chez
    // Maurice" stays on one line.
    #if os(macOS)
    private let wordmarkType: CGFloat = 16
    private let wordmarkMark: CGFloat = 19
    #else
    private let wordmarkType: CGFloat = 20
    private let wordmarkMark: CGFloat = 22
    #endif

    // Bottom-bar metrics — the phone gets slightly larger touch targets.
    #if os(macOS)
    private let chipAvatarSize: CGFloat = 28
    private let chipNameSize: CGFloat = 13
    private let pillBadgeSize: CGFloat = 22
    private let pillNameSize: CGFloat = 13
    #else
    private let chipAvatarSize: CGFloat = 44
    private let chipNameSize: CGFloat = 16   // matches the household name
    private let pillBadgeSize: CGFloat = 26
    private let pillNameSize: CGFloat = 16   // matches conversation titles
    #endif

    /// Every conversation, always — the specialist list filter is gone.
    // Content-first: the list is no longer filtered by a pre-selected specialist
    // (that whole apparatus is gone) — every conversation is always shown.
    private var visibleConversations: [ServerConversation] {
        chat.conversations
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header: wordmark only — identity + foyer switching live in the
            // pinned bottom bar, leaving breathing room before New conversation.
            // iPad re-homes it into the toolbar (sidebarToolbar) so the iPadOS 26
            // window controls don't overlap it; iPhone keeps it as the top row.
            if !Platform.isPad {
                HStack(alignment: .center, spacing: 7) {
                    BoaterHat(size: wordmarkMark, color: theme.ink)
                    Text("Chez Maurice")
                        .font(.wordmark(wordmarkType))
                        .foregroundStyle(theme.ink)
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                    #if os(iOS)
                    // The foyer switcher rides in the top-right, centered against
                    // the wordmark (it used to live in the bottom bar).
                    Spacer(minLength: 8)
                    foyerPill
                    #endif
                }
                .padding(.horizontal, 14)
                .padding(.top, 8)
                .padding(.bottom, 18)
            }

            // New conversation (inherits the current Maurice) + a hat button that
            // opens the picker to choose/create a specialized Maurice.
            HStack(spacing: 8) {
                let disabled = chat.activeConversationIsEmpty
                Button {
                    gardens.openGardenId = nil
                    onActivateConversation()
                    // New conversations arm the last Maurice the user sent to
                    // (everyday if they never picked a specialist).
                    Task { await chat.createConversation(mauriceId: chat.defaultMauriceId) }
                } label: {
                    HStack(spacing: 9) {
                        // Accent-filled plus circle (muted when disabled).
                        Image(systemName: "plus")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: 26, height: 26)
                            .background((disabled ? theme.inkMute.opacity(0.5) : accent), in: Circle())
                        Text(session.localized("sidebar.new_conversation"))
                            .font(.system(size: 14.5, weight: .medium))
                            .foregroundStyle(disabled ? theme.inkMute : theme.ink)
                        Spacer(minLength: 4)
                    }
                    .padding(.vertical, 12).padding(.horizontal, 14)
                    .frame(maxWidth: .infinity)
                    .background(theme.surface, in: RoundedRectangle(cornerRadius: 13))
                    .overlay(RoundedRectangle(cornerRadius: 13).strokeBorder(theme.ruleHard, lineWidth: 0.5))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(disabled)
            }
            .padding(.horizontal, 10)
            .padding(.bottom, 8)

            // GARDENS — your garden first (leaf), then the shared sets, each
            // named by its people. Collapsible, like the conversations below.
            if !gardens.gardens.isEmpty {
                SidebarSectionHead(label: session.localized("gardens.section"),
                                   count: gardens.gardens.count,
                                   expanded: gardensExpanded,
                                   onToggle: { withAnimation(.easeInOut(duration: 0.18)) { gardensExpanded.toggle() } })
                if gardensExpanded {
                    VStack(spacing: 1) {
                        ForEach(gardens.gardens) { g in
                            GardenRow(garden: g, active: gardens.openGardenId == g.id) {
                                gardens.openGardenId = g.id
                                onActivateConversation()
                            }
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.bottom, 10)
                }
                SidebarSectionHead(label: session.localized("gardens.conversations"))
            }

            // Conversation list — runs to the bottom (Settings moved up top), with
            // a soft fade where titles meet the bottom edge.
            ScrollView {
                LazyVStack(spacing: 2) {
                    ForEach(visibleConversations) { convo in
                        Button {
                            gardens.openGardenId = nil
                            onActivateConversation()
                            Task { await chat.selectConversation(convo.id) }
                        } label: {
                            ConversationRow(
                                conversation: convo,
                                maurice: maurices.maurice(for: convo.maurice_id),
                                isSelected: convo.id == chat.activeConversationId,
                                isUnread: chat.unread.contains(convo.id)
                            )
                        }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Button(role: .destructive) {
                                Task { await chat.deleteConversation(convo.id) }
                            } label: {
                                Label(session.localized("sidebar.delete"), systemImage: "trash")
                            }
                        }
                    }
                    // Infinite scroll: this footer enters the (lazy) viewport only
                    // when the user nears the bottom, paging in the next batch.
                    if chat.hasMoreConversations {
                        ProgressView()
                            .controlSize(.small)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .onAppear { Task { await chat.loadMoreConversations() } }
                    }
                }
                .padding(.horizontal, 10)
                .padding(.bottom, 16)
            }
            .mask(
                LinearGradient(
                    stops: [
                        .init(color: .black, location: 0),
                        .init(color: .black, location: 0.93),
                        .init(color: .clear, location: 1.0),
                    ],
                    startPoint: .top, endPoint: .bottom
                )
            )

            bottomBar
        }
        .background(theme.surfaceAlt)
        .sheet(isPresented: $showSettings) {
            SettingsView()
                .environment(session)
        }
        .sheet(isPresented: $showAddHousehold) {
            PairingView(onPaired: { showAddHousehold = false })
                .environment(session)
        }
        #if os(iOS)
        .sheet(isPresented: $showFoyerSwitcher, onDismiss: addIfPending) {
            FoyerSwitcherView(onPick: switchTo, onAdd: requestAdd, onDismiss: { showFoyerSwitcher = false })
                .environment(session)
                .environment(\.mauriceTheme, theme)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        #else
        // (The foyer popover is anchored to the pill in the bottom bar.)
        .onChange(of: showFoyerSwitcher) { if !showFoyerSwitcher { addIfPending() } }
        #endif
        .navigationTitle("")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { sidebarToolbar }
        #endif
        .task(id: session.activeUserId) { await gardens.load() }
    }

    #if os(iOS)
    /// iPad only: the "Chez Maurice" wordmark re-homed into the sidebar's toolbar
    /// so the iPadOS 26 window controls (which land on the leading column) sit
    /// beside it instead of overlapping it. Emits nothing on iPhone.
    @ToolbarContentBuilder
    private var sidebarToolbar: some ToolbarContent {
        if Platform.isPad {
            ToolbarItem(placement: .topBarLeading) {
                HStack(alignment: .center, spacing: 7) {
                    BoaterHat(size: wordmarkMark, color: theme.ink)
                    Text("Chez Maurice")
                        .font(.wordmark(wordmarkType))
                        .foregroundStyle(theme.ink)
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
            .plainGlass()
        }
    }
    #endif

    // MARK: Bottom bar

    /// Pinned, hairline-separated: the identity chip on the left (avatar +
    /// name + muted cog — ONE tap target → Settings) and the compact foyer
    /// pill on the right, whose switcher opens upward from the bar.
    private var bottomBar: some View {
        HStack(spacing: 8) {
            #if os(iOS)
            if Platform.isPad {
                // iPad keeps both in the bar (the wordmark is in the toolbar).
                userChip
                Spacer(minLength: 8)
                foyerPill
            } else {
                // iPhone: the foyer pill moved to the header — the identity chip
                // sits on the left edge on its own.
                userChip
                Spacer(minLength: 8)
            }
            #else
            userChip
            Spacer(minLength: 8)
            foyerPill
            #endif
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .overlay(alignment: .top) {
            Rectangle().fill(theme.rule).frame(height: 0.5)
        }
    }

    private var userChip: some View {
        Button { showSettings = true } label: {
            HStack(spacing: 8) {
                chipAvatar
                chipName
                chipCog
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(session.localized("settings.title"))
    }

    private var chipAvatar: some View {
        UserAvatar(avatarURL: session.activeDeviceUser?.avatarURL,
                   serverURL: session.serverURL,
                   initial: session.activeDeviceUser?.initial ?? "?",
                   color: session.activeDeviceUser?.color ?? .gray,
                   size: chipAvatarSize)
    }

    private var chipName: some View {
        Text(session.activeDeviceUser?.displayName ?? "")
            .font(.system(size: chipNameSize, weight: .medium))
            .foregroundStyle(theme.ink)
            .lineLimit(1)
    }

    private var chipCog: some View {
        Image(systemName: "gearshape")
            .font(.system(size: chipNameSize))
            .foregroundStyle(theme.inkMute)
    }

    @ViewBuilder
    private var foyerPill: some View {
        let pill = Button { showFoyerSwitcher = true; Task { await session.refreshFoyers() } } label: {
            HStack(spacing: 8) {
                Text(session.currentHousehold?.name ?? session.localized("app.tagline"))
                    .font(.system(size: pillNameSize, weight: .medium))
                    .foregroundStyle(theme.ink)
                    .lineLimit(1)
                if let h = session.currentHousehold {
                    FoyerBadge(household: h, size: pillBadgeSize, radius: 7)
                }
                #if os(iOS)
                Image(systemName: "chevron.down")   // header pill → sheet opens below
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(theme.inkMute)
                #else
                Image(systemName: "chevron.up")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(theme.inkMute)
                #endif
            }
            .padding(.leading, 5)
            .padding(.trailing, 10)
            .padding(.vertical, 5)
            #if os(macOS)
            .background(theme.surface, in: Capsule())
            .overlay(Capsule().strokeBorder(theme.ruleHard, lineWidth: 0.5))
            #endif
            // iOS header lockup: fully transparent — no fill, no outline.
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)

        #if os(iOS)
        pill
        #else
        pill.popover(isPresented: $showFoyerSwitcher, arrowEdge: .top) {
            FoyerSwitcherView(showHeader: false, compact: true,
                              onPick: switchTo, onAdd: requestAdd, onDismiss: { showFoyerSwitcher = false })
                .environment(session)
                .environment(\.mauriceTheme, theme)
                .frame(width: 300, height: 440)
        }
        #endif
    }

    private func switchTo(_ id: String) {
        showFoyerSwitcher = false
        if id != session.currentHouseholdId { session.switchHousehold(id) }
    }
    private func requestAdd() { pendingAdd = true; showFoyerSwitcher = false }
    private func addIfPending() {
        if pendingAdd { pendingAdd = false; showAddHousehold = true }
    }
}

// MARK: - Conversation Row

/// Imported-conversation `origin` → ProviderBadge logo key (logo-<key> in Assets).
/// nil for native conversations (no badge).
private func importBadgeProvider(_ origin: String?) -> String? {
    switch origin {
    case "anthropic": return "claude"   // logo-claude
    case "chatgpt":   return "openai"   // logo-openai
    default:          return nil
    }
}

private struct ConversationRow: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.mauriceTheme) private var theme
    let conversation: ServerConversation
    let maurice: Maurice
    let isSelected: Bool
    var isUnread: Bool = false

    private var participants: [ServerParticipant] { conversation.participants ?? [] }
    /// Avatars only appear when more than one human shares the thread.
    private var multi: Bool { participants.count > 1 }

    var body: some View {
        let accentColor = session.activeDeviceUser?.color ?? .blue

        HStack(spacing: 11) {
            // The hat badge identifies a specialized Maurice; the everyday one
            // shows nothing (ragged-left). It's a flex-shrink:0 sibling — it must
            // not change the row height, which stays uniform via minHeight below.
            if !maurice.isEveryday {
                HatBadge(kind: maurice.hat, palette: maurice.paletteValue, size: 30, radius: 9)
            } else if let badge = importBadgeProvider(conversation.origin) {
                // Imported chat — badge it with the source provider's mark (Claude /
                // OpenAI), like a specialist hat but 25% closer to the title.
                ProviderBadge(provider: badge, size: 30)
                    .padding(.trailing, -2.75)
            }
            Text(conversation.title ?? session.localized("chat.new_conversation"))
                .font(.system(size: 16))
                .foregroundStyle(theme.ink)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)

            if multi {
                AvatarStack(participants: participants, serverBase: session.serverURL,
                            size: 24, ring: theme.surfaceAlt, max: 4)
            }
            if isUnread {
                Circle().fill(accentColor).frame(width: 7, height: 7)
            }
        }
        // Uniform height regardless of badge/avatars: no vertical padding (the
        // badge at 30 and the text both center within the 40pt min height).
        .frame(minHeight: 40)
        .padding(.horizontal, 10)
        // Borderless: only the open row gets a subtle tint + a palette tick.
        .background(isSelected ? accentColor.opacity(0.12) : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(alignment: .leading) {
            if isSelected {
                RoundedRectangle(cornerRadius: 2)
                    .fill(accentColor)
                    .frame(width: 2)
                    .padding(.vertical, 9)
                    .offset(x: -1)
            }
        }
        .contentShape(Rectangle())
    }
}

// MARK: - Foyer (household) switcher
// Implements "Foyer Switcher — Proposition A" (rev 2, bottom bar) from the
// Claude Design handoff: the foyer pill in the pinned bottom bar opens a sheet
// (phone) / an upward popover (desktop) listing every foyer with a coloured
// icon badge, name, members and an active check. Each foyer owns a colour +
// icon; the app doesn't persist those yet, so they're derived deterministically
// from the foyer id (stable across launches).

private let foyerPalette = ["#a6452e", "#3d6b4f", "#2c5aa0", "#7a4f6e",
                            "#2f6f6a", "#9c6b4a", "#b97a1e", "#44504f"]
private let foyerIcons = ["house", "heart", "building.2", "leaf",
                          "mountain.2", "books.vertical", "sun.max", "sailboat"]

extension Household {
    /// Stable seed from the foyer id (char-sum, like the design's seeding).
    private var foyerSeed: Int { id.unicodeScalars.reduce(0) { $0 + Int($1.value) } }
    /// The foyer's own hue — the server's value (/api/health), else derived.
    var foyerColor: Color {
        if let c = color, !c.isEmpty { return Color(hex: c) }
        return Color(hex: foyerPalette[foyerSeed % foyerPalette.count])
    }
    /// The foyer's icon (SF Symbol name) — the server's value, else derived.
    var foyerIcon: String {
        if let i = icon, !i.isEmpty, isSystemSymbol(i) { return i }
        return foyerIcons[foyerSeed % foyerIcons.count]
    }
}

/// Coloured rounded tile with the foyer's icon — the foyer's "face".
struct FoyerBadge: View {
    let household: Household
    var size: CGFloat = 38
    var radius: CGFloat? = nil
    var ring: Color? = nil

    var body: some View {
        let r = radius ?? size * 0.3
        RoundedRectangle(cornerRadius: r, style: .continuous)
            .fill(household.foyerColor)
            .frame(width: size, height: size)
            .overlay(
                Image(systemName: household.foyerIcon)
                    .font(.system(size: size * 0.46))
                    .foregroundStyle(.white)
            )
            .overlay(RoundedRectangle(cornerRadius: r, style: .continuous)
                .strokeBorder(.black.opacity(0.08), lineWidth: 0.5))
            .overlay {
                if let ring {
                    RoundedRectangle(cornerRadius: r + 2, style: .continuous)
                        .strokeBorder(ring, lineWidth: 2)
                        .padding(-2)
                }
            }
    }
}

/// Overlapping stack of the foyer's known members (device users).
private struct FoyerAvatars: View {
    let users: [DeviceUser]
    var serverURL: String? = nil
    var size: CGFloat = 21
    var maxShown: Int = 3
    var ring: Color = .white

    var body: some View {
        let show = Array(users.prefix(maxShown))
        HStack(spacing: -size * 0.34) {
            ForEach(Array(show.enumerated()), id: \.element.id) { i, u in
                UserAvatar(avatarURL: u.avatarURL, serverURL: serverURL, initial: u.initial, color: u.color, size: size)
                    .overlay(Circle().strokeBorder(ring, lineWidth: 2))
                    .zIndex(Double(show.count - i))
            }
        }
    }
}

/// One foyer in the switcher list.
private struct FoyerRow: View {
    @Environment(\.mauriceTheme) private var theme
    let household: Household
    let active: Bool
    var compact: Bool = false
    let onPick: () -> Void

    private var host: String? { URL(string: household.serverURL)?.host }

    var body: some View {
        Button(action: onPick) {
            HStack(spacing: 12) {
                FoyerBadge(household: household,
                           size: compact ? 30 : 38, radius: compact ? 9 : 11,
                           ring: active ? theme.surface : nil)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 7) {
                        Text(household.name)
                            .font(.system(size: compact ? 15 : 16.5, design: .serif))
                            .foregroundStyle(theme.ink)
                            .lineLimit(1)
                        if let u = household.unread, u > 0 {
                            Text("\(u)")
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 5)
                                .frame(minWidth: 17, minHeight: 17)
                                .background(household.foyerColor, in: Capsule())
                        }
                    }
                    if let host {
                        Text(host)
                            .font(.system(size: 11.5))
                            .foregroundStyle(theme.inkSoft)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                if !household.deviceUsers.isEmpty {
                    FoyerAvatars(users: household.deviceUsers, serverURL: household.serverURL,
                                 size: compact ? 18 : 21, maxShown: 3,
                                 ring: active ? household.foyerColor.opacity(0.12) : theme.surface)
                }
                if active {
                    Image(systemName: "checkmark")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(household.foyerColor)
                }
            }
            .padding(.vertical, compact ? 7 : 9)
            .padding(.horizontal, compact ? 10 : 12)
            .background(active ? household.foyerColor.opacity(0.12) : Color.clear,
                        in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Shared gardens
// "Shared Gardens — Sidebar" (Claude Design handoff): sharing is per-NOTE, and
// a shared garden is simply the derived set of notes you share with the same
// people — named by the people, never by an invented title. The GARDENS
// section lists YOUR garden first (leaf), then the shared sets. Every garden
// row and every note row carries the SAME two affordances: a boxed ↗ that
// browses it on the web (the garden IS a website — strolling happens in the
// browser) and › which manages it in-app (garden tool / note access).

struct ServerGardenMember: Decodable, Identifiable {
    let member_id: String
    let username: String?
    let display_name: String
    let avatar_color: String
    let avatar_url: String?
    var id: String { member_id }
    var participant: ServerParticipant {
        ServerParticipant(member_id: member_id, role: "member", username: username,
                          display_name: display_name, avatar_color: avatar_color,
                          avatar_url: avatar_url)
    }
}

struct ServerGardenNote: Decodable, Identifiable {
    let owner_id: String
    let owner_username: String
    let slug: String
    let locale: String
    let title: String
    let updated_at: String?
    let web_path: String
    var id: String { "\(owner_id)/\(slug)" }
}

struct ServerGarden: Decodable, Identifiable {
    let id: String
    let mine: Bool
    let members: [ServerGardenMember]
    let web_theme: String
    let web_path: String
    let notes: [ServerGardenNote]
}

private struct GardensResponse: Decodable { let gardens: [ServerGarden] }
private struct GardenOk: Decodable { let ok: Bool }
private struct GardenTokenRequest: Encodable { let rotate: Bool }

struct NoteAccessMember: Decodable, Identifiable {
    let member_id: String
    let username: String?
    let display_name: String
    let avatar_color: String
    let avatar_url: String?
    let tends: Bool
    let is_owner: Bool
    let is_self: Bool
    var id: String { member_id }
}

struct NoteAccessResponse: Decodable {
    let owner_id: String
    let slug: String
    let title: String
    let members: [NoteAccessMember]
}

@Observable @MainActor
final class GardensStore {
    private let session: SessionStore
    var gardens: [ServerGarden] = []
    var loaded = false
    /// Which garden's tool page fills the main pane (nil → the chat).
    var openGardenId: String? = nil

    init(session: SessionStore) { self.session = session }

    func garden(_ id: String) -> ServerGarden? { gardens.first { $0.id == id } }

    private var api: APIClient? { session.serverURL.map { APIClient(baseURL: $0) } }

    func load() async {
        guard let api, let t = session.tokenForActiveUser else { return }
        if let resp: GardensResponse = try? await api.get("/api/v1/gardens", token: t) {
            gardens = resp.gardens
            loaded = true
        }
    }

    /// The garden's display theme. The personal garden keeps following the
    /// member's existing web-theme preference (Settings stays in agreement).
    func themeId(of g: ServerGarden) -> String {
        g.mine ? session.webTheme : g.web_theme
    }

    func setTheme(_ themeId: String, for g: ServerGarden) async {
        if g.mine {
            session.webTheme = themeId
            await session.savePreferences()
        }
        guard let api, let t = session.tokenForActiveUser else { return }
        let _: GardenOk? = try? await api.patch(
            "/api/v1/gardens/\(g.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? g.id)",
            body: ["web_theme": themeId], token: t)
        await load()
    }

    func noteAccess(_ n: ServerGardenNote) async -> NoteAccessResponse? {
        guard let api, let t = session.tokenForActiveUser else { return nil }
        return try? await api.get("/api/v1/gardens/note/\(n.owner_id)/\(n.slug)/access", token: t)
    }

    func share(_ n: ServerGardenNote, with memberId: String) async {
        guard let api, let t = session.tokenForActiveUser else { return }
        let _: GardenOk? = try? await api.post(
            "/api/v1/gardens/note/\(n.owner_id)/\(n.slug)/share",
            body: ["member_id": memberId], token: t)
        await load()
    }

    func leave(_ n: ServerGardenNote) async {
        guard let api, let t = session.tokenForActiveUser else { return }
        let _: GardenOk? = try? await api.post(
            "/api/v1/gardens/note/\(n.owner_id)/\(n.slug)/leave",
            body: [String: String](), token: t)
        await load()
    }

    /// People-named label: "My garden", "You & Paola", "The whole house".
    func label(for g: ServerGarden) -> String {
        if g.mine { return session.localized("gardens.mine") }
        let others = g.members.filter { $0.member_id != session.activeUserId }
        let householdSize = (session.currentHousehold?.deviceUsers ?? [])
            .filter { $0.role != "guest" }.count
        if householdSize > 2 && g.members.count >= householdSize {
            return session.localized("gardens.whole_house")
        }
        let parts = [session.localized("gardens.you")] + others.map(\.display_name)
        guard let last = parts.last, parts.count > 1 else { return parts.joined() }
        return parts.dropLast().joined(separator: ", ") + " & " + last
    }

    /// Everyone but me — the faces a shared set is recognized by.
    func others(of g: ServerGarden) -> [ServerParticipant] {
        g.members.filter { $0.member_id != session.activeUserId }.map(\.participant)
    }

    // ── Browsing (the boxed ↗): always through /login so the browser holds a
    // signed-in cookie before landing on the garden/note page.

    func browseGarden(_ g: ServerGarden) {
        Task {
            if g.mine {
                await open(to: nil, theme: themeId(of: g))
            } else {
                await open(to: g.web_path, theme: themeId(of: g))
            }
        }
    }

    func browseNote(_ n: ServerGardenNote) {
        Task { await open(to: n.web_path, theme: nil) }
    }

    /// host/path the garden lives at, for the page header's quiet meta line.
    func hostLine(for g: ServerGarden) -> String {
        guard let s = session.serverURL, let host = URL(string: s)?.host else { return g.web_path }
        return host + g.web_path
    }

    private func open(to path: String?, theme: String?) async {
        guard let s = session.serverURL, let token = await ensureToken() else { return }
        var url = "\(s)/login?token=\(token)"
        if let theme, let t = theme.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
            url += "&theme=\(t)"
        }
        if let path {
            var cs = CharacterSet.alphanumerics
            cs.insert(charactersIn: "-._~")
            if let to = path.addingPercentEncoding(withAllowedCharacters: cs) {
                url += "&to=\(to)"
            }
        }
        guard let u = URL(string: url) else { return }
        #if os(iOS)
        await UIApplication.shared.open(u)
        #elseif os(macOS)
        NSWorkspace.shared.open(u)
        #endif
    }

    private func ensureToken() async -> String? {
        guard let userId = session.activeUserId else { return nil }
        if let cached = session.mcpToken(for: userId) { return cached }
        guard let api, let t = session.tokenForActiveUser else { return nil }
        if let resp: McpTokenResponse = try? await api.post(
            "/api/users/me/mcp-token", body: GardenTokenRequest(rotate: false), token: t) {
            session.saveMcpToken(resp.rawToken, for: userId)
            return resp.rawToken
        }
        return nil
    }
}

/// Compact age stamp for note rows: today · 3d · 2w · 1mo.
func gardenAge(_ iso: String?, session: SessionStore) -> String {
    guard let iso, let d = parseServerDate(iso) else { return "" }
    let days = Int(Date().timeIntervalSince(d) / 86400)
    if days < 1 { return session.localized("gardens.today") }
    if days < 7 { return "\(days)d" }
    if days < 30 { return "\(days / 7)w" }
    if days < 365 { return "\(days / 30)mo" }
    return "\(days / 365)y"
}

/// Mono uppercase section kicker shared by GARDENS and CONVERSATIONS.
struct SidebarSectionHead: View {
    @Environment(\.mauriceTheme) private var theme
    let label: String
    var count: Int? = nil
    var expanded: Bool = true
    var onToggle: (() -> Void)? = nil

    var body: some View {
        Button { onToggle?() } label: {
            HStack(spacing: 6) {
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .semibold))
                    .rotationEffect(.degrees(expanded ? 0 : -90))
                Text(label)
                    .font(.system(size: 10, design: .monospaced))
                    .tracking(1.1)
                    .textCase(.uppercase)
                if let count {
                    Text("· \(count)")
                        .font(.system(size: 10, design: .monospaced))
                }
                Spacer(minLength: 0)
            }
            .foregroundStyle(theme.inkMute)
            .padding(.horizontal, 18)
            .padding(.top, 2)
            .padding(.bottom, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(onToggle == nil)
    }
}

/// One garden in the sidebar — lead (leaf for mine, faces for shared), the
/// people-name, then the two recognizable actions: boxed ↗ browses the garden
/// in the browser; the row itself (and its ›) opens the in-app garden tool.
private struct GardenRow: View {
    @Environment(SessionStore.self) private var session
    @Environment(GardensStore.self) private var gardens
    @Environment(\.mauriceTheme) private var theme
    let garden: ServerGarden
    let active: Bool
    let onOpen: () -> Void

    #if os(macOS)
    private let leadSize: CGFloat = 20
    private let labelSize: CGFloat = 13
    private let boxSize: CGFloat = 22
    private let boxRadius: CGFloat = 6
    private let chevSize: CGFloat = 12
    private let boxHit: CGFloat = 22
    #else
    private let leadSize: CGFloat = 26
    private let labelSize: CGFloat = 16
    private let boxSize: CGFloat = 32
    private let boxRadius: CGFloat = 9
    private let chevSize: CGFloat = 15
    private let boxHit: CGFloat = 36
    #endif

    private var accent: Color { session.activeDeviceUser?.color ?? .blue }

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 8) {
                if garden.mine {
                    Circle().fill(accent.opacity(0.14))
                        .frame(width: leadSize, height: leadSize)
                        .overlay(Image(systemName: "leaf")
                            .font(.system(size: leadSize * 0.55))
                            .foregroundStyle(accent.legible(onDark: theme.isDark)))
                } else {
                    AvatarStack(participants: gardens.others(of: garden),
                                serverBase: session.serverURL,
                                size: leadSize, ring: theme.surfaceAlt, max: 2)
                }
                Text(gardens.label(for: garden))
                    .font(.system(size: labelSize, weight: active ? .medium : .regular))
                    .foregroundStyle(active ? theme.ink : theme.inkSoft)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button { gardens.browseGarden(garden) } label: {
                    RoundedRectangle(cornerRadius: boxRadius, style: .continuous)
                        .strokeBorder(theme.ruleHard, lineWidth: 0.5)
                        .frame(width: boxSize, height: boxSize)
                        .overlay(Image(systemName: "arrow.up.forward")
                            .font(.system(size: boxSize * 0.44, weight: .medium))
                            .foregroundStyle(theme.inkSoft))
                        .frame(width: boxHit, height: boxHit)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(session.localized("gardens.browse_garden"))
                Image(systemName: "chevron.right")
                    .font(.system(size: chevSize * 0.8, weight: .semibold))
                    .foregroundStyle(active ? accent.legible(onDark: theme.isDark) : theme.inkMute)
            }
            .padding(.vertical, 2)
            .padding(.leading, 10)
            .padding(.trailing, 7)
            .frame(minHeight: 28)
            .background(active ? accent.opacity(0.12) : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(alignment: .leading) {
                if active {
                    RoundedRectangle(cornerRadius: 2).fill(accent)
                        .frame(width: 2)
                        .padding(.vertical, 8)
                        .offset(x: -1)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(session.localized("gardens.open_tool"))
    }
}

// MARK: - Garden tool page (the › destination: search · theme · manage notes)

struct GardenPageView: View {
    @Environment(SessionStore.self) private var session
    @Environment(GardensStore.self) private var gardens
    @Environment(\.mauriceTheme) private var theme
    let garden: ServerGarden
    var onOpenSidebar: () -> Void = {}
    /// Shows/hides the sidebar on iPad/regular width, from the toolbar's toggle.
    var onToggleSidebar: () -> Void = {}

    @State private var query = ""
    @State private var webThemes: [(id: String, label: String)] = [("default", "Default")]
    @State private var accessNote: ServerGardenNote?

    private var accent: Color { session.activeDeviceUser?.color ?? .blue }

    private var filteredNotes: [ServerGardenNote] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return garden.notes }
        return garden.notes.filter { $0.title.lowercased().contains(q) || $0.slug.contains(q) }
    }

    var body: some View {
        VStack(spacing: 0) {
            // iPhone draws the custom breadcrumb bar; iPad re-homes it into the
            // system toolbar (gardenToolbar) so iPadOS hosts the controls inline.
            if !Platform.isPad { topBar }
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    header
                    searchField
                        .padding(.top, 22)
                    SetKickerLine(session.localized("gardens.webtheme"))
                        .padding(.top, 24)
                    GardenThemeChips(themes: webThemes, active: gardens.themeId(of: garden), accent: accent) { id in
                        Task { await gardens.setTheme(id, for: garden) }
                    }
                    .padding(.top, 10)
                    Text(session.localized("gardens.webtheme_hint"))
                        .font(.system(size: 11.5))
                        .foregroundStyle(theme.inkMute)
                        .padding(.top, 8)
                    SetKickerLine(session.localized("gardens.all_notes"))
                        .padding(.top, 26)
                    notesCard
                        .padding(.top, 8)
                }
                .frame(maxWidth: 620)
                // Phone: edge-to-edge reading column (~16px) and the hero a
                // breath (~28px) under the context bar; the deep 40/46px
                // insets are desktop luxuries.
                #if os(iOS)
                .padding(.horizontal, 16)
                .padding(.top, 28)
                #else
                .padding(.horizontal, 40)
                .padding(.top, 46)
                #endif
                .padding(.bottom, 46)
                .frame(maxWidth: .infinity)
            }
        }
        .background(theme.bg)
        .navigationTitle("")
        #if os(iOS)
        // iPhone: no system bar — the custom breadcrumb bar is the page's one top
        // row. iPad: a real bar so iPadOS 26 hosts the window controls + sidebar
        // toggle inline; the breadcrumb is re-homed into `gardenToolbar`.
        .toolbar(Platform.isPad ? .visible : .hidden, for: .navigationBar)
        .toolbar { gardenToolbar }
        .toolbar(removing: .sidebarToggle)
        .navigationBarBackButtonHidden(Platform.isPad)
        #endif
        .task { await loadWebThemes() }
        .sheet(item: $accessNote) { note in
            NoteAccessSheet(note: note, garden: garden)
                .environment(session)
                .environment(gardens)
                .environment(\.mauriceTheme, theme)
                #if os(iOS)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
                #endif
        }
    }

    #if os(iOS)
    /// iPad only: the breadcrumb bar re-homed as toolbar items, so iPadOS 26 hosts
    /// the window controls + sidebar toggle inline. Emits nothing on iPhone.
    @ToolbarContentBuilder
    private var gardenToolbar: some ToolbarContent {
        if Platform.isPad {
            // Sidebar toggle + breadcrumb, one plain item (no glass capsule) —
            // replaces the custom breadcrumb bar and the collapsed back chevron.
            ToolbarItem(placement: .topBarLeading) {
                HStack(spacing: 8) {
                    Button { onToggleSidebar() } label: {
                        Image(systemName: "sidebar.leading")
                            .foregroundStyle(theme.inkSoft)
                    }
                    .buttonStyle(.plain)
                    if !garden.mine {
                        AvatarStack(participants: gardens.others(of: garden),
                                    serverBase: session.serverURL, size: 22, ring: theme.bg)
                    }
                    Text(gardens.label(for: garden))
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(theme.ink)
                        .lineLimit(1)
                    Text("/")
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(theme.inkMute)
                    Text(session.localized("gardens.garden"))
                        .font(.system(size: 15, design: .serif).italic())
                        .foregroundStyle(theme.inkSoft)
                        .lineLimit(1)
                }
            }
            .plainGlass()
            ToolbarItem(placement: .topBarTrailing) {
                Button { gardens.browseGarden(garden) } label: {
                    HStack(spacing: 6) {
                        Text(session.localized("gardens.browse"))
                            .font(.system(size: 12, weight: .medium))
                        Image(systemName: "arrow.up.forward")
                            .font(.system(size: 10, weight: .semibold))
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 11).padding(.vertical, 5)
                    .background(accent, in: Capsule())
                }
                .buttonStyle(.plain)
            }
        }
    }
    #endif

    /// Set context + the browser exit: in-app = tend, browser = stroll.
    /// One back affordance (the leading ‹), and for "My garden" no lead chip —
    /// the leaf lives in the hero only.
    private var topBar: some View {
        HStack(spacing: 10) {
            #if os(iOS)
            Button(action: onOpenSidebar) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(theme.inkSoft)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.leading, -12)
            #endif
            if !garden.mine {
                AvatarStack(participants: gardens.others(of: garden),
                            serverBase: session.serverURL, size: 22, ring: theme.bg)
            }
            Text(gardens.label(for: garden))
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(theme.ink)
                .lineLimit(1)
                .truncationMode(.tail)
            Text("/")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(theme.inkMute)
            Text(session.localized("gardens.garden"))
                .font(.system(size: 15, design: .serif).italic())
                .foregroundStyle(theme.inkSoft)
                .lineLimit(1)
            Spacer(minLength: 8)
            Button { gardens.browseGarden(garden) } label: {
                HStack(spacing: 6) {
                    Text(session.localized("gardens.browse"))
                        .font(.system(size: 11.5, weight: .medium))
                    Image(systemName: "arrow.up.forward")
                        .font(.system(size: 10, weight: .semibold))
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 11)
                .padding(.vertical, 5)
                .background(accent, in: Capsule())
                // The pill must never wrap — it sizes to content and the
                // breadcrumb texts give way instead.
                .fixedSize()
            }
            .buttonStyle(.plain)
        }
        #if os(iOS)
        .padding(.horizontal, 16)
        #else
        .padding(.horizontal, 22)
        #endif
        .frame(height: 52)
        .trafficLightInset()
        .overlay(alignment: .bottom) { Rectangle().fill(theme.rule).frame(height: 0.5) }
    }

    private var header: some View {
        HStack(spacing: 14) {
            if garden.mine {
                Circle().fill(accent.opacity(0.14)).frame(width: 30, height: 30)
                    .overlay(Image(systemName: "leaf").font(.system(size: 16)).foregroundStyle(accent.legible(onDark: theme.isDark)))
            } else {
                AvatarStack(participants: garden.members.map(\.participant),
                            serverBase: session.serverURL, size: 30, ring: theme.bg, max: 4)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(gardens.label(for: garden))
                    // Display serif at regular weight (Young Serif stays
                    // reserved for the wordmark), with the design's -0.01em.
                    .font(.system(size: 27, weight: .regular, design: .serif))
                    .tracking(-0.3)
                    .foregroundStyle(theme.ink)
                    .lineLimit(1)
                Text("\(garden.notes.count) \(session.localized("gardens.notes")) · \(gardens.hostLine(for: garden))")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(theme.inkMute)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
    }

    private var searchField: some View {
        HStack(spacing: 9) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 13))
                .foregroundStyle(theme.inkMute)
            TextField(session.localized("gardens.search"), text: $query)
                .textFieldStyle(.plain)
                .font(.system(size: 13.5))
                .foregroundStyle(theme.ink)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(theme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(theme.ruleHard, lineWidth: 0.5))
    }

    private var notesCard: some View {
        VStack(spacing: 0) {
            ForEach(Array(filteredNotes.enumerated()), id: \.element.id) { i, n in
                GardenNoteRow(note: n, last: i == filteredNotes.count - 1) {
                    accessNote = n
                }
            }
            if filteredNotes.isEmpty {
                Text(session.localized(query.isEmpty ? "gardens.empty" : "gardens.no_match"))
                    .font(.system(size: 12.5))
                    .foregroundStyle(theme.inkMute)
                    .frame(maxWidth: .infinity, minHeight: 56)
            }
        }
        .background(theme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(theme.rule, lineWidth: 0.5))
    }

    private func loadWebThemes() async {
        guard let serverURL = session.serverURL else { return }
        let api = APIClient(baseURL: serverURL)
        if let resp: GardenWebThemesResponse = try? await api.get("/api/web-themes", token: session.tokenForActiveUser),
           !resp.themes.isEmpty {
            webThemes = resp.themes.map { ($0.id, $0.name) }
        }
    }
}

private struct GardenWebThemesResponse: Decodable {
    struct Theme: Decodable { let id: String; let name: String }
    let themes: [Theme]
}

/// Mono uppercase kicker used by the garden page sections.
private struct SetKickerLine: View {
    @Environment(\.mauriceTheme) private var theme
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text)
            .font(.system(size: 9.5, design: .monospaced))
            .tracking(1.0)
            .textCase(.uppercase)
            .foregroundStyle(theme.inkMute)
    }
}

/// Wrapping pill chips — the active theme is the accent-filled one.
private struct GardenThemeChips: View {
    @Environment(\.mauriceTheme) private var theme
    let themes: [(id: String, label: String)]
    let active: String
    let accent: Color
    let onPick: (String) -> Void

    var body: some View {
        FlowHStack(spacing: 7) {
            ForEach(themes, id: \.id) { t in
                let on = t.id == active
                Button { onPick(t.id) } label: {
                    HStack(spacing: 6) {
                        if on {
                            Image(systemName: "checkmark")
                                .font(.system(size: 11, weight: .semibold))
                        }
                        Text(t.label)
                            .font(.system(size: 12, weight: on ? .medium : .regular))
                    }
                    .foregroundStyle(on ? .white : theme.inkSoft)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 5)
                    .background(on ? accent : Color.clear, in: Capsule())
                    .overlay {
                        if !on { Capsule().strokeBorder(theme.ruleHard, lineWidth: 0.5) }
                    }
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
    }
}

/// Minimal wrapping layout for the theme chips.
private struct FlowHStack: Layout {
    var spacing: CGFloat = 7

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > 0 && x + s.width > width { x = 0; y += rowH + spacing; rowH = 0 }
            x += s.width + spacing
            rowH = max(rowH, s.height)
        }
        return CGSize(width: width == .infinity ? x : width, height: y + rowH)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowH: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > bounds.minX && x + s.width > bounds.maxX { x = bounds.minX; y += rowH + spacing; rowH = 0 }
            v.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
            x += s.width + spacing
            rowH = max(rowH, s.height)
        }
    }
}

/// The design's hairline leaf (GsIcon "leaf", 16×16 box): decoration on note
/// rows, deliberately lighter than any tappable glyph.
private struct HairlineLeaf: Shape {
    func path(in rect: CGRect) -> Path {
        let s = rect.width / 16
        var p = Path()
        p.move(to: CGPoint(x: 12.8 * s, y: 3.2 * s))
        p.addCurve(to: CGPoint(x: 4 * s, y: 10.4 * s),
                   control1: CGPoint(x: 7 * s, y: 3.4 * s),
                   control2: CGPoint(x: 4 * s, y: 6.4 * s))
        p.addQuadCurve(to: CGPoint(x: 4.8 * s, y: 12.8 * s),
                       control: CGPoint(x: 4 * s, y: 12 * s))
        p.addCurve(to: CGPoint(x: 12.8 * s, y: 3.2 * s),
                   control1: CGPoint(x: 5.6 * s, y: 12 * s),
                   control2: CGPoint(x: 12.6 * s, y: 9 * s))
        p.closeSubpath()
        p.move(to: CGPoint(x: 3.2 * s, y: 13.6 * s))
        p.addQuadCurve(to: CGPoint(x: 11 * s, y: 6.4 * s),
                       control: CGPoint(x: 6.6 * s, y: 9.4 * s))
        return p
    }
}

/// One note in the garden tool — the same affordance pair as garden rows:
/// boxed ↗ browses the note on the web, › (and the row) opens NOTE ACCESS.
/// The glyphs stay small; on touch platforms their hit areas pad out to 44pt.
private struct GardenNoteRow: View {
    @Environment(SessionStore.self) private var session
    @Environment(GardensStore.self) private var gardens
    @Environment(\.mauriceTheme) private var theme
    let note: ServerGardenNote
    let last: Bool
    let onAccess: () -> Void

    #if os(macOS)
    private let rowMinHeight: CGFloat = 42
    private let hitSize: CGFloat = 20
    private let trailSpacing: CGFloat = 11
    #else
    private let rowMinHeight: CGFloat = 44
    private let hitSize: CGFloat = 44
    private let trailSpacing: CGFloat = 2
    #endif

    var body: some View {
        Button(action: onAccess) {
            HStack(spacing: 11) {
                HairlineLeaf()
                    .stroke(theme.inkMute, style: StrokeStyle(lineWidth: 1.3, lineCap: .round, lineJoin: .round))
                    .frame(width: 13, height: 13)
                Text(note.title)
                    .font(.system(size: 13.5))
                    .foregroundStyle(theme.ink)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: trailSpacing) {
                    Text(gardenAge(note.updated_at, session: session))
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(theme.inkMute)
                    Button { gardens.browseNote(note) } label: {
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .strokeBorder(theme.ruleHard, lineWidth: 0.5)
                            .frame(width: 20, height: 20)
                            .overlay(Image(systemName: "arrow.up.forward")
                                .font(.system(size: 9, weight: .medium))
                                .foregroundStyle(theme.inkSoft))
                            .frame(width: hitSize, height: hitSize)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help(session.localized("gardens.browse_note"))
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(theme.inkMute)
                }
            }
            .padding(.horizontal, 14)
            .frame(minHeight: rowMinHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(session.localized("gardens.note_access"))
        .overlay(alignment: .bottom) {
            if !last {
                Rectangle().fill(theme.rule).frame(height: 0.5).padding(.leading, 14)
            }
        }
    }
}

// MARK: - Note access (the › on a note: share wider / remove yourself)

private struct NoteAccessSheet: View {
    @Environment(SessionStore.self) private var session
    @Environment(GardensStore.self) private var gardens
    @Environment(\.mauriceTheme) private var theme
    @Environment(\.dismiss) private var dismiss
    let note: ServerGardenNote
    let garden: ServerGarden

    @State private var access: NoteAccessResponse?
    @State private var confirmLeave = false

    private var accent: Color { session.activeDeviceUser?.color ?? .blue }
    private var selfMember: NoteAccessMember? { access?.members.first { $0.is_self } }

    /// "in the garden you tend with Paola" / "in your personal garden"
    private var contextLine: String {
        let others = garden.members.filter { $0.member_id != session.activeUserId }
        if others.isEmpty { return session.localized("gardens.in_your_garden") }
        return session.localized("gardens.in_garden_with",
                                 others.map(\.display_name).joined(separator: ", "))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(session.localized("gardens.note_access"))
                        .font(.system(size: 9.5, design: .monospaced))
                        .tracking(1.4)
                        .textCase(.uppercase)
                        .foregroundStyle(theme.inkMute)
                    Text(note.title)
                        .font(.system(size: 21, design: .serif))
                        .foregroundStyle(theme.ink)
                    Text(contextLine)
                        .font(.system(size: 9.5, design: .monospaced))
                        .foregroundStyle(theme.inkMute)
                }
                Spacer()
                Button { dismiss() } label: {
                    Text("OK").font(.system(size: 14, weight: .semibold)).foregroundStyle(accent.legible(onDark: theme.isDark))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 20)
            .padding(.top, 18)

            VStack(alignment: .leading, spacing: 12) {
                VStack(spacing: 0) {
                    let members = access?.members ?? []
                    ForEach(Array(members.enumerated()), id: \.element.id) { i, m in
                        memberRow(m, last: i == members.count - 1)
                    }
                    if members.isEmpty {
                        ProgressView().frame(maxWidth: .infinity, minHeight: 88)
                    }
                }
                .background(theme.surfaceAlt, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(theme.rule, lineWidth: 0.5))

                Text(session.localized("gardens.share_hint"))
                    .font(.system(size: 11.5))
                    .lineSpacing(3)
                    .foregroundStyle(theme.inkMute)

                if let me = selfMember, me.tends, !me.is_owner {
                    HStack(spacing: 12) {
                        Button { confirmLeave = true } label: {
                            Text(session.localized("gardens.remove_self"))
                                .font(.system(size: 12.5, weight: .medium))
                                .foregroundStyle(Color(hex: "b3382c").legible(onDark: theme.isDark))
                        }
                        .buttonStyle(.plain)
                        Text(session.localized("gardens.remove_hint"))
                            .font(.system(size: 11))
                            .foregroundStyle(theme.inkMute)
                    }
                    .padding(.top, 2)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 14)
            .padding(.bottom, 18)
        }
        .frame(minWidth: 340, idealWidth: 380, maxWidth: 420, alignment: .topLeading)
        .background(theme.surface)
        .presentationBackground(theme.surface)
        .task { access = await gardens.noteAccess(note) }
        .confirmationDialog(session.localized("gardens.remove_self"), isPresented: $confirmLeave) {
            Button(session.localized("gardens.remove_self_confirm"), role: .destructive) {
                Task {
                    await gardens.leave(note)
                    dismiss()
                }
            }
        }
    }

    @ViewBuilder
    private func memberRow(_ m: NoteAccessMember, last: Bool) -> some View {
        HStack(spacing: 11) {
            UserAvatar(avatarURL: m.avatar_url, serverURL: session.serverURL,
                       initial: String(m.display_name.prefix(1)),
                       color: Color(hex: m.avatar_color), size: 26)
            VStack(alignment: .leading, spacing: 1) {
                Text(m.display_name)
                    .font(.system(size: 13))
                    .foregroundStyle(theme.ink)
                if m.is_self {
                    Text(session.localized("gardens.you_tag"))
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(theme.inkMute)
                }
            }
            Spacer(minLength: 8)
            if m.tends {
                Text(session.localized("gardens.tends"))
                    .font(.system(size: 8.5, design: .monospaced))
                    .tracking(0.8)
                    .textCase(.uppercase)
                    .foregroundStyle(theme.inkSoft)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .overlay(Capsule().strokeBorder(theme.ruleHard, lineWidth: 0.5))
            } else {
                Button {
                    Task {
                        await gardens.share(note, with: m.member_id)
                        access = await gardens.noteAccess(note)
                    }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "plus")
                            .font(.system(size: 9, weight: .bold))
                        Text(session.localized("gardens.share"))
                            .font(.system(size: 11.5, weight: .medium))
                    }
                    .foregroundStyle(accent.legible(onDark: theme.isDark))
                    .padding(.horizontal, 11)
                    .padding(.vertical, 4)
                    .overlay(Capsule().strokeBorder(accent.legible(onDark: theme.isDark), lineWidth: 0.5))
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 13)
        .frame(minHeight: 44)
        .overlay(alignment: .bottom) {
            if !last {
                Rectangle().fill(theme.rule).frame(height: 0.5).padding(.leading, 13)
            }
        }
    }
}

/// The foyer list — sheet body on phone, popover body on desktop.
struct FoyerSwitcherView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.mauriceTheme) private var theme
    var showHeader: Bool = true
    var compact: Bool = false
    let onPick: (String) -> Void
    let onAdd: () -> Void
    let onDismiss: () -> Void

    private var accent: Color { session.currentHousehold?.foyerColor ?? theme.ink }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if showHeader {
                HStack(alignment: .bottom) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(session.localized("foyer.switch_overline")) · \(session.households.count)")
                            .font(.system(size: 9.5, design: .monospaced))
                            .tracking(1.2)
                            .textCase(.uppercase)
                            .foregroundStyle(theme.inkMute)
                        Text(session.localized("foyer.switch_title"))
                            .font(.system(size: 22, design: .serif))
                            .foregroundStyle(theme.ink)
                    }
                    Spacer()
                    Button(action: onDismiss) {
                        Text("OK").font(.system(size: 15, weight: .semibold)).foregroundStyle(accent.legible(onDark: theme.isDark))
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 18)
                .padding(.top, 8)
                .padding(.bottom, 14)
            }
            ScrollView {
                VStack(spacing: 2) {
                    ForEach(session.households) { h in
                        FoyerRow(household: h, active: h.id == session.currentHouseholdId, compact: compact) {
                            onPick(h.id)
                        }
                    }
                    Button(action: onAdd) {
                        HStack(spacing: 12) {
                            RoundedRectangle(cornerRadius: compact ? 9 : 11, style: .continuous)
                                .strokeBorder(theme.ruleHard, style: StrokeStyle(lineWidth: 1, dash: [3]))
                                .frame(width: compact ? 30 : 38, height: compact ? 30 : 38)
                                .overlay(Image(systemName: "plus")
                                    .font(.system(size: 13, weight: .medium))
                                    .foregroundStyle(theme.inkSoft))
                            Text(session.localized("household.add"))
                                .font(.system(size: compact ? 13.5 : 15))
                                .foregroundStyle(theme.ink)
                            Spacer()
                        }
                        .padding(.vertical, compact ? 8 : 11)
                        .padding(.horizontal, 12)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 16)
            }
        }
        .background(theme.surface)
    }
}
