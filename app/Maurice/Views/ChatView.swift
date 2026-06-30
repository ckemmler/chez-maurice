import SwiftUI
import PhotosUI
import MarkdownUI
import ImageIO
import UniformTypeIdentifiers
import SwiftMath

struct ChatView: View {
    @Environment(ChatService.self) private var chat
    @Environment(SessionStore.self) private var session
    @Environment(ComposerStore.self) private var composer
    @Environment(MauriceStore.self) private var maurices
    @Environment(StudioState.self) private var studio
    @Environment(\.mauriceTheme) private var theme
    @State private var inputText = ""
    @State private var pendingImageData: Data?
    @State private var showAddContext = false
    @State private var showAddParticipant = false
    @State private var showTools = false
    @State private var trayOpen = false
    /// Whether the stream is "following" the bottom. Goes false when the user
    /// scrolls up mid-answer, so tokens don't yank them back down.
    @State private var isNearBottom = true
    /// Force one scroll-to-bottom after a (re)load, regardless of scroll state.
    @State private var pendingScrollToBottom = true
    @FocusState private var isInputFocused: Bool

    private var accent: Color { session.activeDeviceUser?.color ?? .blue }

    /// Reveals the sidebar on the compact (iPhone) layout, where it is hidden
    /// behind the chat. No-op on iPad/Mac, where the sidebar is always visible.
    var onOpenSidebar: () -> Void = {}
    /// Shows/hides the sidebar on iPad/regular width, from the toolbar's toggle.
    var onToggleSidebar: () -> Void = {}

    var body: some View {
        Group {
            #if os(iOS)
            // Phone: header on top, stream fills the rest; the composer floats
            // over it as a glass panel via a bottom inset.
            VStack(spacing: 0) {
                // iPhone draws its own header row; iPad re-homes it into the system
                // toolbar (see chatToolbar) so iPadOS hosts the window controls inline.
                if !Platform.isPad {
                    if let convo = chat.activeConversation {
                        ConversationHeaderView(conversation: convo, onBack: {
                            // Don't persist a brand-new conversation the user backed
                            // out of without typing anything (no messages, empty input).
                            if inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                Task { await chat.discardActiveIfEmpty() }
                            }
                            onOpenSidebar()
                        })
                    } else {
                        // No active conversation (a fresh member with no history) —
                        // still give a way into the sidebar, or the user is stranded
                        // on the empty greeting with no navigation at all.
                        EmptyConversationHeader(onOpenSidebar: onOpenSidebar)
                    }
                }
                streamView
            }
            .background(theme.bg)
            .safeAreaInset(edge: .bottom, spacing: 0) { composerDock }
            #else
            VStack(spacing: 0) {
                if let convo = chat.activeConversation {
                    // Conversation header — shown from the start so a room can have
                    // people added before the first message.
                    ConversationHeaderView(conversation: convo)
                }
                streamView
                composerDock
            }
            .background(theme.surface)
            #endif
        }
        .sheet(isPresented: $showAddContext) {
            #if os(iOS)
            AddContextSheet(accent: accent)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
            #else
            AddContextSheet(accent: accent)
            #endif
        }
        .sheet(isPresented: $showTools) {
            if let convo = chat.activeConversation {
                ConversationToolsSheet(conversationId: convo.id,
                                       accent: maurices.maurice(for: convo.maurice_id).paletteValue.bg)
                #if os(iOS)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
                #endif
            }
        }
        .task(id: chat.activeConversationId) {
            isNearBottom = true // a freshly opened thread follows to the latest
            let m = maurices.maurice(for: chat.activeConversation?.maurice_id)
            await composer.setConversation(
                chat.activeConversationId,
                lockedName: m.isEveryday ? "" : m.name,
                lockedCount: m.isEveryday ? 0 : m.count,
                lockedWeight: m.isEveryday ? 0 : m.weight
            )
        }
        .navigationTitle("")
        #if os(iOS)
        // iPhone: no system bar — the custom header is our top row (its own back
        // chevron). iPad: a real bar so iPadOS 26 hosts the window controls +
        // sidebar toggle inline; the header content is re-homed into `chatToolbar`.
        .toolbar(Platform.isPad ? .visible : .hidden, for: .navigationBar)
        .toolbar { chatToolbar }
        // Drop the auto sidebar toggle so our explicit one (in chatToolbar) can't double.
        .toolbar(removing: .sidebarToggle)
        // Kill the collapsed-split back chevron on iPad — our toolbar toggle is the
        // single way back to the list. (The collapse is a NavigationStack, so the
        // chevron is a real back button, not the sidebar toggle.)
        .navigationBarBackButtonHidden(Platform.isPad)
        .sheet(isPresented: $showAddParticipant) { AddParticipantSheet() }
        #endif
    }

    #if os(iOS)
    private var activeMaurice: Maurice { maurices.maurice(for: chat.activeConversation?.maurice_id) }
    private var isMulti: Bool { chat.participants.count > 1 }

    /// iPad only: the conversation header re-homed as toolbar items, so iPadOS 26
    /// hosts the window controls + sidebar toggle inline in a real bar. Emits
    /// nothing on iPhone (which keeps its custom header row).
    @ToolbarContentBuilder
    private var chatToolbar: some ToolbarContent {
        if Platform.isPad {
            // Sidebar toggle + (hat) + conversation title, as one plain item (no
            // glass capsule) — replaces both the custom header row and the
            // collapsed back chevron (which we hide via navigationBarBackButtonHidden).
            ToolbarItem(placement: .topBarLeading) {
                HStack(spacing: 9) {
                    Button { onToggleSidebar() } label: {
                        Image(systemName: "sidebar.leading")
                            .foregroundStyle(theme.inkSoft)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(session.localized("chat.back_to_conversations"))
                    if !activeMaurice.isEveryday {
                        HatBadge(kind: activeMaurice.hat, palette: activeMaurice.paletteValue, size: 26, radius: 8)
                    }
                    Text(chat.activeConversation?.title ?? session.localized("chat.new_conversation"))
                        .font(.system(size: 17, design: .serif))
                        .foregroundStyle(theme.ink)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            .plainGlass()
            ToolbarItemGroup(placement: .topBarTrailing) {
                if isMulti {
                    AvatarStack(participants: chat.participants, serverBase: session.serverURL,
                                size: 24, ring: theme.bg, max: 4)
                }
                Button { showAddParticipant = true } label: {
                    Image(systemName: "person.badge.plus")
                }
                .help(session.localized("chat.add_someone_help"))
                if !activeMaurice.isEveryday {
                    Button { studio.openCreator(activeMaurice, isEdit: true) } label: {
                        Text(session.localized("chat.edit_maurice"))
                    }
                }
            }
        }
    }
    #endif

    /// The scrolling conversation (or the empty state) + an error banner.
    @ViewBuilder
    private var streamView: some View {
        VStack(spacing: 0) {
            if !chat.messages.isEmpty {
                GeometryReader { outer in
                  ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 22) {
                            ForEach(Array(chat.messages.enumerated()), id: \.element.id) { index, message in
                                MessageRow(message: message, isLast: index == chat.messages.count - 1)
                                    .id(message.id)
                            }

                            // Streaming row — kept alive with a stable id so
                            // @State (visibleLength) persists across text updates.
                            if chat.isStreaming {
                                if chat.isGeneratingImage {
                                    ImageGeneratingIndicator()
                                } else {
                                    if let activity = chat.toolActivity {
                                        ToolActivityIndicator(label: activity)
                                    }
                                    // Structured tool results stream in (often
                                    // before the prose) — show them live.
                                    if !chat.streamingData.isEmpty {
                                        DataCardStack(blocks: chat.streamingData)
                                    }
                                    if chat.streamingText.isEmpty {
                                        if chat.toolActivity == nil && chat.streamingData.isEmpty {
                                            StreamingIndicator()
                                        }
                                    } else {
                                        StreamingRow(text: chat.streamingText, serverBaseURL: session.serverURL ?? "")
                                    }
                                }
                            } else if chat.pendingSummon {
                                // Observer's view: someone else summoned Maurice
                                // and his reply hasn't arrived over the socket yet.
                                StreamingIndicator()
                            }

                            // Permanent bottom anchor: the scroll target AND the
                            // probe for "is the user near the bottom?".
                            Color.clear.frame(height: 1).id("bottom")
                                .background(GeometryReader { g in
                                    Color.clear.preference(
                                        key: ChatBottomAnchorKey.self,
                                        value: g.frame(in: .named("chatScroll")).minY
                                    )
                                })
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        #if os(iOS)
                        .padding(.vertical, 18)
                        .padding(.horizontal, 16)
                        #else
                        .padding(.vertical, 26)
                        .padding(.horizontal, 36)
                        #endif
                    }
                    .coordinateSpace(name: "chatScroll")
                    // Any scroll hides the keyboard; tokens only auto-follow while
                    // the user is near the bottom, so scrolling up to re-read an
                    // answer mid-stream isn't yanked back down.
                    .scrollDismissesKeyboard(.immediately)
                    .onAppear {
                        // Land at the bottom when the thread first appears (the
                        // view may mount with messages already loaded).
                        DispatchQueue.main.async { proxy.scrollTo("bottom", anchor: .bottom) }
                    }
                    .onPreferenceChange(ChatBottomAnchorKey.self) { minY in
                        isNearBottom = (minY - outer.size.height) < 120
                    }
                    .onChange(of: chat.activeConversationId) {
                        // Opening/switching a thread: snap to the latest, follow.
                        isNearBottom = true
                        pendingScrollToBottom = true
                    }
                    .onChange(of: chat.streamingText.count) {
                        if isNearBottom { scrollToBottom(proxy) }
                    }
                    .onChange(of: chat.messages.count) {
                        if pendingScrollToBottom {
                            // First population after a (re)load — always snap.
                            pendingScrollToBottom = false
                            scrollToBottom(proxy)
                        } else if chat.messages.last?.role == "user" || isNearBottom {
                            // Snap for a message the user just sent; otherwise only
                            // follow if they haven't scrolled away.
                            scrollToBottom(proxy)
                        }
                    }
                  }
                }
            } else {
                // The greeting reflects the ARMED Maurice (currentMauriceId) — in a
                // brand-new conversation it isn't persisted as the conversation's
                // maurice_id until the first message, so use what's armed for the thread.
                let boundMaurice = maurices.maurice(for: chat.currentMauriceId)
                Group {
                    if boundMaurice.isEveryday {
                        EmptyState()
                    } else {
                        StudioGreeting(maurice: boundMaurice)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .contentShape(Rectangle())
                .onTapGesture { isInputFocused = false }
            }

            if let error = chat.error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity)
                    .background(.red.opacity(0.85))
            }
        }
    }

    /// Context tray (when populated) + the message bar.
    @ViewBuilder
    private var composerDock: some View {
        #if os(iOS)
        // Phone: the tray is hidden during chat — summoned by + or the ctx pill,
        // dismissed by Done. The + opens both the panel and the search sheet.
        VStack(spacing: 8) {
            if trayOpen {
                ContextTray(accent: accent,
                            onDone: { trayOpen = false },
                            onAddMore: { showAddContext = true })
            }
            ComposerBar(inputText: $inputText, pendingImageData: $pendingImageData,
                        isFocused: _isInputFocused,
                        onAddContext: { trayOpen = true; showAddContext = true },
                        onOpenTools: { showTools = true },
                        trayOpen: trayOpen,
                        onToggleTray: { trayOpen.toggle() },
                        onPostBubble: { postBubbleMessage() }) {
                sendMessage()
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        #else
        // Mac: like iOS, the tray is hidden during chat and toggled from the ctx
        // pill in the input row — so it doesn't sit on top of the field — and
        // dismissed by Done.
        VStack(spacing: 8) {
            if trayOpen {
                ContextTray(accent: accent,
                            onDone: { trayOpen = false },
                            onAddMore: { showAddContext = true })
            }
            ComposerBar(inputText: $inputText, pendingImageData: $pendingImageData,
                        isFocused: _isInputFocused,
                        onAddContext: { trayOpen = true; showAddContext = true },
                        onOpenTools: { showTools = true },
                        trayOpen: trayOpen,
                        onToggleTray: { trayOpen.toggle() },
                        onPostBubble: { postBubbleMessage() }) {
                sendMessage()
            }
        }
        #endif
    }

    private func sendMessage() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        let imageData = pendingImageData
        guard !text.isEmpty || imageData != nil else { return }
        inputText = ""
        pendingImageData = nil
        trayOpen = false
        Task { await chat.send(text, imageData: imageData) }
    }

    /// 💬 — post a human-only turn (no Maurice summon).
    private func postBubbleMessage() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        let imageData = pendingImageData
        guard !text.isEmpty || imageData != nil else { return }
        inputText = ""
        pendingImageData = nil
        trayOpen = false
        Task { await chat.postBubble(text, imageData: imageData) }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        withAnimation(.easeOut(duration: 0.2)) {
            proxy.scrollTo("bottom", anchor: .bottom)
        }
    }
}

/// Reports the bottom anchor's position within the scroll viewport, so we can
/// tell whether the user is following the stream or has scrolled up to re-read.
private struct ChatBottomAnchorKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

// MARK: - Conversation Header

/// iPhone-only minimal header for the empty state (no active conversation yet),
/// so a fresh member can always reach the sidebar / conversation list instead of
/// being stranded on the greeting.
private struct EmptyConversationHeader: View {
    @Environment(\.mauriceTheme) private var theme
    @Environment(SessionStore.self) private var session
    var onOpenSidebar: () -> Void = {}

    var body: some View {
        HStack(spacing: 11) {
            Button { onOpenSidebar() } label: {
                Image(systemName: "sidebar.left")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(theme.inkSoft)
                    .frame(width: 44, height: 44)
                    .overlay(Circle().strokeBorder(theme.ruleHard, lineWidth: 0.75))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(session.localized("chat.back_to_conversations"))
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16).padding(.vertical, 11)
        .trafficLightInset()
        .overlay(alignment: .bottom) {
            Rectangle().fill(theme.rule).frame(height: 0.5)
        }
    }
}

private struct ConversationHeaderView: View {
    @Environment(ChatService.self) private var chat
    @Environment(SessionStore.self) private var session
    @Environment(MauriceStore.self) private var maurices
    @Environment(StudioState.self) private var studio
    @Environment(\.mauriceTheme) private var theme
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var hSize
    #endif
    let conversation: ServerConversation
    /// Reveal the sidebar (compact only) — the header carries its own back chevron.
    var onBack: () -> Void = {}
    @State private var showAdd = false
    @State private var showReports = false
    @State private var showLeaveConfirm = false

    private var maurice: Maurice { maurices.maurice(for: conversation.maurice_id) }
    private var multi: Bool { chat.participants.count > 1 }
    private var isCompact: Bool {
        #if os(iOS)
        return hSize == .compact
        #else
        return false
        #endif
    }

    var body: some View {
        HStack(spacing: 11) {
            // Compact: a back chevron at the left of the metadata returns to the
            // conversation list (there is no system nav bar).
            if isCompact {
                Button { onBack() } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(theme.inkSoft)
                        .frame(width: 44, height: 44)
                        .overlay(Circle().strokeBorder(theme.ruleHard, lineWidth: 0.75))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(session.localized("chat.back_to_conversations"))
            }
            // Hat badge only for a specialized Maurice; the everyday one shows none.
            if !maurice.isEveryday {
                HatBadge(kind: maurice.hat, palette: maurice.paletteValue, size: 30, radius: 9)
            }
            // Title + meta — the ONLY growing child, so the title keeps its width
            // and never truncates to make room for the trailing controls.
            VStack(alignment: .leading, spacing: 2) {
                Text(conversation.title ?? session.localized("chat.new_conversation"))
                    .font(.system(size: 18, design: .serif))
                    .foregroundStyle(theme.ink)
                    .lineLimit(1).truncationMode(.tail)
                Text(metaLine)
                    .font(.system(size: 9.5, design: .monospaced))
                    .foregroundStyle(theme.inkSoft)
                    .lineLimit(1).truncationMode(.tail)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            // Trailing controls — all fixed-width (flex-shrink:0).
            if multi {
                AvatarStack(participants: chat.participants, serverBase: session.serverURL,
                            size: 26, ring: theme.bg, max: 4)
            }
            trailingControls
        }
        #if os(iOS)
        .padding(.horizontal, 16).padding(.vertical, 11)
        #else
        .padding(.horizontal, 28).padding(.vertical, 12)
        #endif
        .trafficLightInset()
        .overlay(alignment: .bottom) {
            Rectangle().fill(theme.rule).frame(height: 0.5)
        }
        .sheet(isPresented: $showAdd) { AddParticipantSheet() }
        .sheet(isPresented: $showReports) { ReportsReviewView() }
        .confirmationDialog("Leave this room?", isPresented: $showLeaveConfirm, titleVisibility: .visible) {
            Button("Leave room", role: .destructive) { Task { await chat.leaveRoom() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("You'll stop receiving this room's messages. You can be added back later.")
        }
    }

    /// Add-someone is always a direct button. "Edit Maurice" is a roomy
    /// (desktop/iPad) affordance — on the phone you edit from the picker or the
    /// empty-state greeting, keeping the header uncluttered.
    @ViewBuilder
    private var trailingControls: some View {
        Button { showAdd = true } label: {
            Image(systemName: "person.badge.plus")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(theme.inkSoft)
                .frame(width: 44, height: 44)
                .overlay(Circle().strokeBorder(theme.ruleHard, lineWidth: 0.75))
        }
        .buttonStyle(.plain)
        .padding(.trailing, 2)
        .help(session.localized("chat.add_someone_help"))

        if !isCompact, !maurice.isEveryday {
            Button { studio.openCreator(maurice, isEdit: true) } label: {
                Text(session.localized("chat.edit_maurice"))
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(theme.inkSoft)
                    .padding(.horizontal, 11).padding(.vertical, 6)
                    .overlay(Capsule().strokeBorder(theme.rule, lineWidth: 0.5))
            }
            .buttonStyle(.plain)
        }

        // Shared-room menu: leave (everyone) + review reports (operator).
        if multi {
            Menu {
                if session.activeDeviceUser?.role == "admin" {
                    Button { showReports = true } label: { Label("Review reports", systemImage: "flag") }
                }
                Button(role: .destructive) { showLeaveConfirm = true } label: {
                    Label("Leave room", systemImage: "rectangle.portrait.and.arrow.right")
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(theme.inkSoft)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
        }
    }

    /// "{when} · {Maurice name}" on phone; "· {model}" appended on roomy headers.
    private var metaLine: String {
        var parts: [String] = []
        if let at = formattedAt { parts.append(at) }
        parts.append(maurice.name)
        if !isCompact {
            let model = maurices.modelName(for: maurice)
            if !model.isEmpty { parts.append(model.lowercased()) }
        }
        return parts.joined(separator: " · ")
    }

    private var formattedAt: String? {
        let raw = conversation.last_message_at ?? conversation.updated_at
        guard let date = parseServerDate(raw) else { return nil }
        let cal = Calendar.current
        let t = DateFormatter(); t.dateFormat = "H:mm"
        let time = t.string(from: date)
        if cal.isDateInToday(date) { return session.localized("time.today", time) }
        if cal.isDateInYesterday(date) { return session.localized("time.yesterday", time) }
        let d = DateFormatter(); d.dateFormat = "MMM d"
        return "\(d.string(from: date)) · \(time)"
    }
}

/// Per-conversation tool-family override — narrow (or widen) which tool groups
/// Maurice may use here, on top of the bound Maurice's own setting.
private struct ConversationToolsSheet: View {
    @Environment(MauriceStore.self) private var store
    @Environment(ChatService.self) private var chat
    @Environment(\.mauriceTheme) private var theme
    @Environment(\.dismiss) private var dismiss
    let conversationId: String
    let accent: Color

    @State private var selected: Set<String> = []

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button(L("common.cancel")) { dismiss() }.foregroundStyle(theme.inkSoft)
                Spacer()
                Text(L("chat.tools_title")).font(.system(size: 15, weight: .semibold)).foregroundStyle(theme.ink)
                Spacer()
                Button(L("common.save")) { save() }.fontWeight(.semibold).foregroundStyle(accent.legible(onDark: theme.isDark))
            }
            .padding(16)
            Divider().overlay(theme.rule)
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(L("chat.tools_hint"))
                        .font(.system(size: 12)).foregroundStyle(theme.inkSoft)
                    ToolFamilyPicker(families: store.families, selected: $selected, accent: accent)
                }
                .padding(18)
            }
        }
        .background(theme.surface)
        .task {
            if store.families.isEmpty { await store.loadFamilies() }
            if let cf = await chat.conversationFamilies(conversationId) {
                selected = Set(cf.selected)
            }
        }
    }

    private func save() {
        Task {
            await chat.setConversationFamilies(conversationId, Array(selected))
            dismiss()
        }
    }
}

/// Pick a household member to add to the room. Access to the commons will later
/// flow from having been present here.
private struct AddParticipantSheet: View {
    @Environment(ChatService.self) private var chat
    @Environment(SessionStore.self) private var session
    @Environment(\.mauriceTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    private var candidates: [ServerUser] {
        let existing = Set(chat.participants.map { $0.member_id })
        return chat.roster.filter { !existing.contains($0.id) }
    }

    /// Everyone currently in the room except you — removable (e.g. added by mistake).
    private var others: [ServerParticipant] {
        chat.participants.filter { $0.member_id != session.activeUserId }
    }

    var body: some View {
        NavigationStack {
            List {
                // Current roster — remove anyone added by mistake.
                if !others.isEmpty {
                    Section(L("chat.in_this_room")) {
                        ForEach(others) { p in
                            HStack(spacing: 12) {
                                UserAvatar(avatarURL: p.avatar_url, serverURL: session.serverURL,
                                           initial: p.initial, color: p.color, size: 28)
                                Text(p.display_name)
                                Spacer()
                                Button(role: .destructive) {
                                    Task { await chat.removeParticipant(memberId: p.member_id) }
                                } label: {
                                    Image(systemName: "minus.circle.fill")
                                        .foregroundStyle(.red.opacity(0.8))
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(L("chat.remove_participant"))
                            }
                        }
                    }
                }

                Section(L("chat.add_to_room")) {
                    if candidates.isEmpty {
                        Text(L("chat.everyone_here"))
                            .foregroundStyle(theme.inkMute)
                    } else {
                        ForEach(candidates) { u in
                            Button {
                                Task { await chat.addParticipant(memberId: u.id); dismiss() }
                            } label: {
                                HStack(spacing: 12) {
                                    UserAvatar(avatarURL: u.avatar_url, serverURL: session.serverURL,
                                               initial: String(u.display_name.prefix(1)),
                                               color: Color(hex: u.avatar_color), size: 28)
                                    Text(u.display_name)
                                    Spacer()
                                    Image(systemName: "plus").foregroundStyle(theme.inkMute)
                                }
                            }
                            .tint(theme.ink)
                        }
                    }
                }
            }
            .navigationTitle(L("chat.participants_title"))
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L("common.done")) { dismiss() }
                }
            }
            .task { await chat.loadRoster() }
        }
    }
}

// MARK: - Empty State

private struct EmptyState: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.mauriceTheme) private var theme

    var body: some View {
        VStack(spacing: 18) {
            Spacer()

            BoaterHat(size: 36, color: theme.ink, ribbonColor: theme.surface)

            if let user = session.activeDeviceUser {
                Text(session.localized("chat.greeting", user.displayName))
                    .font(.system(size: 32, design: .serif))
                    .italic()
                    .foregroundStyle(theme.ink)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 48)
            }

            Text("chat.new_conversation_hint")
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(theme.inkMute)
                .tracking(0.5)

            Spacer()
        }
    }
}

// MARK: - Message Row

private struct MessageRow: View {
    @Environment(SessionStore.self) private var session
    @Environment(ChatService.self) private var chat
    @Environment(\.mauriceTheme) private var theme
    let message: ServerMessage
    /// Regenerate is only offered on the final message (redoing an earlier
    /// answer would orphan everything after it).
    var isLast: Bool = false
    @State private var didCopy = false
    @State private var showReport = false

    /// The participant who authored this turn (nil for Maurice, or a 1:1 chat
    /// where the row falls back to the device user).
    private var authorParticipant: ServerParticipant? {
        guard let aid = message.author_id else { return nil }
        return chat.participantsById[aid]
    }

    /// Extract first image markdown from content
    private var imageInfo: (alt: String, path: String)? {
        let pattern = /!\[(.+?)\]\((\/api\/images\/.+?)\)/
        guard let match = message.content.firstMatch(of: pattern) else { return nil }
        return (String(match.1), String(match.2))
    }

    /// Text content with image markdown stripped
    private var textContent: String {
        let pattern = /!\[.+?\]\(\/api\/images\/.+?\)\n*/
        return message.content.replacing(pattern, with: "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        #if os(iOS)
        phoneBody
        #else
        desktopBody
        #endif
    }

    /// Desktop window: avatar gutter + uppercase name row.
    private var desktopBody: some View {
        HStack(alignment: .top, spacing: 14) {
            avatar
            VStack(alignment: .leading, spacing: 4) {
                nameRow
                messageContent
                if message.role == "assistant" { actionRow }
            }
        }
    }

    /// Phone: edge-to-edge, no avatars, bigger type. Maurice gets an
    /// italic-serif label; the user gets a right-aligned bubble.
    private var phoneBody: some View {
        Group {
            if message.role == "user" {
                HStack(spacing: 0) {
                    Spacer(minLength: 40)
                    VStack(alignment: .leading, spacing: 4) {
                        // In a room, name the sender; in a 1:1 it's unambiguous.
                        if chat.isRoom, let name = userDisplayName {
                            Text(name)
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle((authorParticipant?.color ?? session.activeDeviceUser?.color ?? theme.inkMute).legible(onDark: theme.isDark))
                        }
                        messageContent
                    }
                    .padding(.horizontal, 15)
                    .padding(.vertical, 11)
                    .background(RoundedRectangle(cornerRadius: 18).fill(theme.surfaceAlt))
                }
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Maurice")
                        .font(.system(size: 13, design: .serif)).italic()
                        .foregroundStyle(theme.inkMute)
                    messageContent
                    actionRow
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    /// Message body wrapped with the shared-room safety menu (Report / Block).
    private var messageContent: some View {
        messageContentCore
            .contextMenu { roomSafetyMenu }
            .sheet(isPresented: $showReport) {
                ReportSheet(targetType: "message", targetId: message.id)
            }
    }

    /// Report / Block — only in a shared room.
    @ViewBuilder
    private var roomSafetyMenu: some View {
        if chat.isRoom {
            Button { showReport = true } label: { Label("Report message", systemImage: "flag") }
            if let aid = message.author_id, aid != session.activeUserId {
                Button(role: .destructive) {
                    Task { await chat.block(memberId: aid) }
                } label: {
                    Label("Block \(authorParticipant?.display_name ?? "user")", systemImage: "hand.raised")
                }
            }
        }
    }

    /// Image (if any) + markdown body — shared by both layouts.
    @ViewBuilder
    private var messageContentCore: some View {
        if let img = imageInfo, img.path != "pending", let baseURL = session.serverURL {
            ChatImageView(url: baseURL + img.path)
        }
        if !textContent.isEmpty {
            SelectableMarkdown(text: textContent)
        } else if imageInfo == nil {
            SelectableMarkdown(text: message.content)
        }
        if let blocks = message.data, !blocks.isEmpty {
            DataCardStack(blocks: blocks)
        }
    }

    private var userDisplayName: String? {
        authorParticipant?.display_name ?? session.activeDeviceUser?.displayName
    }

    /// Copy + regenerate controls shown under each Maurice response.
    @ViewBuilder
    private var actionRow: some View {
        HStack(spacing: 18) {
            Button {
                copyToClipboard(textContent.isEmpty ? message.content : textContent)
                didCopy = true
                Task {
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    didCopy = false
                }
            } label: {
                Image(systemName: didCopy ? "checkmark" : "doc.on.doc")
                    .font(.system(size: 12))
            }
            .buttonStyle(.plain)
            .help(session.localized("chat.copy"))

            if isLast {
                Button {
                    Task { await chat.regenerate() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 12))
                }
                .buttonStyle(.plain)
                .disabled(chat.isStreaming)
                .help(session.localized("chat.regenerate"))
            }
        }
        .foregroundStyle(didCopy ? .green : theme.inkMute)
        .padding(.top, 4)
    }

    private func copyToClipboard(_ text: String) {
        #if os(iOS)
        UIPasteboard.general.string = text
        #elseif os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #endif
    }

    @ViewBuilder
    private var avatar: some View {
        if message.role == "user" {
            // Prefer the message's author (rooms); fall back to the device user
            // for legacy/1:1 messages that predate authorship.
            let p = authorParticipant
            UserAvatar(avatarURL: p?.avatar_url ?? session.activeDeviceUser?.avatarURL,
                       serverURL: session.serverURL,
                       initial: p?.initial ?? session.activeDeviceUser?.initial ?? "?",
                       color: p?.color ?? session.activeDeviceUser?.color ?? .gray,
                       size: 26)
        } else {
            BoaterHat(size: 18, color: theme.ink, ribbonColor: theme.surface)
                .frame(width: 26, height: 20)
        }
    }

    @ViewBuilder
    private var nameRow: some View {
        HStack(spacing: 8) {
            if message.role == "user" {
                let p = authorParticipant
                let name = p?.display_name ?? session.activeDeviceUser?.displayName ?? String(localized: "chat.fallback_name")
                Text(name.uppercased())
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle((p?.color ?? session.activeDeviceUser?.color ?? Color.primary).legible(onDark: theme.isDark))
                    .tracking(0.5)
            } else {
                Text("Maurice")
                    .font(.system(size: 14, design: .serif))
                    .italic()
                    .foregroundStyle(theme.ink)
            }

            Text(formattedTime)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(theme.inkMute)
        }
    }

    private var formattedTime: String {
        // Server timestamps are UTC; parseServerDate handles that. Display in
        // the device's local timezone (DateFormatter defaults to local).
        guard let date = parseServerDate(message.created_at) else { return "" }
        let display = DateFormatter()
        display.dateFormat = "HH:mm"
        return display.string(from: date)
    }
}

// MARK: - Streaming Row (live text with typewriter reveal)

/// Deterministic, model-untouched render of a tool's structured result. Sits
/// beside Maurice's prose so the user sees the actual rows even if the narration
/// drifts. Collapsed by default; the title's row count is itself the cheap tell
/// when the prose claims more rows than the tool returned.
/// One expandable widget for a message's tool-call results. When a turn makes
/// several calls they're grouped under a single disclosure that expands them all
/// at once, instead of each sitting on its own row.
private struct DataCardStack: View {
    @Environment(\.mauriceTheme) private var theme
    let blocks: [DataBlock]
    @State private var expanded = false

    private var label: String {
        if blocks.count == 1 { return blockTitle(blocks[0]) }
        let names = blocks.map(serverName)
        if let first = names.first, names.allSatisfy({ $0 == first }) {
            return "\(first) · \(blocks.count) calls"
        }
        return names.joined(separator: ", ")
    }

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                    VStack(alignment: .leading, spacing: 4) {
                        // Per-call header only when grouped, so the calls stay distinct.
                        if blocks.count > 1 {
                            Text(blockTitle(block))
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(theme.inkMute)
                        }
                        DataBlockBody(data: block.data)
                    }
                }
            }
            .padding(.top, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "wrench.adjustable")
                    .font(.system(size: 11))
                Text(label)
                    .font(.system(size: 12, weight: .medium))
            }
            .foregroundStyle(theme.inkMute)
        }
        .padding(10)
    }
}

/// MCP tools are namespaced "server__tool"; show the server segment.
private func serverName(_ block: DataBlock) -> String {
    block.tool.components(separatedBy: "__").first ?? block.tool
}

/// "{server} · {n} rows" when the payload carries a row count, else just the name.
private func blockTitle(_ block: DataBlock) -> String {
    let server = serverName(block)
    if let n = blockRowCount(block.data) { return "\(server) · \(n) row\(n == 1 ? "" : "s")" }
    return server
}

/// Row count for the title tell: a top-level array's length, or the longest array
/// nested in a wrapper object (e.g. { signals: [...], count: 50 }).
private func blockRowCount(_ data: JSONValue) -> Int? {
    switch data {
    case .array(let a):
        return a.count
    case .object(let pairs):
        return pairs.compactMap { pair -> Int? in
            if case .array(let a) = pair.value { return a.count }
            return nil
        }.max()
    default:
        return nil
    }
}

/// Renders one tool result's JSON payload (records / fields / scalar).
private struct DataBlockBody: View {
    @Environment(\.mauriceTheme) private var theme
    let data: JSONValue

    var body: some View { content }

    @ViewBuilder
    private var content: some View {
        switch data {
        case .array(let rows):
            rowList(rows)
        case .object(let pairs):
            // A wrapper object (e.g. { signals: [...], count: 50 }): render each
            // field — arrays become record lists, scalars become meta lines.
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(pairs.enumerated()), id: \.offset) { _, pair in
                    fieldView(key: pair.key, value: pair.value)
                }
            }
        default:
            Text(data.displayString)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(theme.ink)
        }
    }

    /// A top-level object field: arrays descend into a labelled record list;
    /// everything else is a single key/value line.
    @ViewBuilder
    private func fieldView(key: String, value: JSONValue) -> some View {
        switch value {
        case .array(let rows):
            VStack(alignment: .leading, spacing: 4) {
                Text(key)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(theme.inkMute)
                rowList(rows)
            }
        default:
            HStack(alignment: .top, spacing: 6) {
                Text(key)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(theme.inkMute)
                Text(value.displayString)
                    .font(.system(size: 11))
                    .foregroundStyle(theme.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    /// A list of records, capped so a huge result can't blow up the view.
    @ViewBuilder
    private func rowList(_ rows: [JSONValue]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(rows.prefix(50).enumerated()), id: \.offset) { _, row in
                recordView(row)
            }
            if rows.count > 50 {
                Text("+ \(rows.count - 50) more")
                    .font(.system(size: 11))
                    .foregroundStyle(theme.inkMute)
            }
        }
    }

    /// One record: key/value pairs for an object, else a scalar line.
    @ViewBuilder
    private func recordView(_ value: JSONValue) -> some View {
        switch value {
        case .object(let pairs):
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(pairs.enumerated()), id: \.offset) { _, pair in
                    HStack(alignment: .top, spacing: 6) {
                        Text(pair.key)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(theme.inkMute)
                        Text(pair.value.displayString)
                            .font(.system(size: 11))
                            .foregroundStyle(theme.ink)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 6).fill(theme.surface))
        default:
            Text(value.displayString)
                .font(.system(size: 12))
                .foregroundStyle(theme.ink)
        }
    }
}

private struct StreamingRow: View {
    @Environment(\.mauriceTheme) private var theme
    let text: String
    let serverBaseURL: String
    @State private var visibleLength: Int = 0

    // RunLoop timer — fires reliably independent of SwiftUI rendering
    private let tick = Timer.publish(every: 0.01, on: .main, in: .common).autoconnect()

    /// Parse image markdown: `![alt](/api/images/file.png)`
    private var imageInfo: (alt: String, path: String)? {
        let pattern = /^!\[(.+?)\]\((.+?)\)$/
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let match = trimmed.wholeMatch(of: pattern) else { return nil }
        return (String(match.1), String(match.2))
    }

    var body: some View {
        streamLayout
        .onReceive(tick) { _ in
            guard imageInfo == nil else { return }
            guard visibleLength < text.count else { return }
            // Reveal 1-3 chars per tick (~100-300 chars/sec)
            let behind = text.count - visibleLength
            let step = max(1, min(3, behind / 4))
            visibleLength = min(visibleLength + step, text.count)
        }
    }

    @ViewBuilder
    private var streamLayout: some View {
        #if os(iOS)
        VStack(alignment: .leading, spacing: 6) {
            Text("Maurice")
                .font(.system(size: 13, design: .serif)).italic()
                .foregroundStyle(theme.inkMute)
            streamContent
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        #else
        HStack(alignment: .top, spacing: 14) {
            BoaterHat(size: 18, color: theme.ink, ribbonColor: theme.surface)
                .frame(width: 26, height: 20)
            VStack(alignment: .leading, spacing: 4) {
                Text("Maurice")
                    .font(.system(size: 14, design: .serif)).italic()
                    .foregroundStyle(theme.ink)
                streamContent
            }
        }
        #endif
    }

    @ViewBuilder
    private var streamContent: some View {
        if let img = imageInfo {
            ChatImageView(url: serverBaseURL + img.path)
        } else {
            MarkdownText(text: String(text.prefix(visibleLength)))
                .opacity(0.85)
        }
    }
}

// MARK: - Chat Image View

private struct ChatImageView: View {
    @Environment(\.mauriceTheme) private var theme
    let url: String

    var body: some View {
        AsyncImage(url: URL(string: url)) { phase in
            switch phase {
            case .success(let image):
                image
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: 300, maxHeight: 300)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            case .failure:
                Label(L("chat.image_failed"), systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(theme.inkMute)
            default:
                ProgressView()
                    .frame(width: 120, height: 120)
            }
        }
    }
}

// MARK: - Tool Activity Indicator (web search / MCP tool running)

private struct ToolActivityIndicator: View {
    @Environment(\.mauriceTheme) private var theme
    let label: String

    var body: some View {
        HStack(spacing: 10) {
            ProgressView().scaleEffect(0.7)
            Text("\(label)…")
                .font(.system(size: 13))
                .foregroundStyle(theme.inkMute)
        }
        .padding(.vertical, 8)
    }
}

// MARK: - Image Generating Indicator

private struct ImageGeneratingIndicator: View {
    @Environment(\.mauriceTheme) private var theme

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            BoaterHat(size: 18, color: theme.ink, ribbonColor: theme.surface)
                .frame(width: 26, height: 20)

            VStack(alignment: .leading, spacing: 8) {
                Text("Maurice")
                    .font(.system(size: 14, design: .serif))
                    .italic()
                    .foregroundStyle(theme.ink)

                HStack(spacing: 8) {
                    ProgressView()
                        .controlSize(.small)
                    Text(L("chat.generating_image"))
                        .font(.system(size: 13))
                        .foregroundStyle(theme.inkMute)
                }
            }
        }
    }
}

// MARK: - Markdown Text (full GFM via swift-markdown-ui)

// Conversation body type: bigger and edge-to-edge on phone, denser in the
// desktop window (which centers a narrower column).
#if os(iOS)
private let kBodyFont: CGFloat = 16.5
private let kBodyLineSpacing: CGFloat = 4.5
#else
private let kBodyFont: CGFloat = 14.5
private let kBodyLineSpacing: CGFloat = 3
#endif

private struct MarkdownText: View {
    @Environment(\.mauriceTheme) private var theme
    let text: String

    var body: some View {
        let inkColor = MTColor(theme.ink)
        Markdown(renderMathMarkup(text))
            .markdownTheme(mauriceMarkdownTheme(theme))
            // Math: TeX spans were rewritten to `maurice-math:` images upstream;
            // these providers draw them with SwiftMath (inline → text style,
            // lone-paragraph → display style). Non-math URLs fall back to default.
            .markdownInlineImageProvider(MathInlineImageProvider(fontSize: kBodyFont, color: inkColor))
            .markdownImageProvider(MathBlockImageProvider(fontSize: kBodyFont, color: inkColor))
            .lineSpacing(kBodyLineSpacing)
            // macOS: per-block click-drag selection is fine and expected. iOS:
            // omit it — the textSelection long-press swallows the gesture our
            // context menu needs, and selection there happens via the Select-text
            // sheet instead (which can span the whole message).
            #if os(macOS)
            .textSelection(.enabled)
            #endif
    }
}

// MARK: - Math (LaTeX) rendering
//
// LLMs write math in TeX delimiters — \(…\) inline, \[…\] / $$…$$ display.
// swift-markdown-ui has no math support and would render "\(" as an escaped
// paren, so BEFORE markdown sees the text we rewrite each math span into a
// Markdown image whose URL carries the LaTeX (base64url). Two image providers
// then draw those URLs with SwiftMath: inline spans in text style, lone-
// paragraph (display) spans in display style. Code spans/fences are left alone.

private let kMathScheme = "maurice-math:"

/// Rewrite TeX spans to `![](maurice-math:<b64url>)` images, skipping code.
/// Display spans are forced onto their own paragraph so markdown routes them
/// through the block image provider. A cheap fast-path skips text with no math.
func renderMathMarkup(_ text: String) -> String {
    guard text.contains("\\(") || text.contains("\\[") || text.contains("$$") else { return text }
    // 1: fenced code · 2: inline code · 3: \[..\] · 4: $$..$$ · 5: \(..\)
    let pattern = #"(```[\s\S]*?```)|(`[^`]*`)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|\\\(([\s\S]*?)\\\)"#
    guard let re = try? NSRegularExpression(pattern: pattern) else { return text }
    let ns = text as NSString
    var out = ""
    var last = 0
    for m in re.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
        out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
        last = m.range.location + m.range.length
        func grp(_ i: Int) -> String? {
            let r = m.range(at: i)
            return r.location == NSNotFound ? nil : ns.substring(with: r)
        }
        if grp(1) != nil || grp(2) != nil {
            out += ns.substring(with: m.range)           // code — verbatim
        } else if let b = grp(3) ?? grp(4) {
            out += "\n\n" + mathImageTag(b) + "\n\n"      // display
        } else if let i = grp(5) {
            out += mathImageTag(i)                        // inline
        }
    }
    out += ns.substring(from: last)
    return out
}

private func mathImageTag(_ latex: String) -> String {
    let trimmed = latex.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let b64 = trimmed.data(using: .utf8)?.base64EncodedString() else { return latex }
    let urlSafe = b64.replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
    return "![](\(kMathScheme)\(urlSafe))"
}

/// Decode the LaTeX carried by a `maurice-math:` image URL (nil for any other).
private func decodeMathLatex(_ url: URL) -> String? {
    let s = url.absoluteString
    guard s.hasPrefix(kMathScheme) else { return nil }
    var b64 = String(s.dropFirst(kMathScheme.count))
        .replacingOccurrences(of: "-", with: "+")
        .replacingOccurrences(of: "_", with: "/")
    while b64.count % 4 != 0 { b64 += "=" }
    guard let data = Data(base64Encoded: b64) else { return nil }
    return String(data: data, encoding: .utf8)
}

#if os(iOS)
private extension Image { init(mtImage img: MTImage) { self.init(uiImage: img) } }
#else
private extension Image { init(mtImage img: MTImage) { self.init(nsImage: img) } }
#endif

/// Render a LaTeX string to a native image; nil if SwiftMath can't parse it.
private func renderMath(_ latex: String, display: Bool, fontSize: CGFloat, color: MTColor) -> MTImage? {
    var mi = MathImage(latex: latex, fontSize: fontSize, textColor: color,
                       labelMode: display ? .display : .text, textAlignment: .left)
    let (err, img, _) = mi.asImage()
    return err == nil ? img : nil
}

/// Last-resort image of the raw source (monospaced), so a malformed expression
/// still shows its TeX rather than vanishing.
private func mathFallbackImage(_ s: String, fontSize: CGFloat, color: MTColor) -> MTImage {
    #if os(iOS)
    let font = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
    #else
    let font = NSFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
    #endif
    let str = NSAttributedString(string: s, attributes: [.font: font, .foregroundColor: color])
    let size = str.size()
    #if os(iOS)
    return UIGraphicsImageRenderer(size: size).image { _ in str.draw(at: .zero) }
    #else
    let img = NSImage(size: size)
    img.lockFocus(); str.draw(at: .zero); img.unlockFocus()
    return img
    #endif
}

/// Draws inline TeX (`\(…\)`) within a line of text, in text style.
struct MathInlineImageProvider: InlineImageProvider {
    let fontSize: CGFloat
    let color: MTColor
    func image(with url: URL, label: String) async throws -> Image {
        guard let latex = decodeMathLatex(url) else {
            return try await DefaultInlineImageProvider.default.image(with: url, label: label)
        }
        let img = renderMath(latex, display: false, fontSize: fontSize, color: color)
            ?? mathFallbackImage(latex, fontSize: fontSize, color: color)
        return Image(mtImage: img)
    }
}

/// Draws display TeX (`\[…\]`, `$$…$$`) that sits alone in a paragraph.
struct MathBlockImageProvider: ImageProvider {
    let fontSize: CGFloat
    let color: MTColor
    @ViewBuilder func makeImage(url: URL?) -> some View {
        if let url, let latex = decodeMathLatex(url) {
            if let img = renderMath(latex, display: true, fontSize: fontSize, color: color) {
                Image(mtImage: img).frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Text(latex).font(.system(size: fontSize, design: .monospaced))
            }
        } else {
            DefaultImageProvider.default.makeImage(url: url)
        }
    }
}

/// Rich markdown body plus a long-press menu (iOS). swift-markdown-ui draws each
/// block as its own view, so in-place selection can't cross paragraphs; the menu
/// offers Copy (whole message) and "Select text…", which presents the full body
/// in one selectable view where any span — across paragraphs — can be grabbed.
private struct SelectableMarkdown: View {
    @Environment(SessionStore.self) private var session
    let text: String
    #if os(iOS)
    @State private var showingSelect = false
    @State private var showingMenu = false
    #endif

    var body: some View {
        #if os(iOS)
        // A bottom action sheet on long-press, rather than `.contextMenu` — the
        // latter lifts the view into a blurry preview "platter" that flashes
        // awkwardly over transparent text before the menu opens.
        MarkdownText(text: text)
            .onLongPressGesture(minimumDuration: 0.4) {
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                showingMenu = true
            }
            .confirmationDialog("", isPresented: $showingMenu, titleVisibility: .hidden) {
                Button(session.localized("chat.copy")) { UIPasteboard.general.string = text }
                Button(session.localized("chat.select_text")) { showingSelect = true }
            }
            .sheet(isPresented: $showingSelect) {
                SelectTextSheet(text: text)
            }
        #else
        MarkdownText(text: text)
        #endif
    }
}

#if os(iOS)
/// Full message body as plain, fully-selectable text in a dismissible sheet.
private struct SelectTextSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(SessionStore.self) private var session
    @Environment(\.mauriceTheme) private var theme
    let text: String

    var body: some View {
        NavigationStack {
            SelectableTextView(text: text, textColor: UIColor(theme.ink))
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(theme.surface.ignoresSafeArea())
                .navigationTitle(session.localized("chat.select_text"))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(session.localized("common.done")) { dismiss() }
                    }
                }
        }
    }
}

/// Read-only, selectable, scrollable UITextView — selection can span the whole
/// message (the thing a stack of swift-markdown-ui blocks can't do).
private struct SelectableTextView: UIViewRepresentable {
    let text: String
    let textColor: UIColor

    func makeUIView(context: Context) -> UITextView {
        let tv = UITextView()
        tv.isEditable = false
        tv.isSelectable = true
        tv.isScrollEnabled = true
        tv.alwaysBounceVertical = true
        tv.backgroundColor = .clear
        tv.textContainerInset = .zero
        tv.textContainer.lineFragmentPadding = 0
        tv.dataDetectorTypes = []
        tv.font = .systemFont(ofSize: kBodyFont)
        return tv
    }

    func updateUIView(_ tv: UITextView, context: Context) {
        tv.text = text
        tv.textColor = textColor
    }
}
#endif

/// Map the app's semantic tokens onto a swift-markdown-ui Theme. Starts from
/// the basic theme (sensible defaults for headings/lists/tables/blockquotes)
/// and recolors text/code/links/rules to match Maurice's palette.
private func mauriceMarkdownTheme(_ t: MauriceTheme) -> MarkdownUI.Theme {
    MarkdownUI.Theme()
        .text {
            ForegroundColor(t.ink)
            FontSize(kBodyFont)
        }
        .strong { FontWeight(.semibold) }
        .link { ForegroundColor(t.ink) }
        .code {
            FontFamilyVariant(.monospaced)
            FontSize(13)
            ForegroundColor(t.codeInk)
            BackgroundColor(t.codeBg)
        }
        .codeBlock { configuration in
            configuration.label
                .markdownTextStyle {
                    FontFamilyVariant(.monospaced)
                    FontSize(13)
                    ForegroundColor(t.codeInk)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(t.codeBg)
                .clipShape(RoundedRectangle(cornerRadius: 6))
        }
        .table { configuration in
            configuration.label
                .markdownTableBorderStyle(.init(color: t.rule))
        }
        .tableCell { configuration in
            configuration.label
                .markdownTextStyle { ForegroundColor(t.ink) }
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
        }
        .blockquote { configuration in
            configuration.label
                .markdownTextStyle { ForegroundColor(t.inkSoft) }
                .padding(.leading, 12)
                .overlay(alignment: .leading) {
                    Rectangle().fill(t.rule).frame(width: 3)
                }
        }
}

// MARK: - Streaming Indicator

private struct StreamingIndicator: View {
    @Environment(\.mauriceTheme) private var theme

    var body: some View {
        let dots = TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            HStack(spacing: 4) {
                ForEach(0..<3, id: \.self) { i in
                    Circle()
                        .fill(theme.inkMute)
                        .frame(width: 6, height: 6)
                        .offset(y: sin(t * 4.0 + Double(i) * 0.8) * 3)
                }
            }
        }
        #if os(iOS)
        dots.padding(.top, 2)
        #else
        HStack(alignment: .top, spacing: 14) {
            BoaterHat(size: 18, color: theme.ink, ribbonColor: theme.surface)
                .frame(width: 26, height: 20)
            dots.padding(.top, 6)
        }
        #endif
    }
}

// MARK: - Composer Bar

private struct ComposerBar: View {
    @Environment(ChatService.self) private var chat
    @Environment(SessionStore.self) private var session
    @Environment(ComposerStore.self) private var composer
    @Environment(MauriceStore.self) private var maurices
    @Environment(StudioState.self) private var studio
    @Environment(\.mauriceTheme) private var theme
    @Binding var inputText: String
    @Binding var pendingImageData: Data?
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var showCamera = false
    @State private var showPhotoPicker = false
    @State private var showFileImporter = false
    @FocusState var isFocused: Bool
    let onAddContext: () -> Void
    var onOpenTools: () -> Void = {}
    var trayOpen: Bool = false
    var onToggleTray: () -> Void = {}
    var onPostBubble: () -> Void = {}
    let onSend: () -> Void

    /// The thread's armed Maurice (what ➤ summons; nil = everyday).
    private var currentMaurice: Maurice { maurices.maurice(for: chat.currentMauriceId) }

    private var trimmed: String {
        inputText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canSend: Bool {
        (!trimmed.isEmpty || pendingImageData != nil) && !chat.isStreaming
    }

    /// Has the user attached any context (live items or locked carry-over)?
    private var hasContext: Bool {
        !composer.items.isEmpty || composer.lockedCount > 0
    }

    /// Instant model switcher for the thread's Maurice. Picking a model persists
    /// to that Maurice (everyday → this member's own preference; a persona → the
    /// persona) and applies to this and subsequent chats. The leading dot is
    /// brand-tinted by provider.
    @ViewBuilder private var modelPill: some View {
        if !maurices.models.isEmpty {
            let m = currentMaurice
            let current = maurices.resolvedModel(for: m)
            let provider = current?.provider ?? "anthropic"
            Menu {
                ForEach(orderedProviders, id: \.self) { prov in
                    let group = maurices.models.filter { $0.provider == prov }
                    Section(ProviderStyle.name(prov)) {
                        ForEach(group) { model in
                            Button {
                                Task { await maurices.setModel(model.id, for: currentMaurice) }
                            } label: {
                                if model.id == current?.id {
                                    Label(model.name, systemImage: "checkmark")
                                } else {
                                    Text(model.name)
                                }
                            }
                        }
                    }
                }
            } label: {
                HStack(spacing: 5) {
                    Circle().fill(ProviderStyle.fill(provider)).frame(width: 7, height: 7)
                    Text(current?.name ?? "—")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(theme.ink)
                        .lineLimit(1)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundStyle(theme.inkMute)
                }
                .padding(.horizontal, 10).padding(.vertical, 6)
                .overlay(Capsule().strokeBorder(theme.ruleHard, lineWidth: 0.5))
                .contentShape(Capsule())
            }
            .menuIndicator(.hidden)
            .buttonStyle(.plain)
            .disabled(chat.isStreaming)
            .help(session.localized("chat.switch_model"))
        }
    }

    /// Providers present in the roster, in first-seen order (stable menu sections).
    private var orderedProviders: [String] {
        var seen = Set<String>()
        return maurices.models.compactMap { seen.insert($0.provider).inserted ? $0.provider : nil }
    }

    /// The ➤ button "wears" the current Maurice's hat so who-gets-summoned is
    /// always visible at the moment of sending.
    /// The button "wears" the current Maurice's hat so who's armed is always
    /// visible. `sending` true → an up-arrow (tap sends); false → a down-chevron
    /// (the empty-composer chooser: tap opens the picker). Either way it's active.
    private func actionAvatar(sending: Bool) -> some View {
        let m = currentMaurice
        let accent = session.activeDeviceUser?.color ?? .blue
        return ZStack(alignment: .bottomTrailing) {
            Group {
                if m.isEveryday {
                    ZStack {
                        Circle().fill(accent.opacity(0.16))
                        // The hat is a foreground glyph — keep it legible when the
                        // user's accent is dark (else it vanishes on a dark surface).
                        BoaterHat(size: 24, color: accent.legible(onDark: theme.isDark))
                    }
                    .overlay(Circle().strokeBorder(theme.ruleHard, lineWidth: 0.75))
                } else {
                    HatBadge(kind: m.hat, palette: m.paletteValue, size: 44, radius: 22)
                }
            }
            .frame(width: 44, height: 44)
            Image(systemName: sending ? "arrow.up.circle.fill" : "chevron.down.circle.fill")
                .font(.system(size: 16))
                .symbolRenderingMode(.palette)
                .foregroundStyle(.white, accent)
        }
        .frame(width: 44, height: 44)
    }

    /// While streaming, ➤ becomes a square ⏹ that cancels the generation.
    private var stopAvatar: some View {
        let accent = session.activeDeviceUser?.color ?? .blue
        return Circle()
            .fill(accent)
            .frame(width: 44, height: 44)
            .overlay(
                RoundedRectangle(cornerRadius: 3, style: .continuous)
                    .fill(.white)
                    .frame(width: 14, height: 14)
            )
    }

    var body: some View {
        VStack(spacing: 8) {
            VStack(spacing: 8) {
                // Pending image preview
                if let imageData = pendingImageData {
                    HStack(alignment: .top, spacing: 8) {
                        #if os(iOS)
                        if let uiImage = UIImage(data: imageData) {
                            Image(uiImage: uiImage)
                                .resizable()
                                .aspectRatio(contentMode: .fill)
                                .frame(width: 60, height: 60)
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                        }
                        #else
                        if let nsImage = NSImage(data: imageData) {
                            Image(nsImage: nsImage)
                                .resizable()
                                .aspectRatio(contentMode: .fill)
                                .frame(width: 60, height: 60)
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                        }
                        #endif

                        Button {
                            pendingImageData = nil
                            selectedPhoto = nil
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 16))
                                .foregroundStyle(theme.inkMute)
                        }
                        .buttonStyle(.plain)

                        Spacer()
                    }
                    .padding(.bottom, 4)
                }

                // Slightly larger than the body; ~2 lines tall by default,
                // growing to ~10 lines before it scrolls.
                TextField(session.localized("chat.composer.placeholder"), text: $inputText, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(.system(size: kBodyFont + 2))
                    .lineLimit(2...10)
                    .focused($isFocused)
                    .onSubmit { onSend() }
                    .submitLabel(.send)

                HStack(spacing: 4) {
                    Menu {
                        Button { showCamera = true } label: {
                            Label(session.localized("composer.camera"), systemImage: "camera")
                        }
                        Button { showPhotoPicker = true } label: {
                            Label(session.localized("composer.photo"), systemImage: "photo")
                        }
                        Button { showFileImporter = true } label: {
                            Label(session.localized("composer.file"), systemImage: "folder")
                        }
                    } label: {
                        Image(systemName: "paperclip")
                            .font(.system(size: 16))
                            .foregroundStyle(theme.inkSoft)
                            .frame(width: 34, height: 34)
                            .contentShape(Rectangle())
                    }
                    .menuIndicator(.hidden)
                    .buttonStyle(.plain)   // no default menu-button background
                    .disabled(chat.isStreaming)

                    // Tools — per-chat tool families (wrench).
                    Button(action: onOpenTools) {
                        Image(systemName: "wrench.adjustable")
                            .font(.system(size: 15))
                            .foregroundStyle(theme.inkSoft)
                            .frame(width: 34, height: 34)
                    }
                    .buttonStyle(.plain)
                    .help(session.localized("chat.tools_help"))

                    // Context button — `+` to add when there's none; once context
                    // has been attached it turns into a suitcase that opens the
                    // review/trim tray (where "Add context" still lives, so this
                    // path keeps everything the bare `+` offered).
                    Button(action: hasContext ? onToggleTray : onAddContext) {
                        Image(systemName: hasContext ? "suitcase" : "plus")
                            .font(.system(size: 16, weight: .regular))
                            .foregroundStyle(hasContext && trayOpen
                                             ? (session.activeDeviceUser?.color ?? .blue).legible(onDark: theme.isDark)
                                             : theme.inkSoft)
                            .frame(width: 34, height: 34)
                    }
                    .buttonStyle(.plain)
                    .help(session.localized(hasContext ? "chat.review_context" : "chat.add_context"))

                    #if os(iOS)
                    // Dismiss the keyboard from inside the input row (when focused)
                    // — no floating accessory bar that would cover Send.
                    if isFocused {
                        Button { isFocused = false } label: {
                            Image(systemName: "keyboard.chevron.compact.down")
                                .font(.system(size: 16))
                                .foregroundStyle(theme.inkSoft)
                                .frame(width: 34, height: 34)
                        }
                        .buttonStyle(.plain)
                        .help(session.localized("chat.hide_keyboard"))
                    }
                    #endif

                    // Instant model switcher for the thread's Maurice — sits in
                    // the left cluster, just after the action icons.
                    modelPill

                    Spacer()

                    // The send row reads as a sentence:
                    // 💬 no-one (group only) · 🎩 choose who · ➤ send to them.
                    HStack(spacing: 8) {
                        if chat.isRoom {
                            Button { onPostBubble() } label: {
                                Image(systemName: "bubble.left")
                                    .font(.system(size: 18, weight: .medium))
                                    .foregroundStyle(canSend ? theme.inkSoft : theme.inkMute)
                                    .frame(width: 44, height: 44)
                                    .overlay(Circle().strokeBorder(theme.ruleHard, lineWidth: 0.75))
                            }
                            .buttonStyle(.plain)
                            .disabled(!canSend)
                            .help(session.localized("chat.post_humans"))
                        }

                        if chat.isStreaming {
                            // ➤ has run into a square ⏹ — cancel the generation.
                            Button { chat.stop() } label: { stopAvatar }
                            .buttonStyle(.plain)
                            .help(session.localized("chat.stop"))
                        } else if canSend {
                            // Draft present: tap sends to the armed Maurice;
                            // long-press opens the picker to choose someone else,
                            // then sends to them ("Send" in the picker).
                            Button { onSend() } label: { actionAvatar(sending: true) }
                            .buttonStyle(.plain)
                            .keyboardShortcut(.return, modifiers: .command)
                            .simultaneousGesture(
                                LongPressGesture().onEnded { _ in
                                    studio.pickerSends = true
                                    studio.showPicker = true
                                }
                            )
                            .help(session.localized("chat.switch_specialist"))
                        } else {
                            // Empty composer: the button is a plain Maurice chooser
                            // — tap opens the picker, which just arms them ("Use").
                            Button {
                                studio.pickerSends = false
                                studio.showPicker = true
                            } label: { actionAvatar(sending: false) }
                            .buttonStyle(.plain)
                            .help(session.localized("chat.switch_specialist"))
                        }
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            #if os(iOS)
            // Floating glass field (the dock provides the horizontal margin).
            .glassPanel(theme, cornerRadius: 22)
            #else
            .overlay(
                RoundedRectangle(cornerRadius: 22)
                    .strokeBorder(theme.rule, lineWidth: 0.5)
            )
            .background(
                RoundedRectangle(cornerRadius: 22)
                    .fill(theme.bg)
            )
            #endif

            #if os(macOS)
            Text("chat.composer.hint")
                .font(.system(size: 9.5, design: .monospaced))
                .foregroundStyle(theme.inkMute)
                .tracking(0.5)
            #endif
        }
        #if os(iOS)
        .padding(.top, 4)
        #else
        .padding(.horizontal, 10)
        .padding(.vertical, 12)
        #endif
        .onChange(of: selectedPhoto) {
            Task {
                guard let item = selectedPhoto else { return }
                if let data = try? await item.loadTransferable(type: Data.self) {
                    pendingImageData = normalizeToJPEG(data) ?? data
                }
                selectedPhoto = nil
            }
        }
        .photosPicker(isPresented: $showPhotoPicker, selection: $selectedPhoto, matching: .images)
        .sheet(isPresented: $showCamera) {
            CameraCaptureView { data in
                showCamera = false
                pendingImageData = normalizeToJPEG(data) ?? data
            }
        }
        // "Files" files the picked document into the library AND attaches it as
        // conversation context in one gesture (any kind — text counts toward the
        // budget; img/pdf ride along as attachments). Photos/Camera stay inline.
        .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.item]) { result in
            guard case .success(let url) = result else { return }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let name = url.lastPathComponent
            guard let data = try? Data(contentsOf: url) else { return }
            Task { await composer.addUploadedFile(name: name, data: data) }
        }
        // The picker's "Send" arms a Maurice and raises this — fire the current
        // draft at them through the normal send path (which clears the field).
        .onChange(of: studio.pendingSend) {
            guard studio.pendingSend else { return }
            studio.pendingSend = false
            onSend()
        }
    }
}

/// Decode any image Data to a downsized JPEG (the attachment pipeline sends a
/// base64 image/jpeg data URI; camera HEIC / PNG files would otherwise be
/// mislabelled). Orientation-correct via ImageIO.
private func normalizeToJPEG(_ data: Data, maxPixel: CGFloat = 2048) -> Data? {
    guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    let opts: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        kCGImageSourceCreateThumbnailWithTransform: true,
    ]
    guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
    let out = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(out, "public.jpeg" as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(dest, cg, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { return nil }
    return out as Data
}

// MARK: - Window-control inset

// Both platforms float close/minimize/zoom controls over the window's top-leading
// corner: macOS via `.windowStyle(.hiddenTitleBar)`, iPadOS 26 via its windowing
// system. When the sidebar collapses (a narrow or tiled window) the detail pane's
// top row slides under those controls. This modifier shifts the row's leading
// content past them so the header sits inline beside the dots, and is a no-op when
// a sidebar sits to our left (controls land over it) or in full-screen (no controls).
extension View {
    func trafficLightInset() -> some View { modifier(TrafficLightInset()) }
}

#if os(iOS)
extension ToolbarContent {
    /// Hide the iOS 26 Liquid Glass capsule behind a custom toolbar item, so our
    /// wordmark / title sits plainly on the bar instead of in a pill. No-op before iOS 26.
    @ToolbarContentBuilder
    func plainGlass() -> some ToolbarContent {
        if #available(iOS 26.0, *) {
            sharedBackgroundVisibility(.hidden)
        } else {
            self
        }
    }
}
#endif

private struct TrafficLightInset: ViewModifier {
    #if os(macOS)
    /// True when our leading edge is flush with the window's left edge, i.e. no
    /// sidebar sits to our left and the traffic lights overlap us. macOS doesn't
    /// surface the lights' geometry, so we infer it from our global position.
    @State private var atWindowEdge = false

    func body(content: Content) -> some View {
        content
            // Clears all three buttons (~70pt) plus a small breath. Measured on
            // the padded frame, so the bottom rule/background still span full width.
            .padding(.leading, atWindowEdge ? 56 : 0)
            .background(
                GeometryReader { geo in
                    Color.clear.onChange(of: geo.frame(in: .global).minX, initial: true) { _, x in
                        atWindowEdge = x < 30
                    }
                }
            )
    }
    #else
    /// iPadOS 26 reports the window-control cluster's width at our top-leading
    /// corner via `containerCornerInsets` — non-zero only when we're flush at
    /// that corner with the controls present, so padding by it is self-gating.
    /// We pad the LEADING edge so the header sits inline beside the dots and
    /// keeps hugging the top — no wasted strip — the way Safari/Brave do.
    @State private var lead: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .padding(.leading, lead)
            .background(
                GeometryReader { geo in
                    Color.clear.onChange(of: cornerLead(geo), initial: true) { _, w in
                        lead = w
                    }
                }
            )
    }

    /// Width the window controls occupy at our top-leading corner (0 before
    /// iPadOS 26, where the system insets a custom top bar for us).
    private func cornerLead(_ geo: GeometryProxy) -> CGFloat {
        if #available(iOS 26.0, *) { geo.containerCornerInsets.topLeading.width } else { 0 }
    }
    #endif
}

// MARK: - Safety surface (report sheet, operator review, links)

/// Out-of-band safety pointers. These route OUTWARD to parties who can act —
/// they are NOT a publisher-run abuse desk.
enum SafetyLinks {
    /// App/publisher contact (App Store Guideline 1.2). Not an abuse desk.
    static let publisherContact = "safety@chezmaurice.eu"
    /// NCMEC CyberTipline (US) child-safety authority — given in the safety spec.
    static let ncmecUS = URL(string: "https://report.cybertip.org")!
    /// Child Focus civil hotline (Belgium) — verified 2026-06 (publisher is in BE).
    static let childSafetyBE = URL(string: "https://www.stopchildporno.be")!
    /// Apple "Report a Problem" — the App Store report flow (verified 2026-06).
    static let appleReport = URL(string: "https://reportaproblem.apple.com")!
    /// Terms of Use (EULA) and Privacy Policy, hosted on chezmaurice.eu.
    static let terms = URL(string: "https://www.chezmaurice.eu/terms.html")!
    static let privacy = URL(string: "https://www.chezmaurice.eu/privacy.html")!
}

/// Report a message (or member) in a shared room. For child_safety, shows an
/// authority-reporting notice on the confirmation screen.
struct ReportSheet: View {
    let targetType: String
    let targetId: String
    @Environment(ChatService.self) private var chat
    @Environment(\.dismiss) private var dismiss
    @State private var reason: ReportReason = .spam
    @State private var note = ""
    @State private var submitting = false
    @State private var done = false

    var body: some View {
        NavigationStack {
            Form {
                if done {
                    Section {
                        Text("Thanks — your report was sent to this server's operator to review.")
                    }
                    if reason == .child_safety {
                        Section("Also report to an authority") {
                            Text("If this involves the exploitation of a minor, please also report it to the appropriate authority — they can act in ways the operator can't.")
                            Link("NCMEC CyberTipline (US)", destination: SafetyLinks.ncmecUS)
                            Text("Outside the US, contact your local equivalent.")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                } else {
                    Section("Reason") {
                        Picker("Reason", selection: $reason) {
                            ForEach(ReportReason.allCases) { Text($0.label).tag($0) }
                        }
                        .labelsHidden()
                        .pickerStyle(.inline)
                    }
                    Section("Note (optional)") {
                        TextField("Add context", text: $note, axis: .vertical).lineLimit(1...4)
                    }
                }
            }
            .navigationTitle("Report")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(done ? "Done" : "Cancel") { dismiss() }
                }
                if !done {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Submit") { submit() }.disabled(submitting)
                    }
                }
            }
        }
    }

    private func submit() {
        submitting = true
        Task {
            let ok = await chat.report(
                targetType: targetType, targetId: targetId,
                reason: reason.rawValue, note: note.isEmpty ? nil : note)
            submitting = false
            if ok {
                if reason == .child_safety { done = true } else { dismiss() }
            }
        }
    }
}

/// Operator-only: review open reports (child_safety first) and act on them.
struct ReportsReviewView: View {
    @Environment(ChatService.self) private var chat
    @Environment(\.dismiss) private var dismiss
    @State private var reports: [ReportView] = []
    @State private var loading = true

    var body: some View {
        NavigationStack {
            List {
                if reports.isEmpty && !loading {
                    Text("No open reports.").foregroundStyle(.secondary)
                }
                ForEach(reports) { r in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(reasonLabel(r.reason)).font(.headline)
                            if r.reason == "child_safety" {
                                Text("PRIORITY").font(.caption2).bold().foregroundStyle(.red)
                            }
                            Spacer()
                            Text(r.room_title ?? "Room").font(.caption).foregroundStyle(.secondary)
                        }
                        if let m = r.reported_message { Text(m.content).font(.callout).lineLimit(4) }
                        if let mem = r.reported_member { Text("Member: \(mem.display_name)").font(.callout) }
                        if let note = r.note, !note.isEmpty { Text("“\(note)”").font(.footnote).italic() }
                        if let by = r.reporter_display_name {
                            Text("reported by \(by)").font(.caption2).foregroundStyle(.secondary)
                        }
                        HStack(spacing: 12) {
                            if r.target_type == "message" {
                                Button("Remove message") { act(r, remove: true, eject: false) }
                            }
                            Button("Eject member", role: .destructive) { act(r, remove: false, eject: true) }
                            Spacer()
                            Button("Dismiss") { Task { await chat.dismissReport(r.id); await load() } }
                        }
                        .buttonStyle(.bordered)
                        .font(.callout)
                    }
                    .padding(.vertical, 4)
                }
            }
            .navigationTitle("Open reports")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .task { await load() }
        }
    }

    private func load() async { loading = true; reports = await chat.loadOpenReports(); loading = false }
    private func act(_ r: ReportView, remove: Bool, eject: Bool) {
        Task { await chat.actionReport(r.id, removeMessage: remove, ejectMember: eject); await load() }
    }
    private func reasonLabel(_ raw: String) -> String { ReportReason(rawValue: raw)?.label ?? raw }
}
