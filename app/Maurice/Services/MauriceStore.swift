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
    /// For a model that reasons optionally: nil = the provider's own default,
    /// true = think before answering, false = answer directly. The server
    /// ignores it on any other model.
    var thinking: Bool? = nil
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
    /// Maurice Maurice, the built-in specialist of Maurice: on everyone's list,
    /// not editable, and his model is the server's choice — never switchable.
    var builtin: Bool = false
    /// The member who made this Maurice. Seen from the other side, a Maurice
    /// is a *domain* of that member's life, with a brief Maurice keeps on it;
    /// the brief is the creator's alone (a persona shared with a guest is
    /// still the creator's domain).
    var createdBy: String? = nil

    var id: String { rawId ?? "__everyday__" }
    var isEveryday: Bool { rawId == nil }
    /// Whether the member may edit this Maurice at all (not the everyday one,
    /// not the built-in one).
    var isEditable: Bool { !isEveryday && !builtin }
    /// Whether this Maurice is a domain of the given member: theirs, hence with
    /// a brief they can read, correct and erase.
    func isDomain(of memberId: String?) -> Bool {
        isEditable && createdBy != nil && createdBy == memberId
    }
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
            thinking: d["thinking"] as? Bool,
            tagline: d["tagline"] as? String ?? "",
            prompt: d["prompt"] as? String ?? "",
            users: d["users"] as? [String] ?? [],
            contextItems: ctx,
            weight: d["weight"] as? Int ?? 0,
            count: d["count"] as? Int ?? 0,
            toolFamilies: d["tool_families"] as? [String],
            builtin: d["builtin"] as? Bool ?? false,
            createdBy: d["created_by"] as? String
        )
    }
}

/// The brief Maurice keeps on a domain: his working memory on that part of the
/// member's life, made visible. Written at night (or on demand) from the
/// domain's conversations; read in every conversation the member has alone
/// with Maurice; corrected or erased by the member in the app.
struct DomainBrief: Equatable {
    var text: String
    /// Server time, "YYYY-MM-DD HH:MM:SS" (UTC) — parse with `parseServerDate`.
    var updatedAt: String
    /// The conversations the last rewrite read.
    var sources: [String]
    /// The model that wrote it, or "member" when the member did.
    var model: String?

    /// The member rewrote this brief by hand; their wording prevails.
    var byMember: Bool { model == "member" }

    static func parse(_ d: [String: Any]) -> DomainBrief? {
        guard let text = d["text"] as? String, let updatedAt = d["updated_at"] as? String else { return nil }
        return DomainBrief(text: text, updatedAt: updatedAt, sources: d["sources"] as? [String] ?? [], model: d["model"] as? String)
    }
}

/// What a rewrite-now answered (POST /api/domains/:id/brief/refresh).
enum BriefRefreshOutcome: Equatable {
    /// Rewritten from that many conversations.
    case written(sources: Int)
    /// Nothing new since the last brief: no model call was made.
    case unchanged
    /// The night's allowance is spent for today.
    case capped
    /// The model call failed, or the server could not be reached.
    case failed(String)
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
    let provider: String // anthropic | openai | mistral | zai | scaleway | ollama
    let sub: String
    let desc: String
    let note: String
    let available: Bool
    /// "none" | "optional" | "always" — the persona editor offers the
    /// reasoning switch only on "optional".
    let thinking: String

    var isLocal: Bool { tier == "local" }
    var thinkingIsOptional: Bool { thinking == "optional" }
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
        if m.builtin { return } // Maurice Maurice's model is the server's, locked.
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
                available: d["available"] as? Bool ?? true,
                thinking: d["thinking"] as? String ?? "none"
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

    // MARK: domain briefs

    /// The brief on a domain, or nil when the night has not written one yet
    /// (or the domain is not this member's). `found` tells the two apart.
    func loadBrief(_ domainId: String) async -> (found: Bool, brief: DomainBrief?) {
        let (status, json) = await requestStatus("GET", "/api/domains/\(domainId)/brief")
        guard status == 200, let d = json as? [String: Any] else { return (false, nil) }
        return (true, (d["brief"] as? [String: Any]).flatMap(DomainBrief.parse))
    }

    /// The member's correction: what Maurice reads from the next turn on, and
    /// what the next night starts from. An empty text erases the brief.
    func saveBrief(_ domainId: String, text: String) async -> (ok: Bool, brief: DomainBrief?) {
        let (status, json) = await requestStatus("PUT", "/api/domains/\(domainId)/brief", body: ["text": text])
        guard status == 200, let d = json as? [String: Any] else { return (false, nil) }
        return (true, (d["brief"] as? [String: Any]).flatMap(DomainBrief.parse))
    }

    @discardableResult
    func deleteBrief(_ domainId: String) async -> Bool {
        let (status, _) = await requestStatus("DELETE", "/api/domains/\(domainId)/brief")
        return status == 200
    }

    /// Rewrite the brief now. Seconds: one model call on the night's model,
    /// against the night's allowance.
    func refreshBrief(_ domainId: String) async -> (outcome: BriefRefreshOutcome, brief: DomainBrief?) {
        let (status, json) = await requestStatus("POST", "/api/domains/\(domainId)/brief/refresh")
        let d = json as? [String: Any] ?? [:]
        let brief = (d["brief"] as? [String: Any]).flatMap(DomainBrief.parse)
        let error = d["error"] as? String ?? ""
        switch (status, d["outcome"] as? String) {
        case (200, "written"): return (.written(sources: d["sources"] as? Int ?? 0), brief)
        case (200, "unchanged"): return (.unchanged, brief)
        case (429, _): return (.capped, brief)
        case (502, _): return (.failed(error), brief)
        default: return (.failed(error.isEmpty ? "HTTP \(status)" : error), brief)
        }
    }

    private static func body(from m: Maurice) -> [String: Any] {
        [
            "name": m.name,
            "hat": m.hat,
            "palette": m.palette,
            "model": m.model as Any,
            "temp": m.temp,
            "thinking": m.thinking ?? NSNull(),
            "tagline": m.tagline,
            "prompt": m.prompt,
            "context": m.contextItems.map { $0.payload() },
            "tool_families": m.toolFamilies ?? NSNull(),
        ]
    }

    // MARK: networking

    private func request(_ method: String, _ path: String, body: [String: Any]? = nil) async -> Any? {
        let (status, json) = await requestStatus(method, path, body: body)
        return (200..<300).contains(status) ? json : nil
    }

    /// The status and the JSON body whatever the status (0 when the request
    /// never reached the server) — for routes whose error status carries a
    /// message, like the brief's rewrite.
    private func requestStatus(_ method: String, _ path: String, body: [String: Any]? = nil) async -> (Int, Any?) {
        guard let base, let token, let url = URL(string: base + path) else { return (0, nil) }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body { req.httpBody = try? JSONSerialization.data(withJSONObject: body) }
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              let http = resp as? HTTPURLResponse else { return (0, nil) }
        return (http.statusCode, try? JSONSerialization.jsonObject(with: data))
    }
}
