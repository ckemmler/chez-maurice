import Foundation
import SwiftUI

// MARK: - API Client

/// HTTP client for the Maurice server. Handles JSON requests,
/// Bearer auth, and ndjson streaming for chat responses.
final class APIClient: Sendable {
    let baseURL: String
    private let streamSession: URLSession

    init(baseURL: String) {
        // Strip trailing slash
        self.baseURL = baseURL.hasSuffix("/")
            ? String(baseURL.dropLast())
            : baseURL

        // A session configured for streaming — no response buffering
        let config = URLSessionConfiguration.default
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.streamSession = URLSession(configuration: config)
    }

    // MARK: - JSON Requests

    func get<T: Decodable>(
        _ path: String,
        token: String? = nil,
        timeout: TimeInterval? = nil
    ) async throws -> T {
        let request = buildRequest(path, method: "GET", token: token, timeout: timeout)
        return try await perform(request)
    }

    func post<T: Decodable>(
        _ path: String,
        body: some Encodable,
        token: String? = nil
    ) async throws -> T {
        var request = buildRequest(path, method: "POST", token: token)
        request.httpBody = try JSONEncoder().encode(body)
        return try await perform(request)
    }

    func patch<T: Decodable>(
        _ path: String,
        body: some Encodable,
        token: String? = nil
    ) async throws -> T {
        var request = buildRequest(path, method: "PATCH", token: token)
        request.httpBody = try JSONEncoder().encode(body)
        return try await perform(request)
    }

    func put<T: Decodable>(
        _ path: String,
        body: some Encodable,
        token: String? = nil
    ) async throws -> T {
        var request = buildRequest(path, method: "PUT", token: token)
        request.httpBody = try JSONEncoder().encode(body)
        return try await perform(request)
    }

    func delete(
        _ path: String,
        token: String? = nil
    ) async throws {
        let request = buildRequest(path, method: "DELETE", token: token)
        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse,
              (200...299).contains(http.statusCode) else {
            throw APIError.requestFailed
        }
    }

    // MARK: - Multipart upload

    /// POST a file as multipart/form-data. `fields` carries extra text parts
    /// (e.g. folder_id). Decodes the JSON row the server returns.
    func upload<T: Decodable>(
        _ path: String,
        fileName: String,
        fileData: Data,
        fields: [String: String] = [:],
        token: String? = nil
    ) async throws -> T {
        let boundary = "Boundary-\(UUID().uuidString)"
        var request = URLRequest(url: URL(string: baseURL + path)!)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        request.timeoutInterval = 180
        var body = Data()
        func part(_ s: String) { body.append(Data(s.utf8)) }
        for (k, v) in fields {
            part("--\(boundary)\r\n")
            part("Content-Disposition: form-data; name=\"\(k)\"\r\n\r\n")
            part(v); part("\r\n")
        }
        part("--\(boundary)\r\n")
        part("Content-Disposition: form-data; name=\"file\"; filename=\"\(fileName)\"\r\n")
        part("Content-Type: application/octet-stream\r\n\r\n")
        body.append(fileData)
        part("\r\n")
        part("--\(boundary)--\r\n")
        request.httpBody = body
        return try await perform(request)
    }

    // MARK: - Streaming (ndjson)

    /// Sends a message and returns an AsyncStream of parsed events.
    ///
    /// A refusal (409 while a reply is already running, 4xx/5xx in general)
    /// surfaces through the stream as `APIError.server`, body included, so
    /// the caller can tell "the server said no" from "the connection died".
    func streamMessage(
        conversationId: String,
        content: String,
        image: String? = nil,
        token: String,
        regenerate: Bool = false,
        summon: Bool = true,
        mauriceId: String? = nil
    ) throws -> AsyncThrowingStream<StreamEvent, Error> {
        var request = buildRequest(
            "/api/conversations/\(conversationId)/messages",
            method: "POST",
            token: token
        )
        var body: [String: Any] = ["content": content, "summon": summon]
        if let image { body["image"] = image }
        if regenerate { body["regenerate"] = true }
        // The armed Maurice (null = everyday) — arms the thread + is summoned by ➤.
        body["maurice_id"] = mauriceId ?? NSNull()
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let session = self.streamSession

        return AsyncThrowingStream { continuation in
            let task = Task.detached {
                do {
                    let (bytes, response) = try await session.bytes(for: request)
                    guard let http = response as? HTTPURLResponse else {
                        continuation.finish(throwing: APIError.requestFailed)
                        return
                    }
                    guard (200...299).contains(http.statusCode) else {
                        continuation.finish(throwing: await Self.httpError(http, bytes))
                        return
                    }
                    try await Self.pump(bytes, into: continuation)
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Pick up the turn in flight in a conversation — the one a lost request
    /// was following, or one started elsewhere. nil on 204: nothing is running
    /// and nothing finished in the last minute. Otherwise the stream opens on
    /// a `resume` snapshot (everything so far) and carries the live events to
    /// the terminal `done`/`error`, exactly as the POST stream would.
    ///
    /// The request is made here, before the stream is handed out, so a 204 is
    /// a value and not an event the caller has to fish out of the stream.
    func streamTurn(
        conversationId: String,
        token: String
    ) async throws -> AsyncThrowingStream<StreamEvent, Error>? {
        let request = buildRequest(
            "/api/conversations/\(conversationId)/turn",
            method: "GET",
            token: token
        )
        let (bytes, response) = try await streamSession.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.requestFailed }
        if http.statusCode == 204 { return nil }
        guard (200...299).contains(http.statusCode) else {
            throw await Self.httpError(http, bytes)
        }
        return AsyncThrowingStream { continuation in
            let task = Task.detached {
                do {
                    try await Self.pump(bytes, into: continuation)
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Ask the server to halt the turn running in a conversation. Generation
    /// no longer stops when a client disconnects — the turn belongs to the
    /// conversation — so ⏹ has to say so explicitly.
    func stopTurn(conversationId: String, token: String) async throws {
        let _: OkResponse = try await post(
            "/api/conversations/\(conversationId)/turn/stop",
            body: EmptyJSON(),
            token: token
        )
    }

    /// Feed one ndjson byte stream to a continuation, line by line, and finish
    /// it on the terminal event (or when the bytes run out).
    private static func pump(
        _ bytes: URLSession.AsyncBytes,
        into continuation: AsyncThrowingStream<StreamEvent, Error>.Continuation
    ) async throws {
        let decoder = JSONDecoder()
        for try await line in bytes.lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty,
                  let data = trimmed.data(using: .utf8) else { continue }
            if let event = try? decoder.decode(StreamEvent.self, from: data) {
                continuation.yield(event)
                if event.type == .done || event.type == .error {
                    break
                }
            }
        }
        continuation.finish()
    }

    /// The error a non-2xx streaming response stands for: the JSON `error`
    /// field when the body carries one, the status alone otherwise.
    private static func httpError(_ http: HTTPURLResponse, _ bytes: URLSession.AsyncBytes) async -> APIError {
        var body = Data()
        do {
            // Bounded: an error body is a sentence, not a stream.
            for try await byte in bytes.prefix(4096) { body.append(byte) }
        } catch {
            // A body cut short still has its status; fall through to it.
        }
        if let parsed = try? JSONDecoder().decode(ErrorBody.self, from: body) {
            return .server(http.statusCode, parsed.error)
        }
        return .server(http.statusCode, "Request failed")
    }

    // MARK: - Internals

    private func buildRequest(
        _ path: String,
        method: String,
        token: String?,
        timeout: TimeInterval? = nil
    ) -> URLRequest {
        var request = URLRequest(url: URL(string: baseURL + path)!)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.timeoutInterval = timeout ?? 180
        return request
    }

    private func perform<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.requestFailed
        }
        guard (200...299).contains(http.statusCode) else {
            if let body = try? JSONDecoder().decode(ErrorBody.self, from: data) {
                throw APIError.server(http.statusCode, body.error)
            }
            throw APIError.server(http.statusCode, "Request failed")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

// MARK: - Stream Event

struct StreamEvent: Decodable {
    let type: EventType
    let text: String?
    let message_id: String?
    let message: String?
    let image_url: String?
    let tool: String?
    let status: String?
    /// tool_data events: the structured rows a tool returned (model-untouched).
    let data: JSONValue?
    /// resume events: every tool_data block the turn produced before we caught
    /// up with it. Same wire key as `data`, but an array of {tool, data}.
    let blocks: [DataBlock]?
    /// usage events: what the turn cost, sent once just before `done`.
    /// On a resume: what it has cost so far, if the server knows yet.
    let usage: TurnUsage?
    /// resume events: the turn already ended; its terminal event follows.
    let finished: Bool?
    /// resume events: when the turn started (ISO 8601).
    let started_at: String?

    enum EventType: String, Decodable {
        case text_delta
        /// The model is reasoning; nothing visible yet. Activity signal only.
        case thinking
        /// Server keepalive during a long silence — resets the idle timer, no UI.
        case ping
        case done
        case error
        case image
        case image_loading
        case tool_call
        case tool_data
        case usage
        /// First line of a re-attached turn: a snapshot of everything so far.
        case resume
    }

    private enum CodingKeys: String, CodingKey {
        case type, text, message_id, message, image_url, tool, status, data, usage, finished, started_at
    }

    /// One malformed block must not cost the whole snapshot.
    private struct LenientBlock: Decodable {
        let block: DataBlock?
        init(from decoder: Decoder) throws { block = try? DataBlock(from: decoder) }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = try c.decode(EventType.self, forKey: .type)
        text = try? c.decodeIfPresent(String.self, forKey: .text)
        message_id = try? c.decodeIfPresent(String.self, forKey: .message_id)
        message = try? c.decodeIfPresent(String.self, forKey: .message)
        image_url = try? c.decodeIfPresent(String.self, forKey: .image_url)
        tool = try? c.decodeIfPresent(String.self, forKey: .tool)
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        usage = try? c.decodeIfPresent(TurnUsage.self, forKey: .usage)
        finished = try? c.decodeIfPresent(Bool.self, forKey: .finished)
        started_at = try? c.decodeIfPresent(String.self, forKey: .started_at)
        // `data` is one tool's payload on tool_data and the list of blocks on
        // resume — two shapes under one key, split by the event type.
        if type == .resume {
            data = nil
            blocks = (try? c.decodeIfPresent([LenientBlock].self, forKey: .data))?
                .compactMap { $0.block }
        } else {
            data = try? c.decodeIfPresent(JSONValue.self, forKey: .data)
            blocks = nil
        }
    }
}

// MARK: - Turn cost

/// What one assistant turn cost, summed over its agentic rounds. `cache_read`
/// is the number that says whether prompt caching is working: zero across
/// repeated turns in the same thread means something upstream keeps changing
/// the prompt prefix. `cost` is nil when the model has no price on file.
struct TurnUsage: Decodable, Equatable {
    let provider: String
    let model: String
    let rounds: Int
    let input: Int
    let output: Int
    let cache_read: Int
    let cache_write: Int
    let cost: Double?
    /// What the same turn would have cost with no cache at all.
    let cost_uncached: Double?

    /// Every token the prompt side of this turn touched, cached or not.
    var promptTokens: Int { input + cache_read + cache_write }

    /// Share of the prompt served from cache, 0…1. Nil when there was no prompt.
    var cacheHitRate: Double? {
        promptTokens > 0 ? Double(cache_read) / Double(promptTokens) : nil
    }

    /// USD saved by the cache on this turn, if both figures are known.
    var saved: Double? {
        guard let cost, let cost_uncached else { return nil }
        return max(0, cost_uncached - cost)
    }
}

/// Every metered turn of a conversation, folded into one figure per column:
/// what the whole thread has cost so far, how much of its prompt traffic the
/// cache served, and which models did the work. Built client-side from the
/// usage the server persists on each assistant message, so it needs no route
/// and is exact for the messages on screen.
///
/// Turns that carry no usage (local models before the server recorded it,
/// providers that report none) are counted in `unmetered` and left out of the
/// sums rather than silently rounding the total down to "cheap".
struct ConversationUsage: Equatable {
    struct ModelShare: Equatable, Identifiable {
        let model: String
        let turns: Int
        let cost: Double?
        var id: String { model }
    }

    let turns: Int
    let unmetered: Int
    let rounds: Int
    let input: Int
    let output: Int
    let cache_read: Int
    let cache_write: Int
    /// Sum over priced turns; nil when no turn was priced. `pricedTurns` says
    /// whether the sum covers everything.
    let cost: Double?
    let cost_uncached: Double?
    let pricedTurns: Int
    let costliestTurn: Double?
    /// Models in order of first appearance.
    let models: [ModelShare]

    init(assistantTurns: [TurnUsage?]) {
        let metered = assistantTurns.compactMap { $0 }
        turns = metered.count
        unmetered = assistantTurns.count - metered.count
        rounds = metered.reduce(0) { $0 + $1.rounds }
        input = metered.reduce(0) { $0 + $1.input }
        output = metered.reduce(0) { $0 + $1.output }
        cache_read = metered.reduce(0) { $0 + $1.cache_read }
        cache_write = metered.reduce(0) { $0 + $1.cache_write }
        let priced = metered.compactMap { $0.cost }
        pricedTurns = priced.count
        cost = priced.isEmpty ? nil : priced.reduce(0, +)
        costliestTurn = priced.max()
        let uncached = metered.compactMap { $0.cost_uncached }
        cost_uncached = uncached.isEmpty ? nil : uncached.reduce(0, +)
        var order: [String] = []
        var byModel: [String: (turns: Int, cost: Double?)] = [:]
        for u in metered {
            var entry = byModel[u.model] ?? { order.append(u.model); return (0, nil) }()
            entry.turns += 1
            if let c = u.cost { entry.cost = (entry.cost ?? 0) + c }
            byModel[u.model] = entry
        }
        models = order.compactMap { name in
            byModel[name].map { ModelShare(model: name, turns: $0.turns, cost: $0.cost) }
        }
    }

    var promptTokens: Int { input + cache_read + cache_write }
    var totalTokens: Int { promptTokens + output }

    /// Share of all prompt tokens served from cache, 0…1. Nil with no prompt.
    var cacheHitRate: Double? {
        promptTokens > 0 ? Double(cache_read) / Double(promptTokens) : nil
    }

    var saved: Double? {
        guard let cost, let cost_uncached else { return nil }
        return max(0, cost_uncached - cost)
    }

    var averageCost: Double? {
        guard let cost, pricedTurns > 0 else { return nil }
        return cost / Double(pricedTurns)
    }
}

/// How cost and token figures are spelled everywhere they appear, so the
/// per-turn coin and the conversation summary can't disagree on rounding.
enum UsageFormat {
    /// Dollars at a resolution that doesn't round a real cost to "$0.00".
    static func money(_ v: Double) -> String {
        if v == 0 { return "$0" }
        if v < 0.01 { return String(format: "$%.4f", v) }
        return String(format: "$%.2f", v)
    }

    static func tokens(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.2fM", Double(n) / 1_000_000) }
        return n >= 1000 ? String(format: "%.1fk", Double(n) / 1000) : "\(n)"
    }

    static func percent(_ rate: Double) -> String {
        "\(Int((rate * 100).rounded()))%"
    }
}

// MARK: - Structured tool data

/// One tool's structured result for a turn — the raw rows, rendered beside the
/// prose so the user sees ground truth even if the narration drifts.
struct DataBlock: Decodable, Equatable {
    let tool: String
    let data: JSONValue
}

/// A type-erased JSON value, so arbitrary tool payloads decode without a schema.
indirect enum JSONValue: Decodable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case array([JSONValue])
    case object([(key: String, value: JSONValue)])
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let b = try? c.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? c.decode(Double.self) {
            self = .number(n)
        } else if let s = try? c.decode(String.self) {
            self = .string(s)
        } else if let a = try? c.decode([JSONValue].self) {
            self = .array(a)
        } else if let keyed = try? decoder.container(keyedBy: DynamicKey.self) {
            // Preserve key order as decoded so rendered tables read naturally.
            var pairs: [(key: String, value: JSONValue)] = []
            for key in keyed.allKeys {
                pairs.append((key.stringValue, try keyed.decode(JSONValue.self, forKey: key)))
            }
            self = .object(pairs)
        } else {
            self = .null
        }
    }

    static func == (lhs: JSONValue, rhs: JSONValue) -> Bool {
        switch (lhs, rhs) {
        case let (.string(a), .string(b)): return a == b
        case let (.number(a), .number(b)): return a == b
        case let (.bool(a), .bool(b)): return a == b
        case let (.array(a), .array(b)): return a == b
        case let (.object(a), .object(b)):
            return a.count == b.count && zip(a, b).allSatisfy { $0.key == $1.key && $0.value == $1.value }
        case (.null, .null): return true
        default: return false
        }
    }

    private struct DynamicKey: CodingKey {
        var stringValue: String
        var intValue: Int?
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { self.intValue = intValue; self.stringValue = String(intValue) }
    }

    /// A compact one-line scalar rendering (for table cells / values).
    var displayString: String {
        switch self {
        case .string(let s): return s
        case .number(let n): return n == n.rounded() ? String(Int(n)) : String(n)
        case .bool(let b): return b ? "true" : "false"
        case .null: return "—"
        case .array(let a): return "[\(a.count)]"
        case .object: return "{…}"
        }
    }
}

/// Keyed access, for the tool payloads that DO carry a shape.
///
/// Most tool data is rendered by the generic key/value fallback, which needs no
/// schema. A few tools instead return a payload stamped with a `card` kind —
/// those get a purpose-built view, and these accessors are how it reads them.
extension JSONValue {
    subscript(key: String) -> JSONValue? {
        if case .object(let pairs) = self { return pairs.first { $0.key == key }?.value }
        return nil
    }

    var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    var intValue: Int? {
        if case .number(let n) = self { return Int(n) }
        return nil
    }

    var arrayValue: [JSONValue]? {
        if case .array(let a) = self { return a }
        return nil
    }

    /// A string field, or "" — the card views treat absent and empty alike.
    func string(_ key: String) -> String { self[key]?.stringValue ?? "" }

    func int(_ key: String) -> Int { self[key]?.intValue ?? 0 }

    func strings(_ key: String) -> [String] {
        self[key]?.arrayValue?.compactMap { $0.stringValue } ?? []
    }

    /// The discriminator a typed payload carries, e.g. "candidates" or "media".
    var cardKind: String? { self["card"]?.stringValue }
}

// MARK: - API Errors

enum APIError: LocalizedError {
    case requestFailed
    case server(Int, String)

    var errorDescription: String? {
        switch self {
        case .requestFailed: return String(localized: "error.request_failed")
        case .server(let code, let msg): return "[\(code)] \(msg)"
        }
    }
}

private struct ErrorBody: Decodable {
    let error: String
}

/// `{}` — for endpoints that take a POST with nothing to say.
private struct EmptyJSON: Encodable {}

// MARK: - API Response Types

struct LoginResponse: Decodable {
    let user_id: String
    let token: String
}

struct EnrollResponse: Decodable {
    let user_id: String
    let token: String
    let role: String
    let needs_pin: Bool
}

struct OkResponse: Decodable {
    let ok: Bool
}

/// 💬 — a human-only post (no Maurice summon).
struct BubblePost: Encodable {
    let content: String
    let summon: Bool
    let image: String?
}

struct SetupResponse: Decodable {
    let user: ServerUser
    let token: String
}

struct ServerUser: Decodable, Identifiable {
    let id: String
    let display_name: String
    let avatar_color: String
    /// Optional photo avatar path (served from the server); nil → initials.
    let avatar_url: String?
    let has_pin: Bool
    // Admin-only fields (optional)
    let username: String?
    let role: String?
    let profile_text: String?
}

struct ServerConversation: Decodable, Identifiable {
    let id: String
    /// Mutable: a rename updates the cached row in place.
    var title: String?
    /// The specialized Maurice this conversation uses; nil = everyday Maurice.
    let maurice_id: String?
    /// Provenance; nil = native, "anthropic" = imported from a Claude.ai export.
    let origin: String?
    /// Who opened it: "member" (the default), or "maurice" — a conversation
    /// Maurice opened on his own, with a first message of his.
    let opened_by: String?
    /// List rows only: a conversation Maurice opened that you have not opened
    /// yet — the unread dot on a cold start, before any socket event.
    let unread: Bool?
    let created_at: String
    let updated_at: String
    let message_count: Int?
    let last_message_at: String?
    /// The room's members — drives the sidebar avatar stack (multi-user only).
    let participants: [ServerParticipant]?

    var openedByMaurice: Bool { opened_by == "maurice" }
}

/// What PATCH /api/conversations/:id answers — only the fields a rename needs.
struct RenamedConversation: Decodable {
    let id: String
    let title: String?
}

/// One hit from /api/conversations/search — the room, plus the passage that
/// matched. The server wraps the matched words in ⟦ ⟧; `snippet` keeps them.
struct ConversationSearchHit: Decodable, Identifiable {
    let conversation: ServerConversation
    let snippet: String
    let message_id: String?
    let hits: Int
    var id: String { conversation.id }
}

struct ConversationSearchResponse: Decodable {
    let q: String
    let results: [ConversationSearchHit]
}

// MARK: - Domain proposals (the drawer "Define my domains", P2-D)

/// One proposal of the night, as GET /api/domains/proposals lists it: the
/// name and paragraph the night wrote, its conversations, its weight on five
/// dots relative to the biggest, its share of the member's conversations,
/// how many were recent, one line of the summary, and its state.
struct DomainProposal: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let summary: String
    let one_line: String?
    let state: String
    let verdict: String?
    let conversations: Int
    let weight: Int
    let share: Int
    let recent_90_days: Int?
    let split_hint: String?
    let from: String?
    let to: String?
    let conversation_id: String?
    let domain_id: String?

    var isAlive: Bool { verdict != "lived" }
    var isOpen: Bool { state == "proposed" }
}

struct DomainProposalsResponse: Decodable {
    let conversation_id: String?
    let total_conversations: Int
    let proposals: [DomainProposal]
    let settled: [DomainProposal]?
}

/// One line of the drawer's validation (POST /api/domains/proposals/apply).
struct DomainProposalApplyItem: Encodable {
    let id: String
    /// "adopt", "dismiss" or "keep" (rename only).
    let action: String
    let name: String?
    let summary: String?
    let seed: Bool
}

struct DomainProposalApplyResult: Decodable {
    struct Adopted: Decodable { let id: String; let name: String; let domain_id: String; let conversations_bound: Int; let seeding: Bool }
    struct Named: Decodable { let id: String; let name: String }
    struct Failed: Decodable { let id: String; let error: String }
    let adopted: [Adopted]
    let dismissed: [Named]
    let renamed: [Named]
    let errors: [Failed]
    let message_id: String?
    let conversation_id: String?
}

struct ServerConversationDetail: Decodable {
    let id: String
    let title: String?
    let maurice_id: String?
    let created_at: String
    let updated_at: String
    let messages: [ServerMessage]
    let participants: [ServerParticipant]?
}

struct ServerMessage: Decodable, Identifiable {
    let id: String
    let role: String
    let content: String
    let model: String?
    /// The human who authored this turn (nil for Maurice / system).
    let author_id: String?
    /// Structured tool results for this turn, rendered beside the prose. Nil for
    /// human turns and assistant turns that called no data-returning tools.
    let data: [DataBlock]?
    /// What this turn cost. Nil for human turns, for local models before the
    /// server started recording, and for providers that report no usage.
    let usage: TurnUsage?
    let created_at: String

    init(id: String, role: String, content: String, model: String?, author_id: String? = nil, data: [DataBlock]? = nil, usage: TurnUsage? = nil, created_at: String) {
        self.id = id
        self.role = role
        self.content = content
        self.model = model
        self.author_id = author_id
        self.data = data
        self.usage = usage
        self.created_at = created_at
    }
}

/// A member of a room. The server includes display info so message rows can be
/// rendered by author without a separate roster lookup.
struct ServerParticipant: Decodable, Identifiable {
    let member_id: String
    let role: String
    let username: String?
    let display_name: String
    let avatar_color: String
    /// Optional photo avatar path (served from the server); nil → initials.
    let avatar_url: String?

    var id: String { member_id }
    var color: Color { Color(hex: avatar_color) }
    var initial: String { String(display_name.prefix(1)) }

    init(member_id: String, role: String, username: String?, display_name: String,
         avatar_color: String, avatar_url: String? = nil) {
        self.member_id = member_id
        self.role = role
        self.username = username
        self.display_name = display_name
        self.avatar_color = avatar_color
        self.avatar_url = avatar_url
    }
}

struct ServerPreferences: Codable {
    var theme: String?
    var palette: String?
    var locale: String?
}

struct HealthResponse: Decodable {
    let status: String
    let version: String
    let setup_complete: Bool
    let household: String?
    let household_color: String?
    let household_icon: String?
}

struct UnreadResponse: Decodable {
    let unread: Int
}

struct McpTokenResponse: Decodable {
    let rawToken: String
}

// MARK: - Server Date Parsing

/// Parse a timestamp string as returned by the Maurice server.
///
/// The server stores timestamps via SQLite `datetime('now')`, which yields a
/// naive UTC string like `2026-05-29 15:39:43` (space-separated, no timezone
/// marker). It may also send ISO8601 (`...T...Z`) in some paths. We parse all
/// forms as **UTC** so the client doesn't mistake them for local time.
func parseServerDate(_ s: String) -> Date? {
    // ISO8601 with timezone (e.g. trailing Z) — unambiguous.
    let iso = ISO8601DateFormatter()
    if let d = iso.date(from: s) { return d }

    // Naive formats: assume UTC explicitly.
    let formats = ["yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd'T'HH:mm:ss"]
    let fmt = DateFormatter()
    fmt.locale = Locale(identifier: "en_US_POSIX")
    fmt.timeZone = TimeZone(identifier: "UTC")
    for f in formats {
        fmt.dateFormat = f
        if let d = fmt.date(from: s) { return d }
    }
    return nil
}
