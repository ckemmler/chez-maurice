import SwiftUI

/// First-launch screen: enter the Maurice server URL to pair this device.
struct PairingView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.colorScheme) private var colorScheme
    /// When set (presented as a sheet to add another household), called after a
    /// successful pair so the caller can dismiss. Nil when used as the root.
    var onPaired: (() -> Void)? = nil
    @State private var serverURL = ""
    @State private var isConnecting = false
    @State private var error: String?

    var body: some View {
        let theme = MauriceTheme.current(for: colorScheme)

        ZStack {
            theme.surface.ignoresSafeArea()

            VStack(spacing: 32) {
            Spacer()

            BoaterHat(size: 48, color: theme.ink)

            VStack(spacing: 8) {
                Text("Chez Maurice")
                    .font(.wordmark(36))
                    .foregroundStyle(theme.ink)

                Text(session.localized("app.tagline"))
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(theme.inkMute)
                    .tracking(0.5)
            }

            VStack(spacing: 12) {
                Text(session.localized("pairing.instructions"))
                    .font(.system(size: 15))
                    .foregroundStyle(theme.inkSoft)
                    .multilineTextAlignment(.center)
                    .lineSpacing(3)

                VStack(spacing: 12) {
                    TextField(session.localized("pairing.url_placeholder"), text: $serverURL)
                        .textFieldStyle(.roundedBorder)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        #endif
                        .frame(maxWidth: 400)
                        .submitLabel(.go)
                        .onSubmit { Task { await connect() } }

                    Button {
                        Task { await connect() }
                    } label: {
                        HStack(spacing: 8) {
                            if isConnecting {
                                ProgressView()
                                    .controlSize(.small)
                            }
                            Text(session.localized("pairing.connect"))
                                .font(.system(size: 15, weight: .medium))
                        }
                        .frame(maxWidth: 400)
                        .padding(.vertical, 10)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(serverURL.trimmingCharacters(in: .whitespaces).isEmpty || isConnecting)
                }
            }
            .padding(.horizontal, 40)

            if let error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 40)
            }

            Spacer()
            Spacer()
            }
        }
    }

    private func connect() async {
        guard !isConnecting else { return }
        // Default the scheme to https (Maurice servers are TLS), trim, drop any
        // trailing slash, and require a real host — so a bare "mac.local:3001"
        // just works and a typo gives a clear message instead of a crash.
        guard let url = Self.normalizedURL(serverURL) else {
            error = session.localized("pairing.error.invalid_url")
            return
        }
        serverURL = url  // reflect what we'll actually try

        isConnecting = true
        error = nil

        do {
            let api = APIClient(baseURL: url)
            let health: HealthResponse = try await api.get("/api/health")

            guard health.status == "ok" else {
                error = session.localized("pairing.error.status")
                isConnecting = false
                return
            }

            session.pair(serverURL: url, name: health.household,
                         color: health.household_color, icon: health.household_icon)
            onPaired?()
        } catch {
            self.error = Self.friendlyConnectError(error, url: url, session: session)
        }

        isConnecting = false
    }

    /// Normalize a typed address: default the scheme to https, trim whitespace,
    /// strip a trailing slash, and reject anything without a host. Returns nil
    /// when the input can't be made into a valid URL.
    static func normalizedURL(_ raw: String) -> String? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        let lower = s.lowercased()
        if !lower.hasPrefix("http://") && !lower.hasPrefix("https://") {
            s = "https://" + s
        }
        while s.hasSuffix("/") { s.removeLast() }
        guard let u = URL(string: s), let host = u.host, !host.isEmpty else { return nil }
        return s
    }

    /// A human error that never renders "(null)": prefer a concrete reason, fall
    /// back to a generic one, and nudge toward https when a plain-http address
    /// (the usual cause) was used.
    static func friendlyConnectError(_ error: Error, url: String, session: SessionStore) -> String {
        var reason = (error as? LocalizedError)?.errorDescription ?? ""
        if reason.isEmpty { reason = (error as NSError).localizedDescription }
        if reason.isEmpty { reason = session.localized("pairing.error.unreachable") }

        // session.localized already does the String(format:) — pass the arg in,
        // don't wrap it again (that double-format is what printed "(null)").
        var msg = session.localized("pairing.error.connect", reason)
        if url.lowercased().hasPrefix("http://") {
            msg += "\n" + session.localized("pairing.error.https_hint")
        }
        return msg
    }
}
