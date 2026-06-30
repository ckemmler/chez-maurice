import SwiftUI

// MARK: - Specialized Maurices (personas)
//
// Client model + store for the household's specialized Maurices. The server
// owns persistence (/api/maurices) and the model roster (/api/models); this
// store loads them, exposes CRUD, and resolves a conversation's bound Maurice.
// Context items reuse the composer's `TrayItem` shape — a persona's baked-in
// bundle is the same kind of context the composer assembles per-conversation.

/// A specialized Maurice. `rawId == nil` is the everyday, unspecialized Maurice.
struct Maurice: Identifiable, Equatable {
    var rawId: String?
    var name: String
    var hat: String = "boater"
    var palette: String = "ink"
    var model: String?
    var temp: Double = 0.5
    var tagline: String = ""
    var prompt: String = ""
    /// member ids allowed to use this Maurice
    var users: [String] = []
    /// the baked-in context bundle (frozen spec items, as composer chips)
    var contextItems: [TrayItem] = []
    var weight: Int = 0
    var count: Int = 0
    /// allowed tool family ids; nil = inherit (all on cloud, none on-device)
    var toolFamilies: [String]? = nil

    var id: String { rawId ?? "__everyday__" }
    var isEveryday: Bool { rawId == nil }
    var paletteValue: HatPalette { HatPalette.by(palette) }

    /// The everyday Maurice — conversations with no chosen persona resolve to it.
    static let everyday = Maurice(
        rawId: nil, name: "Maurice", hat: "boater", palette: "ink",
        model: nil, temp: 0.5, tagline: "Your everyday Maurice.", prompt: "",
        users: [], contextItems: [], weight: 0, count: 0
    )

    /// A blank draft for the creator's "new" state.
    static func blank() -> Maurice {
        Maurice(rawId: nil, name: "", hat: "boater", palette: "ink",
                model: nil, temp: 0.5, tagline: "", prompt: "", users: [],
                contextItems: [], weight: 0, count: 0)
    }

    static func parse(_ d: [String: Any]) -> Maurice? {
        guard let id = d["id"] as? String, let name = d["name"] as? String else { return nil }
        let ctx = (d["context"] as? [[String: Any]] ?? []).compactMap { ComposerStore.itemFromSpec($0) }
        return Maurice(
            rawId: id,
            name: name,
            hat: d["hat"] as? String ?? "boater",
            palette: d["palette"] as? String ?? "ink",
            model: d["model"] as? String,
            temp: (d["temp"] as? NSNumber)?.doubleValue ?? 0.5,
            tagline: d["tagline"] as? String ?? "",
            prompt: d["prompt"] as? String ?? "",
            users: d["users"] as? [String] ?? [],
            contextItems: ctx,
            weight: d["weight"] as? Int ?? 0,
            count: d["count"] as? Int ?? 0,
            toolFamilies: d["tool_families"] as? [String]
        )
    }
}

/// A tool family (an MCP server group) the apps can expose to a Maurice.
struct ToolFamily: Identifiable, Equatable {
    let id: String
    let title: String
    let icon: String
    let blurb: String
    let count: Int
    let group: String     // "core" | "garden" | "experimental"
    let alwaysOn: Bool    // core families: always active, not user-toggleable
}

/// A model in the available roster (currently the single household default).
struct MauriceModel: Identifiable, Equatable {
    let id: String
    let name: String
    let tier: String   // "cloud" | "local"
    let provider: String // anthropic | openai | mistral | ollama
    let sub: String
    let desc: String
    let note: String
    let available: Bool

    var isLocal: Bool { tier == "local" }
}

@Observable @MainActor
final class MauriceStore {
    let session: SessionStore

    var maurices: [Maurice] = []
    var models: [MauriceModel] = []
    /// The household default model id — the fallback when nothing more specific
    /// is set (the roster's first entry is the "best" model, not the default).
    var defaultModelId: String?
    /// This member's chosen model for the everyday Maurice (nil = use the
    /// household default). Per-member: foyer-mates can each run a different LLM.
    var everydayModelId: String?
    /// Tool families (MCP server groups) a Maurice can be scoped to.
    var families: [ToolFamily] = []
    var error: String?

    init(session: SessionStore) { self.session = session }

    private var base: String? { session.serverURL }
    private var token: String? { session.tokenForActiveUser }

    // MARK: resolution helpers

    /// The Maurice for a conversation's binding (everyday for nil/unknown).
    func maurice(for id: String?) -> Maurice {
        guard let id else { return .everyday }
        return maurices.first { $0.rawId == id } ?? .everyday
    }

    /// Maurices the active user may use. Custom Maurices are private to their
    /// creator, so the server already scopes the list to this member.
    var usableMaurices: [Maurice] { maurices }

    func model(for id: String?) -> MauriceModel? {
        // No explicit model → the household default, which is what the server
        // resolves to; fall back to the first roster entry.
        guard let target = id ?? defaultModelId else { return models.first }
        return models.first { $0.id == target } ?? models.first
    }

    /// The model id a Maurice actually runs, mirroring the server: an explicit
    /// persona preference, else (for the everyday Maurice) this member's everyday
    /// choice, else the household default.
    func resolvedModelId(for m: Maurice) -> String? {
        if let explicit = m.model { return explicit }
        if m.isEveryday { return everydayModelId ?? defaultModelId }
        return defaultModelId
    }

    /// The resolved model for a Maurice (for the composer pill + the picker tick).
    func resolvedModel(for m: Maurice) -> MauriceModel? {
        model(for: resolvedModelId(for: m))
    }

    /// Display name for a Maurice's model (falls back to the default model name).
    func modelName(for m: Maurice) -> String {
        resolvedModel(for: m)?.name ?? models.first?.name ?? "Default model"
    }

    // MARK: loading

    func load() async {
        await loadMaurices()
        await loadModels()
        await loadEverydayModel()
        await loadFamilies()
    }

    func loadEverydayModel() async {
        guard let json = await request("GET", "/api/models/everyday") as? [String: Any] else { return }
        everydayModelId = json["id"] as? String
    }

    /// Switch a Maurice's model — persists and applies to this and subsequent
    /// chats. The everyday Maurice stores it per-member; a persona stores it on
    /// the persona itself. No-op if the roster lacks the model.
    func setModel(_ modelId: String, for m: Maurice) async {
        if m.isEveryday {
            guard let json = await request("PUT", "/api/models/everyday", body: ["id": modelId]) as? [String: Any]
            else { return }
            everydayModelId = json["id"] as? String
        } else if let rawId = m.rawId {
            guard let json = await request("PATCH", "/api/maurices/\(rawId)", body: ["model": modelId]) as? [String: Any],
                  let saved = Maurice.parse(json) else { return }
            if let i = maurices.firstIndex(where: { $0.rawId == saved.rawId }) { maurices[i] = saved }
        }
    }

    func loadFamilies() async {
        guard let arr = await request("GET", "/api/tool-families") as? [[String: Any]] else { return }
        families = arr.compactMap { d in
            guard let id = d["id"] as? String, let title = d["title"] as? String else { return nil }
            return ToolFamily(
                id: id, title: title,
                icon: d["icon"] as? String ?? "wrench.and.screwdriver",
                blurb: d["blurb"] as? String ?? "",
                count: d["count"] as? Int ?? 0,
                group: d["group"] as? String ?? "experimental",
                alwaysOn: d["alwaysOn"] as? Bool ?? false
            )
        }
    }

    func loadMaurices() async {
        guard let arr = await request("GET", "/api/maurices") as? [[String: Any]] else { return }
        maurices = arr.compactMap { Maurice.parse($0) }
    }

    func loadModels() async {
        guard let arr = await request("GET", "/api/models") as? [[String: Any]] else { return }
        defaultModelId = arr.first { ($0["is_default"] as? Bool) == true }?["id"] as? String
        models = arr.compactMap { d in
            guard let id = d["id"] as? String, let name = d["name"] as? String else { return nil }
            return MauriceModel(
                id: id, name: name,
                tier: d["tier"] as? String ?? "cloud",
                provider: d["provider"] as? String ?? "anthropic",
                sub: d["sub"] as? String ?? "",
                desc: d["desc"] as? String ?? "",
                note: d["note"] as? String ?? "",
                available: d["available"] as? Bool ?? true
            )
        }
    }

    // MARK: CRUD

    @discardableResult
    func save(_ draft: Maurice) async -> Maurice? {
        let body = Self.body(from: draft)
        let isEdit = draft.rawId != nil
        let path = isEdit ? "/api/maurices/\(draft.rawId!)" : "/api/maurices"
        guard let json = await request(isEdit ? "PATCH" : "POST", path, body: body) as? [String: Any],
              let saved = Maurice.parse(json) else { return nil }
        if let i = maurices.firstIndex(where: { $0.rawId == saved.rawId }) {
            maurices[i] = saved
        } else {
            maurices.append(saved)
        }
        maurices.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        return saved
    }

    func delete(_ id: String) async {
        _ = await request("DELETE", "/api/maurices/\(id)")
        maurices.removeAll { $0.rawId == id }
    }

    private static func body(from m: Maurice) -> [String: Any] {
        [
            "name": m.name,
            "hat": m.hat,
            "palette": m.palette,
            "model": m.model as Any,
            "temp": m.temp,
            "tagline": m.tagline,
            "prompt": m.prompt,
            "context": m.contextItems.map { $0.payload() },
            "tool_families": m.toolFamilies ?? NSNull(),
        ]
    }

    // MARK: networking

    private func request(_ method: String, _ path: String, body: [String: Any]? = nil) async -> Any? {
        guard let base, let token, let url = URL(string: base + path) else { return nil }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body { req.httpBody = try? JSONSerialization.data(withJSONObject: body) }
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }
}
