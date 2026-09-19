import SwiftUI
import UserNotifications
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

// MARK: - Chat Service

@Observable @MainActor
final class ChatService {
    let session: SessionStore

    var conversations: [ServerConversation] = []
    /// Whether more (older) conversations remain to page in via infinite scroll.
    var hasMoreConversations = true
    private var isLoadingMoreConversations = false
    private let conversationsPageSize = 40
    var activeConversationId: String?
    /// The thread's current/armed Maurice (what ➤ summons; nil = everyday).
    /// Sticky within a thread, reset to everyday on a new conversation.
    var currentMauriceId: String?

    /// The Maurice a brand-new conversation arms by default — the last one the
    /// user actually sent to. Persisted per household so the choice survives
    /// relaunches and household switches. nil = everyday. The user "switches"
    /// simply by sending to a different Maurice from the picker.
    private var defaultMauriceKey: String {
        "maurice.defaultMaurice.\(session.currentHouseholdId ?? "_")"
    }
    var defaultMauriceId: String? {
        get { UserDefaults.standard.string(forKey: defaultMauriceKey) }
        set { UserDefaults.standard.set(newValue, forKey: defaultMauriceKey) }
    }
    var messages: [ServerMessage] = []
    var isStreaming = false
    /// Full text received so far from the server.
    var streamingText = ""
    /// Structured tool results received so far this turn — rendered beside the
    /// streaming prose and carried onto the finished message.
    var streamingData: [DataBlock] = []
    /// Cost of the turn being streamed, once the server reports it (just before
    /// `done`). Carried onto the finished message.
    var streamingUsage: TurnUsage?
    var isGeneratingImage = false
    /// Human-readable label of the tool currently running (e.g. "Searching the web"), or nil.
    var toolActivity: String?
    var error: String?

    // ── Rooms ───────────────────────────────────────────────────
    /// Participants of the active room (the owner alone for a 1:1 chat).
    var participants: [ServerParticipant] = []
    /// Household roster, for the "add member" picker.
    var roster: [ServerUser] = []
    /// Someone summoned Maurice and his reply hasn't landed — shown to observers
    /// who didn't send the summoning message themselves.
    var pendingSummon = false

    /// True when more than one human shares the room (drives @claude summoning
    /// and author-labelled message rows).
    var isRoom: Bool { participants.count > 1 }
    var participantsById: [String: ServerParticipant] {
        Dictionary(participants.map { ($0.member_id, $0) }, uniquingKeysWith: { a, _ in a })
    }

    private var socket: RoomSocket?
    /// Global per-user channel (new conversations + activity), open across rooms.
    private var userSocket: UserSocket?
    /// Conversations with unread activity since last viewed — sidebar dots.
    var unread: Set<String> = []
    /// Whether the app is frontmost/active (set from scenePhase); when false we
    /// notify even for the conversation you "have open". Coming back to the
    /// front is also the moment to pick up what the suspension broke.
    var appActive = true {
        didSet {
            guard appActive != oldValue else { return }
            if appActive {
                Task { await didBecomeActive() }
            } else {
                wentInactiveAt = Date()
            }
        }
    }
    /// When the app last left the front, to tell a glance at the app switcher
    /// from a suspension that killed every connection.
    private var wentInactiveAt: Date?
    /// A conversation to open after a household switch (from a cross-household
    /// notification tap), once that household's list has loaded.
    private var pendingOpenConversation: String?
    /// Server-confirmed message ids, so live WS echoes don't double-render.
    private var knownIds: Set<String> = []
    /// The in-flight turn follower, so ⏹ Stop can tear it down. nil when no
    /// generation is being followed.
    private var streamTask: Task<TurnOutcome, Never>?
    /// The consumer of the stream currently feeding `streamTask` — cancelled
    /// on its own to force a re-attach without abandoning the turn.
    private var pumpTask: Task<StreamEvent?, Error>?
    /// The turn we started (or picked up) and have not yet seen the end of.
    /// Outlives `streamTask`: when the follower gave up while the app was
    /// away, a return to the front tries again from here.
    private var followedTurn: (convoId: String, startedAt: Date)?
    /// The conversation `messages` actually holds, as opposed to the one merely
    /// selected. Anything destructive has to key off this, not off emptiness.
    private var messagesLoadedFor: String?

    private var api: APIClient? {
        guard let url = session.serverURL else { return nil }
        return APIClient(baseURL: url)
    }

    private var token: String? { session.tokenForActiveUser }

    init(session: SessionStore) {
        self.session = session
    }

    // MARK: - Conversations

    var activeConversation: ServerConversation? {
        conversations.first { $0.id == activeConversationId }
    }

    // ── Search ──────────────────────────────────────────────────
    /// What the sidebar search box holds; empty = the plain list.
    var searchQuery = ""
    /// Hits for `searchQuery`, in the server's rank order.
    var searchResults: [ConversationSearchHit] = []
    var isSearching = false
    private var searchTask: Task<Void, Never>?

    /// Full-text search over the member's own rooms (messages + titles). Debounced:
    /// a keystroke cancels the request the previous one was about to make.
    func searchConversations(_ q: String) {
        searchQuery = q
        searchTask?.cancel()
        let trimmed = q.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2 else { searchResults = []; isSearching = false; return }
        isSearching = true
        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(220))
            guard !Task.isCancelled, let api, let token else { return }
            let qs = trimmed.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? trimmed
            let res: ConversationSearchResponse? = try? await api.get(
                "/api/conversations/search?q=\(qs)&limit=40", token: token)
            guard !Task.isCancelled, let res, res.q == trimmed else { return }
            searchResults = res.results
            isSearching = false
        }
    }

    func clearSearch() {
        searchTask?.cancel()
        searchQuery = ""; searchResults = []; isSearching = false
    }

    func loadConversations() async {
        guard let api, let token else { return }
        do {
            let page: [ServerConversation] = try await api.get(
                "/api/conversations?limit=\(conversationsPageSize)", token: token)
            conversations = page
            hasMoreConversations = page.count >= conversationsPageSize
            // What the server says is unread (a conversation Maurice opened and
            // you have not opened yet) shows its dot from a cold start too.
            for c in page where c.unread == true { unread.insert(c.id) }
        } catch {
            self.error = error.localizedDescription
        }
        connectUserSocket()
    }

    /// Page in the next batch of older conversations (infinite scroll). Keyset
    /// cursor = the last loaded row's (updated_at, id); appends, deduping by id.
    func loadMoreConversations() async {
        guard let api, let token,
              hasMoreConversations, !isLoadingMoreConversations,
              let last = conversations.last else { return }
        isLoadingMoreConversations = true
        defer { isLoadingMoreConversations = false }
        func enc(_ s: String) -> String {
            s.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? s
        }
        let path = "/api/conversations?limit=\(conversationsPageSize)"
            + "&before_at=\(enc(last.updated_at))&before_id=\(enc(last.id))"
        do {
            let page: [ServerConversation] = try await api.get(path, token: token)
            let known = Set(conversations.map(\.id))
            conversations.append(contentsOf: page.filter { !known.contains($0.id) })
            hasMoreConversations = page.count >= conversationsPageSize
            for c in page where c.unread == true { unread.insert(c.id) }
        } catch {
            // Leave hasMore true so a later scroll retries; surface nothing intrusive.
        }
    }

    func selectConversation(_ id: String) async {
        activeConversationId = id
        messagesLoadedFor = nil
        unread.remove(id)
        await loadMessages(for: id)
        // The thread's armed Maurice = its current maurice_id (sticky in-thread).
        currentMauriceId = activeConversation?.maurice_id
        // Mark read on the server so the foyer unread roll-up reflects it.
        if let api, let token {
            let _: OkResponse? = try? await api.post("/api/conversations/\(id)/read", body: ["":""], token: token)
        }
    }

    // ── Global per-user channel ─────────────────────────────────

    /// Open the global socket once for the active user (idempotent), and ask for
    /// notification permission the first time.
    private func connectUserSocket() {
        guard let url = session.serverURL, let token else { return }
        NotificationManager.shared.requestAuthorizationOnce()
        NotificationManager.shared.onTap = { [weak self] id, tag in
            Task { @MainActor in await self?.openFromNotification(id, household: tag) }
        }
        // Upload this device's APNs token for the active user (now or when it
        // arrives) so the server can push when the app is backgrounded.
        NotificationManager.shared.onDeviceToken = { [weak self] token in
            Task { @MainActor in await self?.uploadDeviceToken(token) }
        }
        if let token = NotificationManager.shared.deviceToken {
            Task { await uploadDeviceToken(token) }
        }
        if userSocket == nil {
            userSocket = UserSocket(
                onEvent: { [weak self] event in self?.handleUserEvent(event) },
                onReconnect: { [weak self] in Task { await self?.loadConversations() } }
            )
            userSocket?.connect(baseURL: url, token: token)
        }
    }

    private func handleUserEvent(_ event: UserEvent) {
        switch event.type {
        case "conversation_added":
            if let id = event.conversationId { unread.insert(id) }
            Task { await loadConversations() }
            NotificationManager.shared.notify(
                title: (event.title?.isEmpty == false ? event.title! : "New conversation"),
                body: "\(event.by ?? "Someone") added you to a conversation",
                conversationId: event.conversationId
            )
        case "conversation_opened":
            // Maurice opened a conversation for you, with a first message of
            // his: it joins the list unread, and you are told as for a room.
            guard let id = event.conversationId else { return }
            unread.insert(id)
            Task { await loadConversations() }
            NotificationManager.shared.notify(
                title: (event.title?.isEmpty == false ? event.title! : "Maurice"),
                body: "Maurice: \(event.preview ?? "")",
                conversationId: id
            )
        case "activity":
            guard let id = event.conversationId else { return }
            // The summoner/sender already saw it (it's excluded server-side). Only
            // alert if you're not looking at that room — or the app isn't frontmost.
            let viewing = (id == activeConversationId) && appActive
            guard !viewing else { return }
            unread.insert(id)
            bumpToFront(id)
            NotificationManager.shared.notify(
                title: (event.title?.isEmpty == false ? event.title! : (event.author ?? "Maurice")),
                body: "\(event.author ?? "Maurice"): \(event.preview ?? "")",
                conversationId: id
            )
        default:
            break
        }
    }

    /// Move a conversation to the top of the list (most-recent-activity order).
    private func bumpToFront(_ id: String) {
        guard let i = conversations.firstIndex(where: { $0.id == id }), i != 0 else { return }
        let c = conversations.remove(at: i)
        conversations.insert(c, at: 0)
    }

    private func uploadDeviceToken(_ deviceToken: String) async {
        #if os(iOS)
        let platform = "ios"
        #else
        let platform = "macos"
        #endif
        // Register with EVERY household's server (tagged by local household id) so
        // each can push this device — even while you're viewing another household.
        for h in session.households {
            guard let bearer = session.token(for: h) else { continue }
            let api = APIClient(baseURL: h.serverURL)
            let _: OkResponse? = try? await api.post(
                "/api/users/me/device-token",
                body: ["token": deviceToken, "platform": platform, "household_tag": h.id],
                token: bearer
            )
        }
    }

    /// Tapped a notification. A remote push carries the household tag; if it's a
    /// different household, switch to it first — ContentView's household-change
    /// handler reloads, then opens the pending conversation.
    private func openFromNotification(_ id: String, household tag: String?) async {
        if let tag, tag != session.currentHouseholdId,
           session.households.contains(where: { $0.id == tag }) {
            pendingOpenConversation = id
            session.switchHousehold(tag)
            return
        }
        if !conversations.contains(where: { $0.id == id }) { await loadConversations() }
        await selectConversation(id)
    }

    /// Whether the current conversation has any messages in it.
    var activeConversationIsEmpty: Bool {
        activeConversationId != nil && messages.isEmpty
    }

    /// Create a new conversation, optionally bound to a specialized Maurice.
    /// The plain "+ New" keeps the empty-guard (don't stack empties); starting
    /// *with* a Maurice from the picker passes `force` to always open a fresh one.
    func createConversation(mauriceId: String? = nil, force: Bool = false) async {
        if !force { guard !activeConversationIsEmpty else { return } }
        guard let api, let token else { return }
        struct NewConvo: Encodable { let maurice_id: String? }
        do {
            let convo: ServerConversation = try await api.post(
                "/api/conversations",
                body: NewConvo(maurice_id: mauriceId),
                token: token
            )
            conversations.insert(convo, at: 0)
            activeConversationId = convo.id
            // We just created it, so we know its contents: empty. Without this
            // the discard-if-empty cleanup could never fire again.
            messagesLoadedFor = convo.id
            currentMauriceId = mauriceId  // sticky for this thread; nil = everyday
            messages = []
            knownIds = []
            pendingSummon = false
            // A new room starts with just the creator; the socket and full
            // roster arrive as messages/participants change.
            if let u = session.activeDeviceUser {
                participants = [ServerParticipant(
                    member_id: u.id, role: "owner", username: nil,
                    display_name: u.displayName, avatar_color: u.avatarColor
                )]
            } else {
                participants = []
            }
            connectSocket(convo.id)
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Rename a conversation (PATCH /api/conversations/:id). The list is
    /// updated in place so the sidebar and header follow without a reload.
    func renameConversation(_ id: String, title: String) async {
        guard let api, let token else { return }
        do {
            let updated: RenamedConversation = try await api.patch(
                "/api/conversations/\(id)", body: ["title": title], token: token)
            if let i = conversations.firstIndex(where: { $0.id == id }) {
                conversations[i].title = updated.title ?? title
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    func deleteConversation(_ id: String) async {
        guard let api, let token else { return }
        do {
            // A reply still streaming into the thread being deleted must stop
            // first: left running, the server keeps calling tools for a room
            // that no longer exists (a fragment was once appended to a garden
            // fiche from a conversation deleted a minute earlier).
            if activeConversationId == id { await stopAndWait() }
            try await api.delete("/api/conversations/\(id)", token: token)
            dropRoom(id)
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Forget a room that is gone — deleted here, or found missing on the
    /// server. The room socket must go with it: left connected, it fails its
    /// upgrade (no longer a participant), reconnects with backoff forever, and
    /// refetches a conversation that answers 404 every time — for hours.
    private func dropRoom(_ id: String) {
        conversations.removeAll { $0.id == id }
        guard activeConversationId == id else { return }
        socket?.disconnect()
        socket = nil
        activeConversationId = conversations.first?.id
        if let nextId = activeConversationId {
            Task { await loadMessages(for: nextId) }
        } else {
            messages = []
            participants = []
            knownIds = []
            messagesLoadedFor = nil
        }
    }

    /// True when a fetch of the conversation says it no longer exists.
    private static func isVanished(_ error: Error) -> Bool {
        if case APIError.server(404, _) = error { return true }
        return false
    }

    /// Drop the active conversation if it was never used — a freshly created
    /// thread with no messages (and no extra participants) that the user backed
    /// out of. Keeps abandoned "New conversation" rows from piling up.
    func discardActiveIfEmpty() async {
        guard let api, let token, let id = activeConversationId else { return }
        // `messages.isEmpty` is not on its own evidence that the thread is empty:
        // selectConversation sets activeConversationId and only THEN awaits
        // loadMessages, so a fully populated thread looks empty for the length of
        // that round-trip. The Action Button fires at arbitrary moments, and this
        // path issues a DELETE — tapping a conversation and pressing the button
        // before it loaded destroyed it on the server.
        guard messagesLoadedFor == id else { return }
        guard messages.isEmpty, participants.count <= 1 else { return }
        try? await api.delete("/api/conversations/\(id)", token: token)
        conversations.removeAll { $0.id == id }
        activeConversationId = conversations.first?.id
        messages = []
        knownIds = []
    }

    /// Leave the current thread for a brand-new one.
    ///
    /// Clearing `activeConversationId` alone is not enough and looked like it
    /// was: the previous thread's messages, participants and ids stay loaded, so
    /// the screen goes on showing the old conversation while the app believes
    /// none is selected. The conversation itself is created on first send.
    func startNewConversation() async {
        // A reply still streaming belongs to the thread being left. Left running
        // it keeps writing — and on completion appends the finished answer into
        // whatever `messages` now holds, which is the new empty thread. It also
        // keeps isStreaming true, disabling the composer in a conversation that
        // has nothing to do with it.
        await stopAndWait()
        // Same for the room socket: it stays subscribed to the old room, and
        // nothing downstream checks which conversation an event belongs to, so
        // another member's message would land in the new thread's history.
        socket?.disconnect()
        socket = nil
        await discardActiveIfEmpty()
        activeConversationId = nil
        messagesLoadedFor = nil
        messages = []
        participants = []
        knownIds = []
        streamingText = ""
        streamingData = []
        streamingUsage = nil
        toolActivity = nil
        pendingSummon = false
        currentMauriceId = defaultMauriceId
    }

    // MARK: - Messages

    func loadMessages(for conversationId: String) async {
        guard let api, let token else { return }
        do {
            let detail: ServerConversationDetail = try await api.get(
                "/api/conversations/\(conversationId)",
                token: token
            )
            messages = detail.messages
            participants = detail.participants ?? []
            knownIds = Set(messages.map { $0.id })
            messagesLoadedFor = conversationId
            pendingSummon = false
            connectSocket(conversationId)
        } catch {
            if Self.isVanished(error) { dropRoom(conversationId); return }
            self.error = error.localizedDescription
        }
    }

    // MARK: - Live room channel

    private func connectSocket(_ conversationId: String) {
        guard let url = session.serverURL, let token else { return }
        if socket == nil {
            socket = RoomSocket(
                onEvent: { [weak self] event in self?.handle(event) },
                // After a drop+reconnect, refetch to catch any messages published
                // while we were offline (pub/sub doesn't replay).
                onReconnect: { [weak self] in Task { await self?.reloadActiveMessages() } }
            )
        }
        socket?.connect(baseURL: url, conversationId: conversationId, token: token)
    }

    /// Re-pull the active room's messages (e.g. after a socket reconnect),
    /// merging by id so nothing is lost or duplicated. Skipped mid-stream so an
    /// in-flight reply isn't disturbed.
    private func reloadActiveMessages() async {
        guard let api, let token, let id = activeConversationId, !isStreaming else { return }
        let detail: ServerConversationDetail
        do {
            detail = try await api.get("/api/conversations/\(id)", token: token)
        } catch {
            // Deleted from another device (or by the web): stop chasing it.
            if Self.isVanished(error), id == activeConversationId { dropRoom(id) }
            return
        }
        guard id == activeConversationId else { return } // room changed meanwhile
        messages = detail.messages
        participants = detail.participants ?? []
        knownIds = Set(messages.map { $0.id })
        pendingSummon = false
    }

    private func handle(_ event: RoomEvent) {
        switch event.type {
        case "message":
            if let m = event.message { mergeIncoming(m) }
        case "participants":
            if let p = event.participants { participants = p }
        case "summoned":
            // Observers (who didn't summon) get a "Maurice is thinking" hint.
            if !isStreaming { pendingSummon = true }
        default:
            break
        }
    }

    /// Fold a live message into the thread, de-duping the sender's own optimistic
    /// copy (temp id) and any echo of a message we already have.
    private func mergeIncoming(_ msg: ServerMessage) {
        if knownIds.contains(msg.id) { return }
        if msg.role == "user", msg.author_id == session.activeUserId,
           let idx = messages.lastIndex(where: {
               $0.role == "user" && $0.author_id == session.activeUserId && !knownIds.contains($0.id)
           }) {
            messages[idx] = msg // reconcile optimistic → server version
        } else {
            messages.append(msg)
        }
        knownIds.insert(msg.id)
        if msg.role == "assistant" { pendingSummon = false }
    }

    // MARK: - Participants

    func loadRoster() async {
        guard let api, let token else { return }
        roster = (try? await api.get("/api/users", token: token)) ?? []
        // Refresh stale local profiles (avatar/color/name) from the live roster.
        session.reconcileDeviceUsers(from: roster)
    }

    func addParticipant(memberId: String) async {
        guard let api, let token, let convoId = activeConversationId else { return }
        struct Body: Encodable { let member_id: String }
        do {
            participants = try await api.post(
                "/api/conversations/\(convoId)/participants",
                body: Body(member_id: memberId),
                token: token
            )
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Remove a participant (e.g. one added by mistake). The room socket also
    /// pushes the authoritative roster; we drop it locally for an instant update.
    func removeParticipant(memberId: String) async {
        guard let api, let token, let convoId = activeConversationId else { return }
        do {
            try await api.delete("/api/conversations/\(convoId)/participants/\(memberId)", token: token)
            participants.removeAll { $0.member_id == memberId }
        } catch {
            self.error = error.localizedDescription
        }
    }

    // MARK: - Safety (report / block / leave / operator review)

    /// Report a message or member in the active (shared) room. Returns success.
    func report(targetType: String, targetId: String, reason: String, note: String?) async -> Bool {
        guard let api, let token, let convoId = activeConversationId else { return false }
        struct Body: Encodable { let target_type: String; let target_id: String; let reason: String; let note: String? }
        do {
            let _: OkResp = try await api.post(
                "/api/conversations/\(convoId)/reports",
                body: Body(target_type: targetType, target_id: targetId, reason: reason, note: note),
                token: token)
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    /// Block a member — server-side hides their messages from you in shared rooms.
    /// Member↔member only; not protection from a hostile operator (use Leave).
    func block(memberId: String) async {
        guard let api, let token else { return }
        do {
            let _: OkResp = try await api.post("/api/users/\(memberId)/block", body: EmptyBody(), token: token)
            // Drop their messages locally for an instant effect.
            messages.removeAll { $0.author_id == memberId }
        } catch {
            self.error = error.localizedDescription
        }
    }

    func unblock(memberId: String) async {
        guard let api, let token else { return }
        try? await api.delete("/api/users/\(memberId)/block", token: token)
    }

    /// Leave the active room.
    func leaveRoom() async {
        guard let api, let token, let convoId = activeConversationId else { return }
        do {
            let _: OkResp = try await api.post("/api/conversations/\(convoId)/leave", body: EmptyBody(), token: token)
            conversations.removeAll { $0.id == convoId }
            activeConversationId = conversations.first?.id
            messages = []
            participants = []
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Operator-only: open reports (child_safety first).
    func loadOpenReports() async -> [ReportView] {
        guard let api, let token else { return [] }
        return (try? await api.get("/api/reports?status=open", token: token)) ?? []
    }

    func actionReport(_ id: String, removeMessage: Bool, ejectMember: Bool) async {
        guard let api, let token else { return }
        struct Body: Encodable { let remove_message: Bool; let eject_member: Bool }
        do {
            let _: ReportView = try await api.post(
                "/api/reports/\(id)/action",
                body: Body(remove_message: removeMessage, eject_member: ejectMember), token: token)
        } catch { self.error = error.localizedDescription }
    }

    func dismissReport(_ id: String) async {
        guard let api, let token else { return }
        do {
            let _: ReportView = try await api.post("/api/reports/\(id)/dismiss", body: EmptyBody(), token: token)
        } catch { self.error = error.localizedDescription }
    }

    // MARK: - Per-conversation tool families

    struct ConversationFamilies: Decodable {
        let selected: [String]
        let all: Bool
        let overridden: Bool
    }

    func conversationFamilies(_ id: String) async -> ConversationFamilies? {
        guard let api, let token else { return nil }
        return try? await api.get("/api/conversations/\(id)/tool-families", token: token)
    }

    /// Set (array) or clear (nil → inherit) the conversation's tool-family override.
    func setConversationFamilies(_ id: String, _ families: [String]?) async {
        guard let api, let token else { return }
        struct Body: Encodable { let families: [String]? }
        struct Ok: Decodable { let ok: Bool? }
        let _: Ok? = try? await api.patch(
            "/api/conversations/\(id)/tool-families",
            body: Body(families: families),
            token: token
        )
    }

    // MARK: - Send (Streaming)

    func send(_ text: String, imageData: Data? = nil) async {
        guard api != nil, token != nil else { return }

        if activeConversationId == nil {
            // A fresh thread inherits the armed Maurice (everyday if none).
            await createConversation(mauriceId: currentMauriceId)
        }
        guard let convoId = activeConversationId else { return }

        // Remember who we just sent to, so the next new conversation arms them.
        defaultMauriceId = currentMauriceId

        // Build display content for the local message
        var displayContent = text
        if imageData != nil {
            // Placeholder — will be replaced by actual URL from server
            displayContent = "![photo](pending)\(text.isEmpty ? "" : "\n\n\(text)")"
        }

        let userMsg = ServerMessage(
            id: UUID().uuidString,
            role: "user",
            content: displayContent,
            model: nil,
            author_id: session.activeUserId,
            created_at: ISO8601DateFormatter().string(from: Date())
        )
        messages.append(userMsg)

        // Convert image to base64 data URI
        var imageDataUri: String?
        if let imageData {
            imageDataUri = "data:image/jpeg;base64," + imageData.base64EncodedString()
        }

        await runAssistantStream(convoId: convoId, content: text, imageDataUri: imageDataUri,
                                 mauriceId: currentMauriceId)
    }

    /// 💬 — post a human-only turn to the room without summoning any Maurice.
    func postBubble(_ text: String, imageData: Data? = nil) async {
        guard let api, let token else { return }
        if activeConversationId == nil { await createConversation() }
        guard let convoId = activeConversationId else { return }

        var displayContent = text
        if imageData != nil {
            displayContent = "![photo](pending)\(text.isEmpty ? "" : "\n\n\(text)")"
        }
        messages.append(ServerMessage(
            id: UUID().uuidString, role: "user", content: displayContent,
            model: nil, author_id: session.activeUserId,
            created_at: ISO8601DateFormatter().string(from: Date())
        ))
        let imageUri = imageData.map { "data:image/jpeg;base64," + $0.base64EncodedString() }
        let _: OkResponse? = try? await api.post(
            "/api/conversations/\(convoId)/messages",
            body: BubblePost(content: text, summon: false, image: imageUri), token: token)
    }

    /// ⏹ — stop the in-flight generation. The server hears it first: a turn
    /// belongs to the conversation, not to the request, so dropping the
    /// request alone would leave Maurice writing. The partial reply (if any)
    /// comes back over the room socket.
    func stop() {
        requestServerStop()
        streamTask?.cancel()
    }

    /// Cancel a running reply and wait for it to actually wind down.
    ///
    /// stop() only asks. Callers that go on to mutate the thread — starting a
    /// new one, switching member — need the stream's own bookkeeping to have
    /// run first, or `isStreaming` stays true and the composer of a brand-new
    /// conversation comes up disabled.
    func stopAndWait() async {
        guard let task = streamTask else { return }
        requestServerStop()
        task.cancel()
        _ = await task.value
        isStreaming = false
    }

    /// Fire-and-forget: the local follower is torn down regardless, and a stop
    /// that finds nothing running (404) has nothing to tell us.
    private func requestServerStop() {
        guard let api, let token,
              let convoId = followedTurn?.convoId ?? activeConversationId else { return }
        followedTurn = nil
        Task { try? await api.stopTurn(conversationId: convoId, token: token) }
    }

    /// Hide the error banner. Nothing else clears it any more: a refresh that
    /// happens to succeed says nothing about the failure being shown.
    func dismissError() {
        error = nil
    }

    /// Re-answer the last user turn: drop the previous assistant message and
    /// stream a fresh response. No-op while streaming or with no answer to redo.
    func regenerate() async {
        guard !isStreaming, let convoId = activeConversationId else { return }
        guard messages.last?.role == "assistant" else { return }
        messages.removeLast()
        await runAssistantStream(convoId: convoId, content: "", imageDataUri: nil, regenerate: true)
    }

    /// Shared streaming pipeline for both send and regenerate.
    private func runAssistantStream(
        convoId: String,
        content: String,
        imageDataUri: String?,
        regenerate: Bool = false,
        mauriceId: String? = nil
    ) async {
        guard let api, let token else { return }
        await followTurn(convoId: convoId, api: api, token: token) {
            try api.streamMessage(
                conversationId: convoId,
                content: content,
                image: imageDataUri,
                token: token,
                regenerate: regenerate,
                summon: true,
                mauriceId: mauriceId
            )
        }
    }

    /// How following a turn ended.
    private enum TurnOutcome {
        /// The turn ended on the server: its `done`, or nil after an `error`
        /// event (already shown).
        case ended(StreamEvent?)
        /// Nothing to follow (204): the reply is either persisted already or
        /// was never produced. Only a re-read of the thread tells which.
        case nothingRunning
        /// ⏹, a refusal, or a connection that could not be recovered — the
        /// banner says so where there is something to say.
        case abandoned
    }

    /// Follow one assistant turn to its end and fold the result into the
    /// thread. `open` makes the first stream (the POST that starts the turn);
    /// nil means pick up a turn already running (GET /turn).
    ///
    /// A stream that ends before its terminal event is a lost connection, not
    /// a lost reply: the server goes on without us. So it is re-attached,
    /// quietly — the activity line says "connection lost, Maurice continues"
    /// — and the red banner is kept for the cases where nothing more can be
    /// done. On iPhone the whole thing runs under a background grace, so a
    /// reply that is nearly there survives a few seconds in another app.
    private func followTurn(
        convoId: String,
        api: APIClient,
        token: String,
        open: (() throws -> AsyncThrowingStream<StreamEvent, Error>)?
    ) async {
        isStreaming = true
        streamingText = ""
        streamingData = []
        streamingUsage = nil
        error = nil
        followedTurn = (convoId, Date())
        #if os(iOS) && canImport(UIKit)
        let grace = BackgroundGrace()
        defer { grace.end() }
        #endif

        // Consume the stream in a cancellable child task (inherits this
        // @MainActor context). ⏹ Stop cancels it, which ends the loop and —
        // via the stream's onTermination — aborts the HTTP request.
        let task = Task { () -> TurnOutcome in
            var open = open
            // Consecutive failures of the re-attach request itself; reset
            // once a stream is obtained again.
            var attachFailures = 0
            // Streams that died mid-way, in total: a tunnel that drops every
            // re-attached stream must not be chased forever.
            var drops = 0
            while true {
                var attached = false
                // Whether this pass lost the connection (as opposed to being
                // told no): only then is the member told we are reconnecting.
                var lost = false
                do {
                    let stream: AsyncThrowingStream<StreamEvent, Error>
                    if let first = open {
                        open = nil
                        stream = try first()
                    } else if let picked = try await api.streamTurn(conversationId: convoId, token: token) {
                        stream = picked
                    } else {
                        return .nothingRunning
                    }
                    attached = true
                    attachFailures = 0
                    if let terminal = try await pump(stream) {
                        return .ended(terminal.type == .done ? terminal : nil)
                    }
                    // The bytes ran out before done/error: the connection
                    // went, not the turn. (Also what a kicked pump looks like.)
                    if Task.isCancelled { return .abandoned }
                    drops += 1
                    lost = true
                } catch {
                    // Only ⏹ cancels this task; a CancellationError with the
                    // task still alive came from the pump and is a drop.
                    if Task.isCancelled { return .abandoned }
                    if case APIError.server(let code, _) = error {
                        if code == 409 {
                            // Not taken: Maurice is already answering here (an
                            // earlier request of ours, or another device).
                            // Follow that reply instead of pretending ours went.
                            dropUnconfirmedUserMessage()
                            self.error = L("chat.error.busy")
                        } else {
                            // The server answered, and no. That is final.
                            self.error = error.localizedDescription
                            return .abandoned
                        }
                    } else if !attached {
                        // The re-attach itself failed. A network error gets a
                        // few more tries; anything else is not going to mend.
                        attachFailures += 1
                        if attachFailures >= 3 || !Self.isNetworkError(error) {
                            self.error = L("chat.error.lost")
                            return .abandoned
                        }
                        lost = true
                    } else {
                        drops += 1
                        lost = true
                    }
                }
                if drops >= 6 {
                    self.error = L("chat.error.lost")
                    return .abandoned
                }
                if lost {
                    toolActivity = L("chat.activity.reconnecting")
                    isGeneratingImage = false
                }
                try? await Task.sleep(for: .seconds(attachFailures > 0 ? 2 : 1))
                if Task.isCancelled { return .abandoned }
            }
        }
        streamTask = task
        let outcome = await task.value
        streamTask = nil
        switch outcome {
        case .ended, .nothingRunning:
            if followedTurn?.convoId == convoId { followedTurn = nil }
        case .abandoned:
            break // ⏹ cleared it; a give-up keeps it for the next foreground
        }

        // Everything below belongs to the thread this stream was started for.
        // Cancelling does not stop it: we are suspended at `await task.value`
        // and resume at an unpredictable point, after startNewConversation has
        // cleared `messages` — so the old thread's finished reply would be
        // appended into the new, empty one, and knownIds having been cleared
        // too, the dedupe check could not catch it.
        guard activeConversationId == convoId else {
            streamingText = ""
            streamingData = []
            streamingUsage = nil
            isGeneratingImage = false
            toolActivity = nil
            pendingSummon = false
            return
        }

        if case .ended(let event) = outcome, let event {
            let id = event.message_id ?? UUID().uuidString
            // The room socket may have already delivered this reply — only append
            // if it's not already in the thread.
            if !knownIds.contains(id) {
                let assistantMsg = ServerMessage(
                    id: id,
                    role: "assistant",
                    content: streamingText,
                    model: nil,
                    author_id: nil,
                    data: streamingData.isEmpty ? nil : streamingData,
                    usage: streamingUsage,
                    created_at: ISO8601DateFormatter().string(from: Date())
                )
                messages.append(assistantMsg)
                knownIds.insert(id)
            }
        }

        streamingText = ""
        streamingData = []
        streamingUsage = nil
        isStreaming = false
        isGeneratingImage = false
        toolActivity = nil
        pendingSummon = false
        if case .nothingRunning = outcome {
            // Persisted while we were away, or never made: the thread knows.
            await reloadActiveMessages()
        }
        await loadConversations()
    }

    /// Render one stream's events until its terminal event. Returns that
    /// event, or nil when the bytes ran out first (a dropped connection).
    /// Runs in a task of its own so a re-attach can be forced from outside
    /// (`didBecomeActive`) without abandoning the turn being followed.
    private func pump(_ stream: AsyncThrowingStream<StreamEvent, Error>) async throws -> StreamEvent? {
        let task = Task { () throws -> StreamEvent? in
            for try await event in stream {
                if Task.isCancelled { return nil }
                render(event)
                if event.type == .done || event.type == .error { return event }
            }
            return nil
        }
        pumpTask = task
        defer { pumpTask = nil }
        return try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
    }

    /// Show one event of a turn — the same whether it comes from the request
    /// that started the turn or from one re-attached to it.
    private func render(_ event: StreamEvent) {
        switch event.type {
        case .resume:
            // Everything the turn produced while we were not looking.
            streamingText = event.text ?? ""
            streamingData = event.blocks ?? []
            streamingUsage = event.usage
            isGeneratingImage = false
            toolActivity = event.tool.map(Self.toolLabel(for:))
        case .text_delta:
            if let t = event.text {
                streamingText += t
            }
            // Visible text ends the "Thinking" phase (a tool label
            // is cleared by its own end event).
            if toolActivity == Self.thinkingLabel { toolActivity = nil }
        case .thinking:
            // Reasoning models go quiet for a while before the first
            // word; say so instead of showing a bare spinner.
            if toolActivity == nil { toolActivity = Self.thinkingLabel }
        case .ping:
            break // keepalive — nothing to show
        case .image_loading:
            streamingText = ""
            isGeneratingImage = true
        case .image:
            isGeneratingImage = false
            if let url = event.image_url {
                let prompt = event.text ?? "image"
                streamingText = "![\(prompt)](\(url))"
            }
        case .tool_call:
            if event.status == "start", let tool = event.tool {
                toolActivity = Self.toolLabel(for: tool)
            } else {
                toolActivity = nil
            }
        case .tool_data:
            if let data = event.data {
                streamingData.append(DataBlock(tool: event.tool ?? "tool", data: data))
            }
        case .usage:
            streamingUsage = event.usage
        case .done:
            break // the follower takes it from here
        case .error:
            isGeneratingImage = false
            toolActivity = nil
            self.error = event.message ?? "Stream error"
        }
    }

    /// Take back the message the server refused: the optimistic copy send()
    /// appended, which no echo will ever reconcile.
    private func dropUnconfirmedUserMessage() {
        guard let i = messages.lastIndex(where: {
            $0.role == "user" && $0.author_id == session.activeUserId && !knownIds.contains($0.id)
        }) else { return }
        messages.remove(at: i)
    }

    /// Whether the network let us down (worth another try) rather than the
    /// server or the code.
    private static func isNetworkError(_ error: Error) -> Bool {
        if error is URLError { return true }
        if case APIError.requestFailed = error { return true }
        return (error as NSError).domain == NSPOSIXErrorDomain
    }

    /// Back in front. A suspension kills every connection: reconnect both
    /// sockets now rather than after their backoff, and if a reply was being
    /// followed, pick it up. Either the follower is still up — perhaps hung
    /// on a socket iOS closed without a word: kick it, it re-attaches — or it
    /// gave up while we were away and the same turn is followed afresh.
    private func didBecomeActive() async {
        let away = wentInactiveAt.map { Date().timeIntervalSince($0) } ?? 0
        // A glance at the app switcher leaves everything alive; only a real
        // absence is worth tearing connections down for.
        guard away >= 3 else { return }
        socket?.reconnectNow()
        userSocket?.reconnectNow()
        if streamTask != nil {
            pumpTask?.cancel()
            return
        }
        guard let turn = followedTurn, turn.convoId == activeConversationId,
              Date().timeIntervalSince(turn.startedAt) < 300,
              let api, let token else { return }
        await followTurn(convoId: turn.convoId, api: api, token: token, open: nil)
    }

    /// Activity label while a reasoning model thinks (see `.thinking` above).
    /// Computed, not a stored `let`: a stored one would freeze the string at
    /// first access, and the label is compared by value to clear the phase —
    /// after a language change the comparison would never match again.
    private static var thinkingLabel: String { L("chat.activity.thinking") }

    /// Map a server tool name (e.g. "web_search", "tasks__triage") to a
    /// friendly activity label. The server segment of an MCP name is its own
    /// identifier ("tasks", "garden") and stays as it is.
    private static func toolLabel(for tool: String) -> String {
        if tool == "web_search" { return L("chat.activity.webSearch") }
        // MCP tools are namespaced "server__tool"; show the server segment.
        let server = tool.components(separatedBy: "__").first ?? tool
        return L("chat.activity.usingTool", server)
    }

    // MARK: - User Switch

    func onUserSwitch() async {
        socket?.disconnect()
        userSocket?.disconnect()
        userSocket = nil // reconnects for the new user via loadConversations()
        conversations = []
        messages = []
        participants = []
        roster = []
        knownIds = []
        unread = []
        pendingSummon = false
        activeConversationId = nil
        followedTurn = nil
        streamingText = ""
        streamingData = []
        streamingUsage = nil
        toolActivity = nil
        error = nil
        await loadConversations()
        // Open a conversation requested by a cross-household notification tap,
        // else fall back to the most recent.
        if let pid = pendingOpenConversation, conversations.contains(where: { $0.id == pid }) {
            pendingOpenConversation = nil
            await selectConversation(pid)
        } else if let first = conversations.first {
            await selectConversation(first.id)
        }
    }
}

private struct EmptyBody: Encodable {}

#if os(iOS) && canImport(UIKit)
/// Asks iOS to keep the app running a while after it leaves the screen, so a
/// reply that is nearly there finishes instead of dying with the suspension.
/// Ended explicitly by the follower, or by the system when its patience runs
/// out (the handler runs on the main thread, as documented).
@MainActor
private final class BackgroundGrace {
    private var id: UIBackgroundTaskIdentifier = .invalid

    init() {
        id = UIApplication.shared.beginBackgroundTask(withName: "chat.turn") { [weak self] in
            MainActor.assumeIsolated { self?.end() }
        }
    }

    func end() {
        guard id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
        id = .invalid
    }
}
#endif

// MARK: - Room Socket
//
// Live channel for a single room. Subscribes to the server's per-conversation
// WebSocket (/api/conversations/:id/ws) and delivers authored messages,
// participant changes, and summon events. Clients can't set an Authorization
// header on a WebSocket, so the session token rides in the query.
//
// (Kept in this file rather than its own because the Xcode project lists sources
// explicitly and MarkdownUI is wired into the committed project, not project.yml,
// so `xcodegen generate` can't be used to pick up a new standalone file.)

@MainActor
final class RoomSocket {
    private var task: URLSessionWebSocketTask?
    private var closed = false
    private let onEvent: (RoomEvent) -> Void
    private let onReconnect: () -> Void
    // Retained so we can transparently reconnect after a drop.
    private var baseURL = ""
    private var conversationId = ""
    private var token = ""
    private var backoff = 1            // seconds, doubles up to a cap
    /// Bumped on every (re)open + on disconnect so stale task callbacks are ignored.
    private var epoch = 0

    init(onEvent: @escaping (RoomEvent) -> Void, onReconnect: @escaping () -> Void = {}) {
        self.onEvent = onEvent
        self.onReconnect = onReconnect
    }

    func connect(baseURL: String, conversationId: String, token: String) {
        self.baseURL = baseURL
        self.conversationId = conversationId
        self.token = token
        backoff = 1
        openSocket()
    }

    func disconnect() {
        closed = true
        epoch &+= 1
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    /// Reopen now, backoff reset — for a return to the foreground, when the
    /// old connection is dead and the scheduled retry may be 30 s out.
    func reconnectNow() {
        guard !closed else { return }
        backoff = 1
        openSocket()
        onReconnect()
    }

    private func openSocket() {
        task?.cancel(with: .goingAway, reason: nil)
        closed = false
        epoch &+= 1
        let myEpoch = epoch
        guard let url = Self.socketURL(baseURL: baseURL, conversationId: conversationId, token: token) else {
            return
        }
        let t = URLSession.shared.webSocketTask(with: url)
        task = t
        t.resume()
        receive(myEpoch)
    }

    /// A drop (network blip, server restart, app resume…) must not silently end
    /// live updates: reconnect with capped backoff and let the owner refetch to
    /// catch up. Reset backoff once messages flow again.
    private func scheduleReconnect(_ myEpoch: Int) {
        guard !closed else { return }
        let delay = backoff
        backoff = min(backoff * 2, 30)
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(delay))
            guard !self.closed, myEpoch == self.epoch else { return } // superseded
            self.openSocket()
            self.onReconnect()
        }
    }

    private func receive(_ myEpoch: Int) {
        task?.receive { [weak self] result in
            guard let self else { return }
            Task { @MainActor in
                guard !self.closed, myEpoch == self.epoch else { return }
                switch result {
                case .failure:
                    self.scheduleReconnect(myEpoch)
                case .success(let message):
                    self.backoff = 1 // healthy again
                    if case .string(let text) = message,
                       let data = text.data(using: .utf8),
                       let event = try? JSONDecoder().decode(RoomEvent.self, from: data) {
                        self.onEvent(event)
                    }
                    self.receive(myEpoch)
                }
            }
        }
    }

    private static func socketURL(baseURL: String, conversationId: String, token: String) -> URL? {
        var scheme = baseURL
        if scheme.hasPrefix("https") { scheme = "wss" + scheme.dropFirst("https".count) }
        else if scheme.hasPrefix("http") { scheme = "ws" + scheme.dropFirst("http".count) }
        let enc = token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? token
        return URL(string: "\(scheme)/api/conversations/\(conversationId)/ws?token=\(enc)")
    }
}

// MARK: - User Socket
//
// Global per-user channel (/api/me/ws): open regardless of which room is shown,
// so the member learns about new conversations and activity. Same reconnect
// behaviour as RoomSocket.

@MainActor
final class UserSocket {
    private var task: URLSessionWebSocketTask?
    private var closed = false
    private let onEvent: (UserEvent) -> Void
    private let onReconnect: () -> Void
    private var baseURL = ""
    private var token = ""
    private var backoff = 1
    private var epoch = 0

    init(onEvent: @escaping (UserEvent) -> Void, onReconnect: @escaping () -> Void = {}) {
        self.onEvent = onEvent
        self.onReconnect = onReconnect
    }

    func connect(baseURL: String, token: String) {
        self.baseURL = baseURL
        self.token = token
        backoff = 1
        openSocket()
    }

    func disconnect() {
        closed = true
        epoch &+= 1
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    /// See RoomSocket.reconnectNow.
    func reconnectNow() {
        guard !closed else { return }
        backoff = 1
        openSocket()
        onReconnect()
    }

    private func openSocket() {
        task?.cancel(with: .goingAway, reason: nil)
        closed = false
        epoch &+= 1
        let myEpoch = epoch
        guard let url = Self.socketURL(baseURL: baseURL, token: token) else { return }
        let t = URLSession.shared.webSocketTask(with: url)
        task = t
        t.resume()
        receive(myEpoch)
    }

    private func scheduleReconnect(_ myEpoch: Int) {
        guard !closed else { return }
        let delay = backoff
        backoff = min(backoff * 2, 30)
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(delay))
            guard !self.closed, myEpoch == self.epoch else { return }
            self.openSocket()
            self.onReconnect()
        }
    }

    private func receive(_ myEpoch: Int) {
        task?.receive { [weak self] result in
            guard let self else { return }
            Task { @MainActor in
                guard !self.closed, myEpoch == self.epoch else { return }
                switch result {
                case .failure:
                    self.scheduleReconnect(myEpoch)
                case .success(let message):
                    self.backoff = 1
                    if case .string(let text) = message,
                       let data = text.data(using: .utf8),
                       let event = try? JSONDecoder().decode(UserEvent.self, from: data) {
                        self.onEvent(event)
                    }
                    self.receive(myEpoch)
                }
            }
        }
    }

    private static func socketURL(baseURL: String, token: String) -> URL? {
        var scheme = baseURL
        if scheme.hasPrefix("https") { scheme = "wss" + scheme.dropFirst("https".count) }
        else if scheme.hasPrefix("http") { scheme = "ws" + scheme.dropFirst("http".count) }
        let enc = token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? token
        return URL(string: "\(scheme)/api/me/ws?token=\(enc)")
    }
}

// MARK: - Local notifications

@MainActor
final class NotificationManager: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationManager()
    /// Open a conversation when its notification is tapped (conversationId,
    /// householdTag) — the tag (remote pushes only) routes to the right household.
    var onTap: ((String, String?) -> Void)?
    /// The APNs device token (hex), once the system grants it; uploaded by ChatService.
    private(set) var deviceToken: String?
    /// Called when the device token arrives (ChatService uploads it to the server).
    var onDeviceToken: ((String) -> Void)?
    private var requested = false

    func requestAuthorizationOnce() {
        guard !requested else { return }
        requested = true
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            Task { @MainActor in self.registerForRemotePush() }
        }
    }

    private func registerForRemotePush() {
        #if os(iOS)
        UIApplication.shared.registerForRemoteNotifications()
        #elseif os(macOS)
        NSApplication.shared.registerForRemoteNotifications()
        #endif
    }

    /// Called by the app delegate with the raw APNs token.
    func setDeviceToken(_ token: String) {
        deviceToken = token
        onDeviceToken?(token)
    }

    func notify(title: String, body: String, conversationId: String?) {
        let content = UNMutableNotificationContent()
        content.title = title.isEmpty ? "Maurice" : title
        content.body = body
        content.sound = .default
        if let id = conversationId { content.userInfo = ["conversationId": id] }
        let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req)
    }

    // Show banners even when the app is in the foreground.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    // Tapping a notification opens the conversation.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let info = response.notification.request.content.userInfo
        let id = info["conversationId"] as? String
        let tag = info["householdTag"] as? String
        Task { @MainActor in if let id { NotificationManager.shared.onTap?(id, tag) } }
        completionHandler()
    }
}

/// One frame from the room channel. `type` is one of:
///   "message"      → a new authored message (human or Maurice)
///   "participants" → the room roster changed
///   "summoned"     → someone @-mentioned Maurice; he's about to reply
struct RoomEvent: Decodable {
    let type: String
    let message: ServerMessage?
    let participants: [ServerParticipant]?
    let by: String?
}

/// Events on the global per-user channel (/api/me/ws): you were added to a
/// conversation, Maurice opened one for you, or there's activity in a room
/// you may not be viewing.
struct UserEvent: Decodable {
    let type: String          // "conversation_added" | "conversation_opened" | "activity"
    let conversationId: String?
    let title: String?
    let author: String?       // activity: who spoke ("Maurice" for replies)
    let preview: String?      // activity: short message preview
    let by: String?           // conversation_added: who added you
}

// MARK: - Safety models

private struct OkResp: Decodable { let ok: Bool? }

/// The five report reasons (raw values mirror the server enum). `child_safety`
/// is prioritized server-side and shows an authority notice on submit.
enum ReportReason: String, CaseIterable, Identifiable {
    case spam
    case harassment_or_bullying
    case sexual_content
    case child_safety
    case other
    var id: String { rawValue }
    var label: String {
        switch self {
        case .spam: return "Spam"
        case .harassment_or_bullying: return "Harassment or bullying"
        case .sexual_content: return "Sexual content"
        case .child_safety: return "Child safety / content involving a minor"
        case .other: return "Other"
        }
    }
}

/// Operator view of a report (from GET /api/reports). Reported content is always
/// shared-room content — never a private 1:1.
struct ReportView: Decodable, Identifiable {
    let id: String
    let room_id: String
    let target_type: String
    let target_id: String
    let reason: String
    let note: String?
    let status: String
    let created_at: String
    let reporter_display_name: String?
    let room_title: String?
    let reported_message: ReportedMessage?
    let reported_member: ReportedMember?
}

struct ReportedMessage: Decodable {
    let id: String
    let content: String
    let author_id: String?
    let created_at: String
}

struct ReportedMember: Decodable {
    let id: String
    let display_name: String
    let username: String
}
