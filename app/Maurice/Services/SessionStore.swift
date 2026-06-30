import Foundation
import SwiftUI

// MARK: - Global localization

/// The active user's chosen language base (e.g. "en", "fr"), read from the same
/// store SessionStore persists to, falling back to the system language.
private func appLocaleBase() -> String {
    let uid = UserDefaults.standard.string(forKey: "maurice.activeUserId")
    let id = uid.flatMap { UserDefaults.standard.string(forKey: "maurice.prefs.\($0).locale") }
    let lang = id ?? Locale.preferredLanguages.first ?? "en"
    return lang.components(separatedBy: "-").first ?? lang
}

/// View-independent localized string — usable anywhere (enums, static arrays,
/// free functions), unlike `session.localized` which needs a SessionStore.
/// Resolves against the app's chosen locale, not the system one.
func L(_ key: String, _ args: CVarArg...) -> String {
    let base = appLocaleBase()
    let bundle = Bundle.main.path(forResource: base, ofType: "lproj").flatMap(Bundle.init(path:)) ?? .main
    let fmt = bundle.localizedString(forKey: key, value: nil, table: nil)
    return args.isEmpty ? fmt : String(format: fmt, arguments: args)
}

// MARK: - Session Store

/// Persists server connection info and per-user session tokens.
/// Uses UserDefaults for server config and Keychain for tokens.
/// A household this device belongs to — a paired server + the users enrolled
/// there + which one is active. The device can hold several at once.
struct Household: Codable, Identifiable, Hashable {
    let id: String          // device-local id (also the push routing tag)
    var serverURL: String
    var name: String
    /// Foyer identity from the server (/api/health) — nil falls back to derived.
    var color: String? = nil
    var icon: String? = nil
    var deviceUsers: [DeviceUser]
    var activeUserId: String?
    /// Unread rooms for the active user here (from /api/users/me/unread).
    /// Optional so older persisted households still decode.
    var unread: Int? = nil
}

@Observable
final class SessionStore {
    /// Every household paired on this device.
    var households: [Household] = [] { didSet { saveHouseholds() } }
    /// Which household is currently being viewed.
    var currentHouseholdId: String? {
        didSet {
            UserDefaults.standard.set(currentHouseholdId, forKey: "maurice.currentHousehold")
            syncActiveUserMirror()
        }
    }
    var deviceId: String? {
        didSet { UserDefaults.standard.set(deviceId, forKey: "maurice.deviceId") }
    }

    /// Per-user locale override (nil = system default) — for the active user.
    var localeIdentifier: String? { didSet { saveLocalPrefs() } }
    /// Per-user visual preference — for the active user.
    var palette: String = "auto" { didSet { saveLocalPrefs() } }
    /// Web theme id for the member's digital garden (themes/<id> on the web).
    /// "default" is the hidden base; gardens default to a real garden theme.
    var webTheme: String = "manuscript" { didSet { saveLocalPrefs() } }

    // MARK: Current-household projections
    // The rest of the app reads serverURL / activeUserId / deviceUsers; those are
    // now views onto the current household, so multi-household stays internal.

    private var currentIndex: Int? { households.firstIndex { $0.id == currentHouseholdId } }
    var currentHousehold: Household? { currentIndex.map { households[$0] } }
    private func mutateCurrent(_ f: (inout Household) -> Void) {
        guard let i = currentIndex else { return }
        f(&households[i])
    }

    var serverURL: String? { currentHousehold?.serverURL }
    /// Host of the current server (used to key the per-server connect disclosure).
    var serverHost: String? {
        guard let s = serverURL, let u = URL(string: s) else { return nil }
        return u.host
    }
    var activeUserId: String? {
        get { currentHousehold?.activeUserId }
        set { mutateCurrent { $0.activeUserId = newValue }; syncActiveUserMirror() }
    }
    var deviceUsers: [DeviceUser] {
        get { currentHousehold?.deviceUsers ?? [] }
        set { mutateCurrent { $0.deviceUsers = newValue } }
    }

    var isPaired: Bool { currentHousehold != nil }
    var hasActiveSession: Bool { activeUserId != nil && tokenForActiveUser != nil }
    var tokenForActiveUser: String? { activeUserId.flatMap { tokenForUser($0) } }
    var activeDeviceUser: DeviceUser? {
        guard let uid = activeUserId else { return nil }
        return deviceUsers.first { $0.id == uid }
    }
    /// A guest device is locked to its single account — no switching/sign-out.
    var activeIsGuest: Bool { activeDeviceUser?.role == "guest" }

    var resolvedLocale: Locale {
        if let id = localeIdentifier { return Locale(identifier: id) }
        return .current
    }

    /// Resolve a localized string using the app's chosen locale, not the system locale.
    func localized(_ key: String, _ args: CVarArg...) -> String {
        let lang = localeIdentifier ?? Locale.preferredLanguages.first ?? "en"
        let base = lang.components(separatedBy: "-").first ?? lang
        let fmt: String
        if let path = Bundle.main.path(forResource: base, ofType: "lproj"),
           let bundle = Bundle(path: path) {
            fmt = bundle.localizedString(forKey: key, value: nil, table: nil)
        } else {
            fmt = NSLocalizedString(key, comment: "")
        }
        // No args → return the raw string. Running String(format:) on a string
        // that contains a specifier (e.g. "%@") with zero arguments otherwise
        // yields "(null)" (older OS) or a noisy format-mismatch error string.
        return args.isEmpty ? fmt : String(format: fmt, arguments: args)
    }

    init() {
        deviceId = UserDefaults.standard.string(forKey: "maurice.deviceId")
        loadHouseholds()
        migrateLegacyIfNeeded()
        currentHouseholdId = UserDefaults.standard.string(forKey: "maurice.currentHousehold") ?? households.first?.id
        loadLocalPrefs()
        syncActiveUserMirror()
    }

    // MARK: - Households

    /// Pair (or re-select) a household by server URL; returns its local id.
    @discardableResult
    func pair(serverURL: String, name: String? = nil, color: String? = nil, icon: String? = nil, deviceId: String? = nil) -> String {
        if let dev = deviceId { self.deviceId = dev }
        if let existing = households.first(where: { $0.serverURL == serverURL }) {
            currentHouseholdId = existing.id
            updateHousehold(id: existing.id) {
                if color != nil { $0.color = color }
                if icon != nil { $0.icon = icon }
            }
            loadLocalPrefs()
            return existing.id
        }
        let resolvedName = (name?.isEmpty == false) ? name! : Self.defaultName(serverURL)
        let h = Household(id: UUID().uuidString, serverURL: serverURL,
                          name: resolvedName, color: color, icon: icon, deviceUsers: [], activeUserId: nil)
        households.append(h)
        currentHouseholdId = h.id
        loadLocalPrefs()
        return h.id
    }

    /// Mutate one household by id (persists + notifies observers).
    func updateHousehold(id: String, _ f: (inout Household) -> Void) {
        guard let i = households.firstIndex(where: { $0.id == id }) else { return }
        f(&households[i])
    }

    /// Refresh every foyer's identity (name/colour/icon via /api/health) and the
    /// active user's unread count (authed) — for the switcher badges. Runs all
    /// foyers concurrently with a short timeout; safe to fire-and-forget so it
    /// never blocks a household switch.
    func refreshFoyers() async {
        struct FoyerUpdate { let id: String; let health: HealthResponse?; let unread: Int? }
        let snapshot = households.map { (id: $0.id, url: $0.serverURL, bearer: token(for: $0)) }
        let updates = await withTaskGroup(of: FoyerUpdate.self) { group in
            for f in snapshot {
                group.addTask {
                    let api = APIClient(baseURL: f.url)
                    let health: HealthResponse? = try? await api.get("/api/health", timeout: 8)
                    var unread: Int? = nil
                    if let bearer = f.bearer {
                        let r: UnreadResponse? = try? await api.get("/api/users/me/unread", token: bearer, timeout: 8)
                        unread = r?.unread
                    }
                    return FoyerUpdate(id: f.id, health: health, unread: unread)
                }
            }
            var out: [FoyerUpdate] = []
            for await u in group { out.append(u) }
            return out
        }
        for u in updates {
            updateHousehold(id: u.id) {
                if let h = u.health {
                    if let n = h.household, !n.isEmpty { $0.name = n }
                    $0.color = h.household_color
                    $0.icon = h.household_icon
                }
                if let unread = u.unread { $0.unread = unread }
            }
        }
    }

    func switchHousehold(_ id: String) {
        guard households.contains(where: { $0.id == id }) else { return }
        currentHouseholdId = id
        loadLocalPrefs()
    }

    /// Remove (disconnect) the current household + its tokens. Falls back to
    /// another household, or fully unpaired if it was the last.
    func unpair() {
        guard let hid = currentHouseholdId else { return }
        for user in deviceUsers { removeToken(for: user.id) }
        households.removeAll { $0.id == hid }
        currentHouseholdId = households.first?.id
        loadLocalPrefs()
    }

    // MARK: - User Sessions (scoped to the current household)

    func loginUser(_ userId: String, token: String) {
        storeToken(token, for: userId)
        activeUserId = userId
        loadLocalPrefs()
    }

    func logoutUser(_ userId: String) {
        removeToken(for: userId)
        if activeUserId == userId { activeUserId = nil }
    }

    func logoutAll() {
        for user in deviceUsers { removeToken(for: user.id) }
        activeUserId = nil
    }

    func switchToUser(_ userId: String) -> Bool {
        guard tokenForUser(userId) != nil else { return false }
        activeUserId = userId
        loadLocalPrefs()
        return true
    }

    func updateDeviceUsers(_ users: [DeviceUser]) { deviceUsers = users }

    /// Fold fresh server profiles into the persisted device users. Avatar, color,
    /// and name can change server-side after a device was paired (e.g. a photo set
    /// on another device), leaving the local copy stale — that's why an avatar can
    /// fall back to initials. Only touches accounts this device already knows;
    /// never adds or removes one.
    func reconcileDeviceUsers(from servers: [ServerUser]) {
        guard !servers.isEmpty else { return }
        let byId = Dictionary(servers.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var users = deviceUsers
        var changed = false
        for i in users.indices {
            guard let s = byId[users[i].id] else { continue }
            let fresh = DeviceUser(from: s)
            if fresh != users[i] { users[i] = fresh; changed = true }
        }
        if changed { deviceUsers = users }
    }

    // MARK: - Token Storage (per household + user)

    private func tokenKey(_ userId: String) -> String? {
        guard let hid = currentHouseholdId else { return nil }
        return "maurice.token.\(hid).\(userId)"
    }
    func tokenForUser(_ userId: String) -> String? {
        guard let k = tokenKey(userId) else { return nil }
        return UserDefaults.standard.string(forKey: k)
    }

    /// Bearer for any household's active user (used to register the push token
    /// with every household, not just the current one).
    func token(for household: Household) -> String? {
        guard let uid = household.activeUserId else { return nil }
        return UserDefaults.standard.string(forKey: "maurice.token.\(household.id).\(uid)")
    }
    private func storeToken(_ token: String, for userId: String) {
        guard let k = tokenKey(userId) else { return }
        UserDefaults.standard.set(token, forKey: k)
    }
    private func removeToken(for userId: String) {
        guard let k = tokenKey(userId) else { return }
        UserDefaults.standard.removeObject(forKey: k)
    }

    private func mcpKey(_ userId: String) -> String? {
        guard let hid = currentHouseholdId else { return nil }
        return "maurice.mcp-token.\(hid).\(userId)"
    }
    func mcpToken(for userId: String) -> String? {
        mcpKey(userId).flatMap { UserDefaults.standard.string(forKey: $0) }
    }
    func saveMcpToken(_ token: String, for userId: String) {
        if let k = mcpKey(userId) { UserDefaults.standard.set(token, forKey: k) }
    }
    func clearMcpToken(for userId: String) {
        if let k = mcpKey(userId) { UserDefaults.standard.removeObject(forKey: k) }
    }

    // MARK: - Preferences

    func loadPreferences() async {
        guard let url = serverURL, let token = tokenForActiveUser else { return }
        let api = APIClient(baseURL: url)
        do {
            let prefs: ServerPreferences = try await api.get("/api/users/me/preferences", token: token)
            palette = prefs.palette ?? "auto"
            localeIdentifier = prefs.locale
        } catch {
            loadLocalPrefs()
        }
    }

    func savePreferences() async {
        guard let url = serverURL, let token = tokenForActiveUser else { return }
        let api = APIClient(baseURL: url)
        let body = ServerPreferences(palette: palette, locale: localeIdentifier)
        let _: ServerPreferences? = try? await api.patch("/api/users/me/preferences", body: body, token: token)
    }

    private func saveLocalPrefs() {
        guard let uid = activeUserId else { return }
        UserDefaults.standard.set(palette, forKey: "maurice.prefs.\(uid).palette")
        UserDefaults.standard.set(localeIdentifier, forKey: "maurice.prefs.\(uid).locale")
        UserDefaults.standard.set(webTheme, forKey: "maurice.prefs.\(uid).webTheme")
    }

    private func loadLocalPrefs() {
        guard let uid = activeUserId else { return }
        palette = UserDefaults.standard.string(forKey: "maurice.prefs.\(uid).palette") ?? "auto"
        localeIdentifier = UserDefaults.standard.string(forKey: "maurice.prefs.\(uid).locale")
        webTheme = UserDefaults.standard.string(forKey: "maurice.prefs.\(uid).webTheme") ?? "manuscript"
    }

    // MARK: - Persistence + migration

    private func saveHouseholds() {
        if let data = try? JSONEncoder().encode(households) {
            UserDefaults.standard.set(data, forKey: "maurice.households")
        }
    }
    private func loadHouseholds() {
        guard let data = UserDefaults.standard.data(forKey: "maurice.households"),
              let hs = try? JSONDecoder().decode([Household].self, from: data) else { return }
        households = hs
    }

    /// One-time upgrade from the old single-household layout so an existing
    /// pairing + users + tokens survive (no forced re-enroll).
    private func migrateLegacyIfNeeded() {
        guard households.isEmpty,
              let url = UserDefaults.standard.string(forKey: "maurice.serverURL") else { return }
        var users: [DeviceUser] = []
        if let data = UserDefaults.standard.data(forKey: "maurice.deviceUsers"),
           let decoded = try? JSONDecoder().decode([DeviceUser].self, from: data) { users = decoded }
        let activeUid = UserDefaults.standard.string(forKey: "maurice.activeUserId")
        let hid = UUID().uuidString
        for u in users {
            if let t = UserDefaults.standard.string(forKey: "maurice.token.\(u.id)") {
                UserDefaults.standard.set(t, forKey: "maurice.token.\(hid).\(u.id)")
            }
            if let m = UserDefaults.standard.string(forKey: "maurice.mcp-token.\(u.id)") {
                UserDefaults.standard.set(m, forKey: "maurice.mcp-token.\(hid).\(u.id)")
            }
        }
        households = [Household(id: hid, serverURL: url, name: Self.defaultName(url),
                                deviceUsers: users, activeUserId: activeUid)]
        UserDefaults.standard.set(hid, forKey: "maurice.currentHousehold")
    }

    /// Keep a flat mirror of the active user id so the global L() (which has no
    /// SessionStore) can resolve the locale.
    private func syncActiveUserMirror() {
        UserDefaults.standard.set(currentHousehold?.activeUserId, forKey: "maurice.activeUserId")
    }

    static func defaultName(_ serverURL: String) -> String {
        if let u = URL(string: serverURL), let host = u.host { return host }
        return serverURL
    }
}

// MARK: - Device User (cached locally)

struct DeviceUser: Identifiable, Codable, Hashable {
    let id: String
    let displayName: String
    let avatarColor: String
    let hasPin: Bool
    /// Optional so older persisted device users still decode (nil → treat as a
    /// regular member). "guest" locks the device to this single account.
    var role: String?
    /// Photo avatar path ("/api/avatars/<file>") if the member set one; nil → initials.
    var avatarURL: String?
    /// Garden slug / login handle (e.g. "candide"); the garden lives at /g/<username>.
    var username: String?

    init(from server: ServerUser) {
        self.id = server.id
        self.displayName = server.display_name
        self.avatarColor = server.avatar_color
        self.hasPin = server.has_pin
        self.role = server.role
        self.avatarURL = server.avatar_url
        self.username = server.username
    }

    init(id: String, displayName: String, avatarColor: String, hasPin: Bool, role: String? = nil, avatarURL: String? = nil, username: String? = nil) {
        self.id = id
        self.displayName = displayName
        self.role = role
        self.avatarColor = avatarColor
        self.hasPin = hasPin
        self.avatarURL = avatarURL
        self.username = username
    }

    var color: Color {
        Color(hex: avatarColor)
    }

    var initial: String {
        String(displayName.prefix(1))
    }
}

// MARK: - Color hex extension

extension Color {
    init(hex: String) {
        let hex = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        var int: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&int)
        let r = Double((int >> 16) & 0xFF) / 255.0
        let g = Double((int >> 8) & 0xFF) / 255.0
        let b = Double(int & 0xFF) / 255.0
        self.init(red: r, green: g, blue: b)
    }

    /// sRGB components (0–1) resolved through the platform color, if available.
    private var rgbaComponents: (r: Double, g: Double, b: Double, a: Double)? {
        #if canImport(UIKit)
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        guard UIColor(self).getRed(&r, green: &g, blue: &b, alpha: &a) else { return nil }
        return (Double(r), Double(g), Double(b), Double(a))
        #elseif canImport(AppKit)
        guard let c = NSColor(self).usingColorSpace(.sRGB) else { return nil }
        return (Double(c.redComponent), Double(c.greenComponent), Double(c.blueComponent), Double(c.alphaComponent))
        #else
        return nil
        #endif
    }

    /// Nudge an arbitrary (often user-chosen) color so it stays legible as a
    /// FOREGROUND on the current scheme's surface, preserving hue: dark colors are
    /// lifted toward white on dark backgrounds, light colors deepened toward black
    /// on light ones. Colors that already contrast enough are returned unchanged.
    ///
    /// Only for foreground use (text/icons on a surface). Do NOT apply to accent
    /// FILLS — there the saturated color carries white content on top by design.
    func legible(onDark dark: Bool) -> Color {
        guard let c = rgbaComponents else { return self }
        // Perceptual luminance (sRGB-weighted), 0 = black … 1 = white.
        let lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
        if dark {
            let target = 0.62                 // floor luminance to read on dark surfaces
            guard lum < target else { return self }
            let t = min(1, (target - lum) / target)
            return Color(red: c.r + (1 - c.r) * t,
                         green: c.g + (1 - c.g) * t,
                         blue: c.b + (1 - c.b) * t)
        } else {
            let target = 0.55                 // ceiling luminance to read on light surfaces
            guard lum > target else { return self }
            let t = min(1, (lum - target) / (1 - target))
            return Color(red: c.r * (1 - t), green: c.g * (1 - t), blue: c.b * (1 - t))
        }
    }
}
