import Foundation
import Observation

/// A provider outside the house that a member's data can reach, as
/// GET /api/me/ai-consent names it.
struct AIProvider: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    /// ISO region code of where it processes, and a city when known.
    let region: String?
    let city: String?

    /// "Paris, France" in the reader's language, or nil when unknown.
    var place: String? {
        let country = region.flatMap { Locale.current.localizedString(forRegionCode: $0) }
        switch (city, country) {
        case let (city?, country?): return "\(city), \(country)"
        case let (nil, country?): return country
        case let (city?, nil): return city
        default: return nil
        }
    }
}

struct AIConsentRecord: Decodable, Equatable {
    let status: String
    let providers: [String]
    let decided_at: String

    var decidedAt: Date? { parseServerDate(decided_at) }
}

struct AIConsentState: Decodable {
    let record: AIConsentRecord?
    let providers: [AIProvider]
    let needs_answer: Bool
    let uncovered: [String]
}

/// Consent to send what the member gives Maurice to AI providers (App Review
/// 5.1.2(i)). The server holds the answer and the rule
/// (server/src/services/aiConsent.ts); the app asks before anything is sent,
/// shows the answer in Settings → My data, and keeps the composer quiet while
/// the answer is no. A server from before the route has no record of its own:
/// the answer is then kept on this device, per server, member and set of
/// providers, read from /api/models.
@Observable @MainActor
final class AIConsentStore {
    private(set) var state: AIConsentState?
    /// Whether the last refresh reached the server at all.
    private(set) var loaded = false
    /// The member asked to see the question again (the composer's banner,
    /// Settings → My data): the consent screen is shown until they answer.
    var reviewing = false
    /// Whether the consent screen is up.
    var showsQuestion: Bool { needsAnswer || reviewing }

    private var fallbackKey: String?

    var record: AIConsentRecord? { state?.record }
    var providers: [AIProvider] { state?.providers ?? [] }
    var declined: Bool { record?.status == "declined" }
    var needsAnswer: Bool { loaded && state?.needs_answer == true }
    /// Providers that appeared since the member's last yes.
    var newProviders: [AIProvider] {
        guard let state else { return [] }
        return state.providers.filter { state.uncovered.contains($0.id) }
    }

    /// May Maurice be asked anything? Yes with no provider outside the house
    /// (a household on local models), or once every provider in use is accepted.
    var mayUseAI: Bool {
        guard loaded, let state else { return false }
        if state.providers.isEmpty { return true }
        return record?.status == "accepted" && !state.needs_answer
    }

    func covers(_ provider: String) -> Bool {
        provider == "ollama" || (record?.status == "accepted" && record?.providers.contains(provider) == true)
    }

    func refresh(_ session: SessionStore) async {
        guard let server = session.serverURL, let token = session.tokenForActiveUser,
              let userId = session.activeUserId else {
            state = nil; loaded = false
            return
        }
        let api = APIClient(baseURL: server)
        do {
            let s: AIConsentState = try await api.get("/api/me/ai-consent", token: token)
            fallbackKey = nil
            state = s
            loaded = true
        } catch APIError.server(404, _) {
            await refreshFromModels(api: api, token: token, key: "\(server)|\(userId)")
        } catch {
            // Unreachable: keep what we had; never treat silence as a yes.
        }
    }

    /// Accept (every provider shown, plus any already accepted) or decline.
    func decide(accept: Bool, session: SessionStore) async {
        let ids = Set(providers.map(\.id)).union(record?.providers ?? [])
        await put(status: accept ? "accepted" : "declined", providers: Array(ids).sorted(), session: session)
        reviewing = false
    }

    /// Add one provider to an existing yes — the persona editor's question.
    func accept(_ provider: AIProvider, session: SessionStore) async {
        var ids = Set(record?.status == "accepted" ? record!.providers : [])
        ids.insert(provider.id)
        await put(status: "accepted", providers: Array(ids).sorted(), session: session)
    }

    private struct Body: Encodable { let status: String; let providers: [String] }

    private func put(status: String, providers ids: [String], session: SessionStore) async {
        if let key = fallbackKey {
            let rec = AIConsentRecord(status: status, providers: status == "accepted" ? ids : [],
                                      decided_at: ISO8601DateFormatter().string(from: Date()))
            if let data = try? JSONEncoder().encode(StoredRecord(rec)) {
                UserDefaults.standard.set(data, forKey: key)
            }
            state = AIConsentState(record: rec, providers: providers,
                                   needs_answer: status == "accepted" && !Set(providers.map(\.id)).isSubset(of: Set(ids)),
                                   uncovered: [])
            return
        }
        guard let server = session.serverURL, let token = session.tokenForActiveUser else { return }
        if let s: AIConsentState = try? await APIClient(baseURL: server)
            .put("/api/me/ai-consent", body: Body(status: status, providers: ids), token: token) {
            state = s
            loaded = true
        }
    }

    // MARK: - Servers from before the route

    private struct StoredRecord: Codable {
        let status: String; let providers: [String]; let decided_at: String
        init(_ r: AIConsentRecord) { status = r.status; providers = r.providers; decided_at = r.decided_at }
    }
    private struct RosterModel: Decodable { let provider: String; let tier: String; let available: Bool? }

    private func refreshFromModels(api: APIClient, token: String, key: String) async {
        guard let models: [RosterModel] = try? await api.get("/api/models", token: token) else { return }
        let ids = Set(models.filter { $0.tier != "local" && $0.provider != "ollama" && $0.available != false }.map(\.provider))
        let list = ids.sorted().map { Self.knownProvider($0) }
        let storeKey = "maurice.ai_consent.\(key)"
        fallbackKey = storeKey
        var record: AIConsentRecord?
        if let data = UserDefaults.standard.data(forKey: storeKey),
           let s = try? JSONDecoder().decode(StoredRecord.self, from: data) {
            record = AIConsentRecord(status: s.status, providers: s.providers, decided_at: s.decided_at)
        }
        let missing = record?.status == "accepted" ? ids.subtracting(record!.providers) : []
        state = AIConsentState(record: record, providers: list,
                               needs_answer: record == nil || !missing.isEmpty,
                               uncovered: Array(missing))
        loaded = true
    }

    /// The same names the server gives (services/aiConsent.ts), for a server
    /// that does not give them.
    static func knownProvider(_ id: String) -> AIProvider {
        switch id {
        case "scaleway": return AIProvider(id: id, name: "Scaleway Generative APIs", region: "FR", city: "Paris")
        case "mistral": return AIProvider(id: id, name: "Mistral AI", region: "FR", city: "Paris")
        case "anthropic": return AIProvider(id: id, name: "Anthropic", region: "US", city: nil)
        case "openai": return AIProvider(id: id, name: "OpenAI", region: "US", city: nil)
        case "gemini": return AIProvider(id: id, name: "Google Gemini", region: "US", city: nil)
        case "zai": return AIProvider(id: id, name: "Z.ai (Zhipu AI)", region: "CN", city: nil)
        default: return AIProvider(id: id, name: id, region: nil, city: nil)
        }
    }
}
