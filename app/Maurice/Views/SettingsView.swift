import SwiftUI
import PhotosUI
import ImageIO
import AVFoundation
import UniformTypeIdentifiers

// Settings — "Index card" (Claude Design, Settings Reorg prop B): a quiet root
// that reads like a table of contents (each row shows its current value), with
// tap-to-drill-in detail panes. The web theme lives with the garden (it's how
// the member's digital garden looks on the web), separate from the app palette.
struct SettingsView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.mauriceTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    enum Pane: Hashable { case appearance, language, garden, token, files }
    @State private var pane: Pane? = nil

    // MCP token (loaded once; the root row copies, the token pane manages).
    @State private var token: String? = nil
    @State private var tokenLoading = false
    @State private var copied = false

    // Avatar: pick → crop sheet → upload (PUT /api/users/:id/avatar). avatarImage
    // is the instant local preview; the photo also persists via the device user's
    // avatarURL (served from /api/avatars/<file>).
    @State private var avatarItem: PhotosPickerItem?
    @State private var avatarImage: Image?
    @State private var cropSource: Image?
    @State private var showCrop = false
    @State private var showSourceDialog = false
    @State private var showSafety = false
    @State private var showCamera = false
    @State private var showLibrary = false

    // Web themes (themes/<id> on the web), fetched from /api/web-themes; the
    // default is shown until the list loads / if offline.
    @State private var webThemes: [(id: String, label: String)] = [("default", "Default")]
    @State private var filesLibrary: LibraryResponse?

    private var locales: [(id: String?, label: String)] {
        [(nil, session.localized("settings.locale.system")),
         ("en", "English"), ("fr", "Français"), ("it", "Italiano"),
         ("de", "Deutsch"), ("es", "Español"), ("pt", "Português"), ("nl", "Nederlands")]
    }

    private var accent: Color { session.activeDeviceUser?.color ?? .blue }

    var body: some View {
        ZStack {
            if let pane {
                detail(pane).transition(.move(edge: .trailing).combined(with: .opacity))
            } else {
                root.transition(.move(edge: .leading).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.22), value: pane)
        .frame(minWidth: 320, idealWidth: 360, maxWidth: 400, minHeight: 440, idealHeight: 560)
        .background(theme.surface)
        .presentationBackground(theme.surface)
        .task { await loadToken() }
        .task { await loadWebThemes() }
        .task { await loadFiles() }
        .onChange(of: avatarItem) { _, item in prepareCrop(item) }
        .confirmationDialog(session.localized("settings.avatar.hint"), isPresented: $showSourceDialog, titleVisibility: .hidden) {
            Button(session.localized("settings.avatar.take_photo")) { showCamera = true }
            Button(session.localized("settings.avatar.choose_photo")) { showLibrary = true }
            Button(L("common.cancel"), role: .cancel) {}
        }
        .photosPicker(isPresented: $showLibrary, selection: $avatarItem, matching: .images)
        .sheet(isPresented: $showCamera) {
            CameraCaptureView { data in
                showCamera = false
                Task { try? await Task.sleep(nanoseconds: 350_000_000); presentCrop(data) }
            }
        }
        .sheet(isPresented: $showCrop) {
            if let cropSource {
                AvatarCropView(source: cropSource) { data in
                    showCrop = false
                    Task { await uploadAvatar(data) }
                }
            }
        }
        .sheet(isPresented: $showSafety) { SafetySettingsView() }
    }

    // MARK: - Root (the index)

    private var root: some View {
        VStack(alignment: .leading, spacing: 0) {
            SetHeader(title: session.localized("settings.title")) { dismiss() }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    identity

                    SetCard {
                        IndexRow(icon: "globe", label: session.localized("settings.locale.title"),
                                 value: currentLocaleLabel, accent: accent) { pane = .language }
                        SetDivider()
                        IndexRow(icon: "paintpalette", label: session.localized("settings.palette.title"),
                                 value: appearanceValue, accent: accent) { pane = .appearance }
                    }

                    // Guests have no library, so no Files row for them.
                    if !session.activeIsGuest {
                        SetGroup(session.localized("settings.files.group")) {
                            SetCard {
                                IndexRow(icon: "folder", label: session.localized("settings.files.title"),
                                         value: filesValue, accent: accent) { pane = .files }
                            }
                        }
                    }

                    SetGroup(session.localized("settings.garden.title")) {
                        SetCard {
                            IndexRow(icon: "leaf", label: session.localized("settings.garden.webtheme"),
                                     value: currentWebThemeLabel, accent: accent) { pane = .garden }
                            SetDivider()
                            IndexRow(icon: "arrow.up.forward.square", label: session.localized("settings.garden.open"),
                                     value: session.localized("settings.garden.signedin"), accent: accent,
                                     trailing: AnyView(Image(systemName: "arrow.up.forward")
                                        .font(.system(size: 11, weight: .semibold)).foregroundStyle(accent.legible(onDark: theme.isDark)))) {
                                openGarden()
                            }
                        }
                    }

                    SetGroup(session.localized("settings.mcp.title")) {
                        SetCard {
                            IndexRow(icon: "key", label: session.localized("settings.mcp.token"), value: maskedToken, valueMono: true,
                                     accent: accent,
                                     trailing: AnyView(Image(systemName: copied ? "checkmark" : "doc.on.doc")
                                        .font(.system(size: 13)).foregroundStyle(copied ? .green : theme.inkSoft))) {
                                pane = .token
                            }
                        }
                        SetCaption(session.localized("settings.mcp.copyhint"))
                    }

                    SetGroup("SAFETY") {
                        SetCard {
                            IndexRow(icon: "exclamationmark.shield",
                                     label: "Report a concern / Safety",
                                     accent: accent) { showSafety = true }
                        }
                        SetCaption("Report room content to the operator from a message's menu. To report this server, or for child-safety, use the options here.")
                    }
                }
                .padding(.horizontal, 18).padding(.top, 14).padding(.bottom, 18)
            }
            footer
        }
    }

    private var identity: some View {
        HStack(spacing: 14) {
            Button { showSourceDialog = true } label: {
                AvatarUploader(localImage: avatarImage, avatarURL: session.activeDeviceUser?.avatarURL,
                               serverURL: session.serverURL, initial: session.activeDeviceUser?.initial ?? "?",
                               color: accent, size: 50)
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 9) {
                    Text(session.activeDeviceUser?.displayName ?? "")
                        .font(.system(size: 15.5, weight: .medium)).foregroundStyle(theme.ink)
                    if session.activeIsGuest {
                        Text(session.localized("settings.user.guest"))
                            .font(.system(size: 9, design: .monospaced)).tracking(1)
                            .foregroundStyle(theme.inkSoft)
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .overlay(Capsule().strokeBorder(theme.ruleHard, lineWidth: 0.5))
                    } else {
                        // Non-guests can hop to another household member.
                        Button { dismiss(); session.activeUserId = nil } label: {
                            Text(session.localized("sidebar.switch"))
                                .font(.system(size: 11, weight: .medium)).foregroundStyle(accent.legible(onDark: theme.isDark))
                                .padding(.horizontal, 10).padding(.vertical, 4)
                                .overlay(Capsule().strokeBorder(theme.ruleHard, lineWidth: 0.5))
                        }
                        .buttonStyle(.plain)
                    }
                }
                SetCaption(session.localized("settings.avatar.hint"))
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 4).padding(.bottom, 2)
    }

    private var footer: some View {
        VStack(spacing: 0) {
            SetDivider()
            HStack(spacing: 12) {
                Text(session.serverURL ?? "")
                    .font(.system(size: 10.5, design: .monospaced)).foregroundStyle(theme.inkMute)
                    .lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 8)
                Button { session.unpair() } label: {
                    Text(session.localized("settings.disconnect"))
                        .font(.system(size: 10.5, design: .monospaced)).foregroundStyle(.red.opacity(0.8))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 20).padding(.vertical, 11)
        }
    }

    // MARK: - Detail panes

    @ViewBuilder private func detail(_ p: Pane) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            SetDetailHeader(title: title(for: p), back: session.localized("settings.title"), accent: accent,
                            onBack: { pane = nil }, onClose: { dismiss() })
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    switch p {
                    case .appearance: appearancePane
                    case .language:   languagePane
                    case .garden:     gardenPane
                    case .token:      tokenPane
                    case .files:      FilesLibraryView(accent: accent, library: $filesLibrary)
                    }
                }
                .padding(.horizontal, 18).padding(.top, 14).padding(.bottom, 18)
            }
            footer
        }
    }

    private func title(for p: Pane) -> String {
        switch p {
        case .appearance: return session.localized("settings.palette.title")
        case .language:   return session.localized("settings.locale.title")
        case .garden:     return session.localized("settings.garden.title")
        case .token:      return session.localized("settings.mcp.title")
        case .files:      return session.localized("settings.files.title")
        }
    }

    private var appearancePane: some View {
        VStack(alignment: .leading, spacing: 16) {
            ComposerSegmented(
                options: [("auto", session.localized("settings.palette.auto")),
                          ("light", session.localized("settings.palette.mode_light")),
                          ("dark", session.localized("settings.palette.mode_dark"))],
                value: Binding(get: { paletteMode }, set: { applyMode($0) }), accent: accent)

            VStack(alignment: .leading, spacing: 9) {
                SetKicker(session.localized("settings.palette.light"))
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 54, maximum: 64), spacing: 8)], spacing: 8) {
                    ForEach(MauriceTheme.lightPalettes, id: \.id) { p in
                        PaletteSwatch(palette: p, isSelected: session.palette == p.id, accent: accent) {
                            session.palette = p.id; syncPrefs()
                        }
                    }
                }
            }
            VStack(alignment: .leading, spacing: 9) {
                SetKicker(session.localized("settings.palette.dark"))
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 54, maximum: 64), spacing: 8)], spacing: 8) {
                    ForEach(MauriceTheme.darkPalettes, id: \.id) { p in
                        PaletteSwatch(palette: p, isSelected: session.palette == p.id, accent: accent) {
                            session.palette = p.id; syncPrefs()
                        }
                    }
                }
            }
            SetCaption(session.localized("settings.palette.auto_hint"))
        }
    }

    private var languagePane: some View {
        SetCard {
            ForEach(Array(locales.enumerated()), id: \.element.label) { i, locale in
                SetCheckRow(label: locale.label, on: session.localeIdentifier == locale.id, accent: accent) {
                    session.localeIdentifier = locale.id; syncPrefs()
                }
                if i < locales.count - 1 { SetDivider() }
            }
        }
    }

    private var gardenPane: some View {
        VStack(alignment: .leading, spacing: 18) {
            // Open the garden in a signed-in session, with the chosen theme.
            Button { openGarden() } label: {
                HStack(spacing: 11) {
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .fill(accent.opacity(0.14)).frame(width: 30, height: 30)
                        .overlay(Image(systemName: "leaf").font(.system(size: 15)).foregroundStyle(accent.legible(onDark: theme.isDark)))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(session.localized("settings.garden.openlink")).font(.system(size: 13, weight: .medium)).foregroundStyle(theme.ink)
                        Text(gardenHost).font(.system(size: 9.5, design: .monospaced)).foregroundStyle(theme.inkMute)
                            .lineLimit(1).truncationMode(.middle)
                    }
                    Spacer(minLength: 8)
                    HStack(spacing: 5) {
                        Text(session.localized("settings.garden.openbutton")).font(.system(size: 11.5, weight: .medium))
                        Image(systemName: "arrow.up.forward").font(.system(size: 10, weight: .semibold))
                    }
                    .foregroundStyle(.white).padding(.horizontal, 11).padding(.vertical, 6)
                    .background(accent, in: Capsule())
                }
                .padding(11)
                .background(theme.surfaceAlt, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(theme.rule, lineWidth: 0.5))
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 9) {
                SetKicker(session.localized("settings.garden.webtheme"))
                SetCard {
                    ForEach(Array(webThemes.enumerated()), id: \.element.id) { i, wt in
                        SetCheckRow(label: wt.label, on: session.webTheme == wt.id, accent: accent) {
                            session.webTheme = wt.id; syncPrefs()
                        }
                        if i < webThemes.count - 1 { SetDivider() }
                    }
                }
                SetCaption(session.localized("settings.garden.webtheme_hint"))
            }
        }
    }

    private var tokenPane: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Text(maskedToken).font(.system(size: 12.5, design: .monospaced)).foregroundStyle(theme.ink)
                Spacer(minLength: 8)
                Button { copyToken() } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 14)).foregroundStyle(copied ? .green : theme.inkSoft)
                }.buttonStyle(.plain)
                Button { rotateToken() } label: {
                    Image(systemName: "arrow.clockwise").font(.system(size: 13)).foregroundStyle(theme.inkSoft)
                }.buttonStyle(.plain)
            }
            .padding(.horizontal, 13).frame(height: 40)
            .background(theme.surfaceAlt, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(theme.rule, lineWidth: 0.5))

            SetCaption(session.localized("settings.mcp.hint"))

            Button { openTokenLogin() } label: {
                Label(session.localized("settings.mcp.open_browser"), systemImage: "safari")
                    .font(.system(size: 12)).foregroundStyle(accent.legible(onDark: theme.isDark))
            }.buttonStyle(.plain)
        }
    }

    // MARK: - Derived values

    private var currentLocaleLabel: String {
        locales.first { $0.id == session.localeIdentifier }?.label ?? session.localized("settings.locale.system")
    }
    private var currentWebThemeLabel: String {
        webThemes.first { $0.id == session.webTheme }?.label ?? "Default"
    }
    private var appearanceValue: String {
        let mode: String
        switch paletteMode {
        case "light": mode = session.localized("settings.palette.mode_light")
        case "dark":  mode = session.localized("settings.palette.mode_dark")
        default:      mode = session.localized("settings.palette.auto")
        }
        let pal = (MauriceTheme.lightPalettes + MauriceTheme.darkPalettes).first { $0.id == session.palette }?.label
        return pal.map { "\(mode) · \($0)" } ?? mode
    }
    private var maskedToken: String {
        guard let t = token, t.count > 8 else { return token ?? "—" }
        return "maur_****\(t.suffix(8))"
    }
    private var gardenHost: String {
        guard let s = session.serverURL, let host = URL(string: s)?.host, let slug = gardenSlug else {
            return session.serverURL ?? ""
        }
        return "\(host)/g/\(slug)"
    }

    private var paletteMode: String {
        if session.palette == "auto" { return "auto" }
        return MauriceTheme.darkPalettes.contains { $0.id == session.palette } ? "dark" : "light"
    }

    // MARK: - Actions

    private func syncPrefs() { Task { await session.savePreferences() } }

    private func applyMode(_ mode: String) {
        switch mode {
        case "auto": session.palette = "auto"
        case "light":
            if !MauriceTheme.lightPalettes.contains(where: { $0.id == session.palette }) { session.palette = "cream" }
        case "dark":
            if !MauriceTheme.darkPalettes.contains(where: { $0.id == session.palette }) { session.palette = "studio" }
        default: break
        }
        syncPrefs()
    }

    private var gardenSlug: String? { session.activeDeviceUser?.username ?? session.activeUserId }

    private func openGarden() {
        // Go through /login so the browser gets a session cookie first (a bare
        // /g/<slug> link is rejected by the members-only web gate). The server
        // redirects to the member's own garden with the chosen theme.
        Task {
            if token == nil { await loadToken() }
            guard let t = token, let s = session.serverURL,
                  let theme = session.webTheme.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
                  let url = URL(string: "\(s)/login?token=\(t)&theme=\(theme)") else { return }
            openURL(url)
        }
    }
    private func openTokenLogin() {
        guard let t = token, let s = session.serverURL, let url = URL(string: "\(s)/login?token=\(t)") else { return }
        openURL(url)
    }
    private func openURL(_ url: URL) {
        #if os(iOS)
        UIApplication.shared.open(url)
        #elseif os(macOS)
        NSWorkspace.shared.open(url)
        #endif
    }

    private func copyToken() {
        guard let t = token else { return }
        #if os(iOS)
        UIPasteboard.general.string = t
        #elseif os(macOS)
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(t, forType: .string)
        #endif
        copied = true
        Task { try? await Task.sleep(nanoseconds: 1_800_000_000); copied = false }
    }

    // Any source (library or camera) → a high-res, orientation-correct crop source.
    private func presentCrop(_ data: Data) {
        guard let img = downsampledAvatar(data, maxPixel: 1600) else { return }
        cropSource = img
        showCrop = true
    }

    private func prepareCrop(_ item: PhotosPickerItem?) {
        guard let item else { return }
        Task {
            guard let data = try? await item.loadTransferable(type: Data.self) else { return }
            presentCrop(data)
        }
    }

    private func loadWebThemes() async {
        guard let serverURL = session.serverURL else { return }
        let api = APIClient(baseURL: serverURL)
        if let resp: WebThemesResponse = try? await api.get("/api/web-themes", token: session.tokenForActiveUser),
           !resp.themes.isEmpty {
            webThemes = resp.themes.map { ($0.id, $0.name) }
        }
    }

    private func loadFiles() async {
        guard !session.activeIsGuest, let serverURL = session.serverURL else { return }
        let api = APIClient(baseURL: serverURL)
        if let resp: LibraryResponse = try? await api.get("/api/files", token: session.tokenForActiveUser) {
            filesLibrary = resp
        }
    }
    private var filesValue: String {
        guard let s = filesLibrary?.summary else { return "—" }
        return "\(s.count) · \(formatBytes(s.size_bytes))"
    }

    // Cropped JPEG → instant local preview + PUT to the server, then reflect the
    // returned avatar_url on the active device user.
    private func uploadAvatar(_ jpeg: Data) async {
        avatarImage = downsampledAvatar(jpeg, maxPixel: 256)
        guard let uid = session.activeUserId, let serverURL = session.serverURL,
              let token = session.tokenForActiveUser else { return }
        let dataURI = "data:image/jpeg;base64," + jpeg.base64EncodedString()
        let api = APIClient(baseURL: serverURL)
        if let updated: ServerUser = try? await api.put("/api/users/\(uid)/avatar",
                                                        body: AvatarUpload(image: dataURI), token: token) {
            var users = session.deviceUsers
            if let i = users.firstIndex(where: { $0.id == uid }) { users[i] = DeviceUser(from: updated) }
            session.updateDeviceUsers(users)
        }
    }

    private func downsampledAvatar(_ data: Data, maxPixel: CGFloat) -> Image? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
            kCGImageSourceCreateThumbnailWithTransform: true, // honour EXIF orientation
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        return Image(decorative: cg, scale: 1, orientation: .up)
    }

    private func loadToken() async {
        guard let userId = session.activeUserId, let serverURL = session.serverURL,
              let sessionToken = session.tokenForActiveUser else { return }
        if let cached = session.mcpToken(for: userId) { token = cached }
        if token == nil { tokenLoading = true }
        defer { tokenLoading = false }
        let api = APIClient(baseURL: serverURL)
        if let resp: McpTokenResponse = try? await api.post(
            "/api/users/me/mcp-token", body: McpTokenRequest(rotate: false), token: sessionToken) {
            session.saveMcpToken(resp.rawToken, for: userId); token = resp.rawToken
        }
    }
    private func rotateToken() {
        guard let userId = session.activeUserId, let serverURL = session.serverURL,
              let sessionToken = session.tokenForActiveUser else { return }
        token = nil
        Task {
            let api = APIClient(baseURL: serverURL)
            if let resp: McpTokenResponse = try? await api.post(
                "/api/users/me/mcp-token", body: McpTokenRequest(rotate: true), token: sessionToken) {
                session.saveMcpToken(resp.rawToken, for: userId); token = resp.rawToken
            }
        }
    }
}

private struct McpTokenRequest: Encodable { let rotate: Bool }
private struct AvatarUpload: Encodable { let image: String }
private struct WebThemesResponse: Decodable {
    struct Theme: Decodable { let id: String; let name: String }
    let themes: [Theme]
}

// MARK: - Index-card building blocks

private struct SetHeader: View {
    @Environment(\.mauriceTheme) private var theme
    let title: String
    let onClose: () -> Void
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(title).font(.system(size: 24, design: .serif)).foregroundStyle(theme.ink)
                Spacer()
                CloseButton(action: onClose)
            }
            .padding(.horizontal, 20).padding(.top, 18).padding(.bottom, 14)
            SetDivider()
        }
    }
}

private struct SetDetailHeader: View {
    @Environment(\.mauriceTheme) private var theme
    let title: String
    let back: String
    let accent: Color
    let onBack: () -> Void
    let onClose: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Button(action: onBack) {
                    HStack(spacing: 3) {
                        Image(systemName: "chevron.left").font(.system(size: 12, weight: .semibold))
                        Text(back).font(.system(size: 12.5, weight: .medium))
                    }
                    .foregroundStyle(accent.legible(onDark: theme.isDark))
                }
                .buttonStyle(.plain)
                Spacer()
                CloseButton(action: onClose)
            }
            Text(title).font(.system(size: 22, design: .serif)).foregroundStyle(theme.ink)
        }
        .padding(.horizontal, 18).padding(.top, 16).padding(.bottom, 6)
    }
}

private struct CloseButton: View {
    @Environment(\.mauriceTheme) private var theme
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: "xmark").font(.system(size: 12, weight: .medium)).foregroundStyle(theme.inkSoft)
                .frame(width: 27, height: 27).background(theme.surfaceAlt).clipShape(Circle())
        }
        .buttonStyle(.plain)
    }
}

private struct SetDivider: View {
    @Environment(\.mauriceTheme) private var theme
    var body: some View { Rectangle().fill(theme.rule).frame(height: 0.5) }
}

private struct SetCard<Content: View>: View {
    @Environment(\.mauriceTheme) private var theme
    @ViewBuilder let content: Content
    var body: some View {
        VStack(spacing: 0) { content }
            .background(theme.surfaceAlt, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(theme.rule, lineWidth: 0.5))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private struct SetGroup<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content
    init(_ title: String, @ViewBuilder content: () -> Content) { self.title = title; self.content = content() }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) { SetKicker(title); content }
    }
}

private struct SetKicker: View {
    @Environment(\.mauriceTheme) private var theme
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text.uppercased()).font(.system(size: 9.5, design: .monospaced)).tracking(1.2)
            .foregroundStyle(theme.inkMute)
    }
}

private struct SetCaption: View {
    @Environment(\.mauriceTheme) private var theme
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text).font(.system(size: 11.5)).foregroundStyle(theme.inkMute).lineSpacing(1)
    }
}

private struct IndexRow: View {
    @Environment(\.mauriceTheme) private var theme
    let icon: String
    let label: String
    var value: String? = nil
    var valueMono: Bool = false
    let accent: Color
    var trailing: AnyView? = nil
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 11) {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(accent.opacity(0.14)).frame(width: 26, height: 26)
                    .overlay(Image(systemName: icon).font(.system(size: 13)).foregroundStyle(accent.legible(onDark: theme.isDark)))
                Text(label).font(.system(size: 13.5)).foregroundStyle(theme.ink)
                Spacer(minLength: 8)
                if let value {
                    Text(value)
                        .font(valueMono ? .system(size: 11, design: .monospaced) : .system(size: 12.5))
                        .foregroundStyle(theme.inkMute).lineLimit(1).truncationMode(.tail).frame(maxWidth: 150, alignment: .trailing)
                }
                if let trailing { trailing }
                else { Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(theme.inkMute.opacity(0.6)) }
            }
            .padding(.horizontal, 13).frame(minHeight: 46).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

private struct SetCheckRow: View {
    @Environment(\.mauriceTheme) private var theme
    let label: String
    let on: Bool
    let accent: Color
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack {
                Text(label).font(.system(size: 13.5, weight: on ? .medium : .regular)).foregroundStyle(theme.ink)
                Spacer(minLength: 8)
                if on { Image(systemName: "checkmark").font(.system(size: 12, weight: .semibold)).foregroundStyle(accent.legible(onDark: theme.isDark)) }
            }
            .padding(.horizontal, 13).frame(minHeight: 38)
            .background(on ? accent.opacity(0.08) : .clear).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// the uploader treatment: dashed halo + camera badge = "drop or tap to change"
private struct AvatarUploader: View {
    @Environment(\.mauriceTheme) private var theme
    let localImage: Image?
    let avatarURL: String?
    let serverURL: String?
    let initial: String
    let color: Color
    var size: CGFloat = 50
    var body: some View {
        ZStack {
            Circle().strokeBorder(style: StrokeStyle(lineWidth: 1.2, dash: [3, 3]))
                .foregroundStyle(theme.ruleHard).frame(width: size + 12, height: size + 12)
            UserAvatar(localImage: localImage, avatarURL: avatarURL, serverURL: serverURL,
                       initial: initial, color: color, size: size)
        }
        .frame(width: size + 12, height: size + 12)
        .overlay(alignment: .bottomTrailing) {
            Image(systemName: "camera.fill").font(.system(size: size * 0.2))
                .foregroundStyle(theme.inkSoft)
                .frame(width: size * 0.42, height: size * 0.42)
                .background(theme.surfaceAlt, in: Circle())
                .overlay(Circle().strokeBorder(theme.ruleHard, lineWidth: 0.5))
        }
    }
}

// MARK: - Reusable photo-aware avatar (shared across settings + picker + …)

/// Renders, in order: a just-picked local image → the member's photo avatar
/// (avatar_url, served from /api/avatars/<file>) → the coloured initial.
struct UserAvatar: View {
    var localImage: Image? = nil
    let avatarURL: String?
    let serverURL: String?
    let initial: String
    let color: Color
    var size: CGFloat = 40

    private var fullURL: URL? {
        guard let avatarURL, !avatarURL.isEmpty else { return nil }
        if avatarURL.hasPrefix("http") { return URL(string: avatarURL) }
        guard let serverURL else { return nil }
        return URL(string: serverURL + avatarURL)
    }

    var body: some View {
        Group {
            if let localImage {
                localImage.resizable().interpolation(.high).antialiased(true).scaledToFill()
            } else if let fullURL {
                AsyncImage(url: fullURL) { phase in
                    if let img = phase.image {
                        img.resizable().interpolation(.high).scaledToFill()
                    } else {
                        initialView
                    }
                }
            } else {
                initialView
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
    }

    private var initialView: some View {
        Text(initial).font(.system(size: size * 0.46, design: .serif))
            .foregroundStyle(.white).frame(width: size, height: size).background(color)
    }
}

// MARK: - Avatar crop / reframe sheet ("move & scale")

struct AvatarCropView: View {
    @Environment(\.mauriceTheme) private var theme
    @Environment(\.dismiss) private var dismiss
    let source: Image
    let onConfirm: (Data) -> Void

    @State private var scale: CGFloat = 1
    @GestureState private var pinch: CGFloat = 1
    @State private var offset: CGSize = .zero
    @GestureState private var drag: CGSize = .zero

    private let diameter: CGFloat = 280

    var body: some View {
        VStack(spacing: 18) {
            Text(L("settings.avatar.reframe")).font(.system(size: 21, design: .serif)).foregroundStyle(theme.ink).padding(.top, 14)

            source.resizable().scaledToFill()
                .scaleEffect(scale * pinch)
                .offset(x: offset.width + drag.width, y: offset.height + drag.height)
                .frame(width: diameter, height: diameter)
                .clipShape(Circle())
                .overlay(Circle().strokeBorder(theme.ruleHard, lineWidth: 1))
                .contentShape(Circle())
                .gesture(
                    SimultaneousGesture(
                        DragGesture()
                            .updating($drag) { v, s, _ in s = v.translation }
                            .onEnded { v in offset.width += v.translation.width; offset.height += v.translation.height },
                        MagnificationGesture()
                            .updating($pinch) { v, s, _ in s = v }
                            .onEnded { v in scale = min(5, max(1, scale * v)) }
                    )
                )

            HStack(spacing: 12) {
                Image(systemName: "minus.magnifyingglass").font(.system(size: 13)).foregroundStyle(theme.inkSoft)
                Slider(value: $scale, in: 1...5)
                Image(systemName: "plus.magnifyingglass").font(.system(size: 13)).foregroundStyle(theme.inkSoft)
            }
            .padding(.horizontal, 34)

            HStack(spacing: 14) {
                Button { dismiss() } label: { Text(L("common.cancel")).frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered)
                Button { confirm() } label: { Text(L("settings.avatar.use")).frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent)
            }
            .padding(.horizontal, 24).padding(.bottom, 16)
        }
        .frame(minWidth: 340, idealWidth: 360, minHeight: 470)
        .background(theme.surface)
        .presentationBackground(theme.surface)
        .presentationDetents([.medium, .large])
    }

    @MainActor private func confirm() {
        let view = source.resizable().scaledToFill()
            .scaleEffect(scale)
            .offset(offset)
            .frame(width: diameter, height: diameter)
            .clipShape(Circle())
        let renderer = ImageRenderer(content: view)
        renderer.scale = 3
        guard let cg = renderer.cgImage, let data = jpegData(cg, quality: 0.9) else { dismiss(); return }
        onConfirm(data)
    }
}

/// Encode a CGImage to JPEG (cross-platform, via ImageIO).
private func jpegData(_ cg: CGImage, quality: CGFloat) -> Data? {
    let data = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(dest, cg, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { return nil }
    return data as Data
}

// MARK: - Palette swatch (unchanged)

private struct PaletteSwatch: View {
    @Environment(\.mauriceTheme) private var theme
    let palette: Palette
    let isSelected: Bool
    let accent: Color
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            VStack(spacing: 4) {
                RoundedRectangle(cornerRadius: 6).fill(palette.surface).frame(height: 32)
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(
                        isSelected ? accent : (palette.isDark ? Color.white.opacity(0.12) : Color.black.opacity(0.10)),
                        lineWidth: isSelected ? 2 : 0.5))
                    .overlay {
                        VStack(spacing: 2.5) {
                            let ink: Color = palette.isDark ? .white.opacity(0.7) : .black.opacity(0.5)
                            RoundedRectangle(cornerRadius: 1).fill(ink).frame(width: 20, height: 2)
                            RoundedRectangle(cornerRadius: 1).fill(ink.opacity(0.5)).frame(width: 14, height: 1.5)
                        }
                    }
                Text(palette.label).font(.system(size: 9)).foregroundStyle(isSelected ? theme.ink : theme.inkMute).lineLimit(1)
            }
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Camera capture (selfie → crop sheet)

/// AVFoundation session driver. Front camera by default; capture delivers JPEG/HEIC
/// Data on the main queue. Session work runs off-main on a private queue.
final class CameraModel: NSObject, ObservableObject, AVCapturePhotoCaptureDelegate {
    enum Status { case requesting, denied, ready }
    @Published var status: Status = .requesting

    let session = AVCaptureSession()
    private let output = AVCapturePhotoOutput()
    private var input: AVCaptureDeviceInput?
    private let queue = DispatchQueue(label: "maurice.camera.session")
    private var position: AVCaptureDevice.Position = .front
    var onCapture: ((Data) -> Void)?

    func start() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: configureAndRun()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async { granted ? self.configureAndRun() : (self.status = .denied) }
            }
        default: status = .denied
        }
    }

    private func configureAndRun() {
        queue.async {
            self.session.beginConfiguration()
            self.session.sessionPreset = .photo
            if let input = self.input { self.session.removeInput(input) }
            let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: self.position)
                ?? AVCaptureDevice.default(for: .video)
            if let device, let newInput = try? AVCaptureDeviceInput(device: device), self.session.canAddInput(newInput) {
                self.session.addInput(newInput); self.input = newInput
            }
            if !self.session.outputs.contains(self.output), self.session.canAddOutput(self.output) {
                self.session.addOutput(self.output)
            }
            self.session.commitConfiguration()
            if !self.session.isRunning { self.session.startRunning() }
            DispatchQueue.main.async { self.status = .ready }
        }
    }

    func flip() { position = position == .front ? .back : .front; configureAndRun() }
    func capture() { queue.async { self.output.capturePhoto(with: AVCapturePhotoSettings(), delegate: self) } }
    func stop() { queue.async { if self.session.isRunning { self.session.stopRunning() } } }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        guard let data = photo.fileDataRepresentation() else { return }
        DispatchQueue.main.async { self.onCapture?(data) }
    }
}

#if os(iOS)
struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession
    func makeUIView(context: Context) -> PreviewView {
        let v = PreviewView(); v.previewLayer.session = session; v.previewLayer.videoGravity = .resizeAspectFill; return v
    }
    func updateUIView(_ v: PreviewView, context: Context) {}
    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }
}
#elseif os(macOS)
struct CameraPreview: NSViewRepresentable {
    let session: AVCaptureSession
    func makeNSView(context: Context) -> PreviewView { PreviewView(session: session) }
    func updateNSView(_ v: PreviewView, context: Context) {}
    final class PreviewView: NSView {
        let previewLayer = AVCaptureVideoPreviewLayer()
        init(session: AVCaptureSession) {
            super.init(frame: .zero)
            wantsLayer = true
            previewLayer.session = session
            previewLayer.videoGravity = .resizeAspectFill
            layer = previewLayer
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) not used") }
        override func layout() { super.layout(); previewLayer.frame = bounds }
    }
}
#endif

struct CameraCaptureView: View {
    @Environment(\.mauriceTheme) private var theme
    @Environment(\.dismiss) private var dismiss
    @StateObject private var cam = CameraModel()
    let onCapture: (Data) -> Void

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                Color.black
                switch cam.status {
                case .ready:
                    CameraPreview(session: cam.session).clipShape(Circle()).padding(26)
                case .requesting:
                    ProgressView().tint(.white)
                case .denied:
                    VStack(spacing: 10) {
                        Image(systemName: "video.slash").font(.system(size: 30)).foregroundStyle(.white.opacity(0.7))
                        Text(L("settings.avatar.camera_denied")).font(.system(size: 13))
                            .foregroundStyle(.white.opacity(0.7)).multilineTextAlignment(.center).padding(.horizontal, 34)
                    }
                }
            }
            .frame(maxWidth: .infinity).frame(height: 360)

            HStack {
                Button { dismiss() } label: { Text(L("common.cancel")).font(.system(size: 14)) }
                    .buttonStyle(.plain).foregroundStyle(theme.inkSoft)
                Spacer()
                Button { cam.capture() } label: {
                    ZStack {
                        Circle().strokeBorder(theme.ink, lineWidth: 2).frame(width: 62, height: 62)
                        Circle().fill(theme.ink).frame(width: 50, height: 50)
                    }
                }
                .buttonStyle(.plain).disabled(cam.status != .ready)
                Spacer()
                Button { cam.flip() } label: {
                    Image(systemName: "arrow.triangle.2.circlepath.camera").font(.system(size: 18))
                }
                .buttonStyle(.plain).foregroundStyle(theme.inkSoft).disabled(cam.status != .ready)
            }
            .padding(.horizontal, 30).padding(.top, 16).padding(.bottom, 20)
        }
        .frame(minWidth: 360, idealWidth: 380, minHeight: 460)
        .background(theme.surface)
        .presentationBackground(theme.surface)
        .onAppear { cam.onCapture = { data in onCapture(data) }; cam.start() }
        .onDisappear { cam.stop() }
    }
}

// MARK: - Files library (Settings → Library drawer)

struct LibraryFolder: Codable, Identifiable { let id: String; let parent_id: String?; let name: String }
struct LibraryFile: Codable, Identifiable {
    let id: String; let folder_id: String?; let name: String; let kind: String
    let size_bytes: Int; let token_estimate: Int?
}
struct LibrarySummary: Codable { let count: Int; let size_bytes: Int; let quota_bytes: Int }
struct LibraryResponse: Codable { var folders: [LibraryFolder]; var files: [LibraryFile]; var summary: LibrarySummary }

private struct NewFolderBody: Encodable { let parent_id: String?; let name: String }
private struct RenameBody: Encodable { let name: String }

func formatBytes(_ bytes: Int) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"]; var v = Double(bytes); var i = 0
    while v >= 1024 && i < units.count - 1 { v /= 1024; i += 1 }
    return i == 0 ? "\(bytes) B" : String(format: v >= 100 ? "%.0f %@" : "%.1f %@", v, units[i])
}

private enum LibRowKind { case folder(LibraryFolder, count: Int); case file(LibraryFile) }
private struct LibRow: Identifiable { let id: String; let kind: LibRowKind; let depth: Int }

struct FilesLibraryView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.mauriceTheme) private var theme
    let accent: Color
    @Binding var library: LibraryResponse?

    @State private var collapsed: Set<String> = []
    @State private var selectedFileId: String?
    @State private var showNewFolder = false
    @State private var newFolderName = ""
    @State private var renameTarget: RenameTarget?
    @State private var renameText = ""
    @State private var showImporter = false
    @State private var uploading = false
    @State private var panelTargeted = false   // macOS: file dragged over the panel
    @State private var dropFolderId: String?    // macOS: folder row highlighted as drop target

    private struct RenameTarget: Identifiable { let id: String; let isFolder: Bool }
    private var api: APIClient? { session.serverURL.map { APIClient(baseURL: $0) } }
    private var token: String? { session.tokenForActiveUser }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                // Add files — the standing upload affordance (accent). The tap path
                // on every platform; on macOS the panel is also a drop target.
                toolbarButton(icon: "arrow.up.doc", label: session.localized("settings.files.addfiles"),
                              accent: true) { showImporter = true }
                toolbarButton(icon: "folder.badge.plus", label: session.localized("settings.files.newfolder"),
                              accent: false) { newFolderName = ""; showNewFolder = true }
                Spacer(minLength: 6)
                if uploading {
                    Text(session.localized("settings.files.uploading"))
                        .font(.system(size: 9.5, design: .monospaced)).foregroundStyle(theme.inkMute)
                } else if let s = library?.summary, s.count > 0 {
                    Text("\(s.count) · \(formatBytes(s.size_bytes)) / \(formatBytes(s.quota_bytes))")
                        .font(.system(size: 9.5, design: .monospaced)).foregroundStyle(theme.inkMute)
                        .lineLimit(1)
                }
            }

            if rows.isEmpty {
                emptyZone
            } else {
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(rows) { row in treeRow(row) }
                    }
                    .padding(5)
                }
                .background(theme.surfaceAlt, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(panelTargeted ? accent : theme.rule, lineWidth: panelTargeted ? 1.2 : 0.5))
                #if os(macOS)
                // The whole panel is a standing drop target; dropping on empty space
                // files at the top level (folder rows capture their own drops).
                .dropDestination(for: URL.self) { urls, _ in
                    Task { await upload(urls, into: nil) }; return true
                } isTargeted: { panelTargeted = $0 }
                #endif

                SetCaption(session.localized("settings.files.caption"))
            }
        }
        // The detail pane already insets content (.horizontal 18); don't double it.
        .task { await load() }
        .fileImporter(isPresented: $showImporter, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            Task { await upload(urls, into: nil) }
        }
        .alert(session.localized("settings.files.newfolder"), isPresented: $showNewFolder) {
            TextField(session.localized("settings.files.folder_name"), text: $newFolderName)
            Button(L("common.cancel"), role: .cancel) {}
            Button(L("common.create")) { Task { await createFolder() } }
        }
        .alert(session.localized("settings.files.rename"),
               isPresented: Binding(get: { renameTarget != nil }, set: { if !$0 { renameTarget = nil } })) {
            TextField(session.localized("settings.files.folder_name"), text: $renameText)
            Button(L("common.cancel"), role: .cancel) { renameTarget = nil }
            Button(L("common.save")) { Task { await commitRename() } }
        }
    }

    // MARK: toolbar + empty state

    private func toolbarButton(icon: String, label: String, accent: Bool, action: @escaping () -> Void) -> some View {
        let tint = accent ? self.accent : theme.inkSoft
        return Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: icon).font(.system(size: 13))
                Text(label).font(.system(size: 11.5, weight: accent ? .medium : .regular))
            }
            .foregroundStyle(tint)
            .padding(.leading, 9).padding(.trailing, 11).padding(.vertical, 5)
            .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous)
                .strokeBorder(tint.opacity(accent ? 1 : 0.55), style: StrokeStyle(lineWidth: 0.5, dash: [3])))
        }
        .buttonStyle(.plain)
        .disabled(uploading)
    }

    // Empty: the panel itself is one full-width drop zone — no separate card.
    private var emptyZone: some View {
        VStack(spacing: 10) {
            ZStack {
                Circle().fill(theme.surfaceAlt).frame(width: 44, height: 44)
                Image(systemName: "arrow.up.doc").font(.system(size: 18)).foregroundStyle(theme.inkSoft)
            }
            Text(session.localized("settings.files.empty.title"))
                .font(.system(size: 13.5, weight: .medium)).foregroundStyle(theme.ink)
            accentCaption(emptyPrompt)
                .font(.system(size: 11.5)).foregroundStyle(theme.inkSoft)
                .multilineTextAlignment(.center)
            Text(session.localized("settings.files.empty.hint"))
                .font(.system(size: 9.5, design: .monospaced)).foregroundStyle(theme.inkMute)
                .multilineTextAlignment(.center).lineSpacing(2)
        }
        .padding(.horizontal, 28)
        .frame(maxWidth: .infinity)
        .frame(minHeight: 300)
        .background(theme.surfaceAlt.opacity(panelTargeted ? 0.5 : 0), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(panelTargeted ? accent : theme.ruleHard,
                          style: StrokeStyle(lineWidth: panelTargeted ? 1.4 : 1.2, dash: [4])))
        .contentShape(Rectangle())
        .onTapGesture { showImporter = true }
        #if os(macOS)
        .dropDestination(for: URL.self) { urls, _ in
            Task { await upload(urls, into: nil) }; return true
        } isTargeted: { panelTargeted = $0 }
        #endif
    }

    // iOS is tap-only (no external drag); macOS invites a drop.
    private var emptyPrompt: String {
        #if os(macOS)
        return session.localized("settings.files.empty.drop")
        #else
        return session.localized("settings.files.empty.tap")
        #endif
    }

    /// Render a localized markdown string, tinting **bold** runs with the accent.
    private func accentCaption(_ markdown: String) -> Text {
        guard var s = try? AttributedString(markdown: markdown) else { return Text(markdown) }
        for run in s.runs where run.inlinePresentationIntent == .stronglyEmphasized {
            s[run.range].foregroundColor = accent
        }
        return Text(s)
    }

    // MARK: rows

    private var rows: [LibRow] {
        guard let lib = library else { return [] }
        func childFolders(_ pid: String?) -> [LibraryFolder] { lib.folders.filter { $0.parent_id == pid }.sorted { $0.name < $1.name } }
        func childFiles(_ fid: String?) -> [LibraryFile] { lib.files.filter { $0.folder_id == fid }.sorted { $0.name < $1.name } }
        var out: [LibRow] = []
        func walk(_ folderId: String?, _ depth: Int) {
            for f in childFolders(folderId) {
                let count = childFolders(f.id).count + childFiles(f.id).count
                out.append(LibRow(id: f.id, kind: .folder(f, count: count), depth: depth))
                if !collapsed.contains(f.id) { walk(f.id, depth + 1) }
            }
            for file in childFiles(folderId) { out.append(LibRow(id: file.id, kind: .file(file), depth: depth)) }
        }
        walk(nil, 0)
        return out
    }

    @ViewBuilder private func treeRow(_ row: LibRow) -> some View {
        switch row.kind {
        case .folder(let f, let count):
            let targeted = dropFolderId == f.id
            HStack(spacing: 7) {
                Button { toggle(f.id) } label: {
                    Image(systemName: collapsed.contains(f.id) ? "chevron.right" : "chevron.down")
                        .font(.system(size: 9, weight: .semibold)).foregroundStyle(theme.inkMute).frame(width: 12)
                }.buttonStyle(.plain)
                Image(systemName: "folder").font(.system(size: 12)).foregroundStyle(targeted ? accent : theme.inkSoft)
                Text(f.name).font(.system(size: 13, weight: .medium)).foregroundStyle(theme.ink).lineLimit(1)
                Spacer(minLength: 4)
                if targeted {
                    Text(session.localized("settings.files.dropHere"))
                        .font(.system(size: 9.5, design: .monospaced)).foregroundStyle(accent.legible(onDark: theme.isDark))
                } else {
                    Text("\(count)").font(.system(size: 9.5, design: .monospaced)).foregroundStyle(theme.inkMute)
                }
            }
            .padding(.leading, CGFloat(row.depth) * 16).padding(.horizontal, 4).frame(minHeight: 30)
            .background(targeted ? accent.opacity(0.10) : .clear, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .overlay(targeted ? RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(accent, lineWidth: 1.2) : nil)
            .contentShape(Rectangle())
            #if os(macOS)
            // Dropping a file on a folder row files it there (filing-at-birth).
            .dropDestination(for: URL.self) { urls, _ in
                Task { await upload(urls, into: f.id) }; return true
            } isTargeted: { dropFolderId = $0 ? f.id : (dropFolderId == f.id ? nil : dropFolderId) }
            #endif
            .contextMenu {
                Button(session.localized("settings.files.rename")) { startRename(f.id, true, f.name) }
                Button(role: .destructive) { Task { await deleteFolder(f.id) } } label: { Text(L("sidebar.delete")) }
            }
        case .file(let file):
            let sel = selectedFileId == file.id
            Button { selectedFileId = sel ? nil : file.id } label: {
                HStack(spacing: 7) {
                    Spacer().frame(width: 12)
                    Image(systemName: "doc").font(.system(size: 12)).foregroundStyle(theme.inkMute)
                    Text(file.name).font(.system(size: 11, design: .monospaced)).foregroundStyle(theme.ink).lineLimit(1)
                    extTag(file)
                    Spacer(minLength: 4)
                    if sel {
                        HStack(spacing: 12) {
                            Button { startRename(file.id, false, file.name) } label: { Image(systemName: "pencil") }
                                .buttonStyle(.plain).foregroundStyle(theme.inkSoft)
                            Button { Task { await deleteFile(file.id) } } label: { Image(systemName: "trash") }
                                .buttonStyle(.plain).foregroundStyle(.red.opacity(0.85))
                        }.font(.system(size: 12))
                    } else {
                        Text(formatBytes(file.size_bytes)).font(.system(size: 9.5, design: .monospaced)).foregroundStyle(theme.inkMute)
                    }
                }
                .padding(.leading, CGFloat(row.depth) * 16).padding(.horizontal, 4).frame(minHeight: 30)
                .background(sel ? accent.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                .contentShape(Rectangle())
            }.buttonStyle(.plain)
        }
    }

    private func extTag(_ file: LibraryFile) -> some View {
        let ext = (file.name as NSString).pathExtension
        return Text(ext.isEmpty ? file.kind : ext)
            .font(.system(size: 8.5, design: .monospaced)).foregroundStyle(theme.inkMute)
            .padding(.horizontal, 4).frame(height: 13)
            .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(theme.rule, lineWidth: 0.5))
    }

    // MARK: actions

    private func toggle(_ id: String) { if collapsed.contains(id) { collapsed.remove(id) } else { collapsed.insert(id) } }
    private func startRename(_ id: String, _ isFolder: Bool, _ current: String) {
        renameText = current; renameTarget = RenameTarget(id: id, isFolder: isFolder)
    }

    private func load() async {
        guard let api, let resp: LibraryResponse = try? await api.get("/api/files", token: token) else { return }
        library = resp
    }

    /// Upload one or more picked/dropped documents into `folderId` (nil = root).
    private func upload(_ urls: [URL], into folderId: String?) async {
        guard let api, !urls.isEmpty else { return }
        uploading = true
        defer { uploading = false }
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { continue }
            var fields: [String: String] = [:]
            if let folderId { fields["folder_id"] = folderId }
            let _: LibraryFile? = try? await api.upload(
                "/api/files/upload", fileName: url.lastPathComponent, fileData: data, fields: fields, token: token)
        }
        await load()
    }
    private func createFolder() async {
        let name = newFolderName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, let api else { return }
        let _: LibraryFolder? = try? await api.post("/api/files/folder", body: NewFolderBody(parent_id: nil, name: name), token: token)
        await load()
    }
    private func deleteFolder(_ id: String) async { guard let api else { return }; try? await api.delete("/api/files/folder/\(id)", token: token); await load() }
    private func deleteFile(_ id: String) async {
        guard let api else { return }; try? await api.delete("/api/files/\(id)", token: token); selectedFileId = nil; await load()
    }
    private func commitRename() async {
        guard let t = renameTarget, let api else { return }
        let name = renameText.trimmingCharacters(in: .whitespaces)
        defer { renameTarget = nil }
        guard !name.isEmpty else { return }
        if t.isFolder { let _: LibraryFolder? = try? await api.patch("/api/files/folder/\(t.id)", body: RenameBody(name: name), token: token) }
        else { let _: LibraryFile? = try? await api.patch("/api/files/\(t.id)", body: RenameBody(name: name), token: token) }
        await load()
    }
}

// MARK: - Safety / report-a-concern (out-of-band, routes outward)

/// The out-of-band safety channel. These link OUT to parties who can act
/// (Apple, child-safety authorities); the publisher contact is the app contact,
/// not an abuse desk. In-room member↔member reporting lives in the message menu.
struct SafetySettingsView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("In a shared room, open a message's menu to report it to this server's operator, or to block a member. To stop receiving a room, use the room menu's Leave — that works regardless of the operator.")
                        .font(.callout)
                } header: { Text("In a room") }

                Section {
                    Link(destination: SafetyLinks.appleReport) {
                        Label("This app or server is harming people — report to Apple", systemImage: "exclamationmark.bubble")
                    }
                } header: { Text("Report the server or app") } footer: {
                    Text("Apple controls distribution and can act on the app itself.")
                }

                Section {
                    Link(destination: SafetyLinks.childSafetyBE) {
                        Label("Child Focus — Belgium (stopchildporno.be)", systemImage: "shield.lefthalf.filled")
                    }
                    Link(destination: SafetyLinks.ncmecUS) {
                        Label("NCMEC CyberTipline — United States", systemImage: "shield.lefthalf.filled")
                    }
                } header: { Text("Child safety") } footer: {
                    Text("Content involving a minor: report to the proper authority — they can act in ways an operator can't. Outside Belgium or the US, contact your local equivalent.")
                }

                Section {
                    if let url = URL(string: "mailto:\(SafetyLinks.publisherContact)") {
                        Link(SafetyLinks.publisherContact, destination: url)
                    }
                } header: { Text("App contact") } footer: {
                    Text("Questions about the Chez Maurice app itself. This is the publisher's contact, not an abuse desk — for abuse, use the options above.")
                }

                Section {
                    Link("Terms of Use", destination: SafetyLinks.terms)
                    Link("Privacy Policy", destination: SafetyLinks.privacy)
                } header: { Text("Legal") }
            }
            .navigationTitle("Safety")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
    }
}
