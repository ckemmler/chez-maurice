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
                    guard let http = response as? HTTPURLResponse,
                          (200...299).contains(http.statusCode) else {
                        continuation.finish(throwing: APIError.requestFailed)
                        return
                    }

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
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
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

    enum EventType: String, Decodable {
        case text_delta
        case done
        case error
        case image
        case image_loading
        case tool_call
        case tool_data
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
    let title: String?
    /// The specialized Maurice this conversation uses; nil = everyday Maurice.
    let maurice_id: String?
    /// Provenance; nil = native, "anthropic" = imported from a Claude.ai export.
    let origin: String?
    let created_at: String
    let updated_at: String
    let message_count: Int?
    let last_message_at: String?
    /// The room's members — drives the sidebar avatar stack (multi-user only).
    let participants: [ServerParticipant]?
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
    let created_at: String

    init(id: String, role: String, content: String, model: String?, author_id: String? = nil, data: [DataBlock]? = nil, created_at: String) {
        self.id = id
        self.role = role
        self.content = content
        self.model = model
        self.author_id = author_id
        self.data = data
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
