import SwiftUI
import UniformTypeIdentifiers

// "My data" — a pane of the settings (3 October 2026): what the GDPR gives a
// person over what a household's server holds of them. Take it all away as
// one file, bring such a file back in, erase everything and keep the account,
// or leave. Each is the member's own gesture, about themselves: the admin has
// no button for someone else's conversations. The server's side is
// services/memberArchive.ts and services/memberErase.ts (docs/member-data.md).

private struct MemberImportAnswer: Decodable {
    struct Report: Decodable {
        let conversations: Int
        let messages: Int
        let rows: Int
        let files: Int
        let notes: Int
    }
    let report: Report
}

private struct EraseAnswer: Decodable {
    struct Residual: Decodable {
        let garden_remotes: [String]
        let published_site: Bool
        let household_archives: Int
    }
    let scope: String
    let corpus: Bool
    let residual: Residual
}

private struct EraseRequest: Encodable {
    let scope: String
    let confirm: String
    let password: String?
    let pin: String?
}

private enum EraseScope: String, Identifiable {
    case data, account
    var id: String { rawValue }
}

struct MyDataView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.mauriceTheme) private var theme
    let accent: Color
    /// Closes the settings — after the account is gone there is nothing left to show.
    let close: () -> Void

    private enum ExportPhase: Equatable { case idle, preparing, ready, failed(String) }
    private enum ImportPhase: Equatable { case idle, uploading, done(String), failed(String) }

    @State private var exportPhase: ExportPhase = .idle
    @State private var exported: URL?
    @State private var showMover = false
    @State private var importPhase: ImportPhase = .idle
    @State private var showPicker = false
    @State private var erasing: EraseScope?
    @State private var erased: EraseAnswer?

    private var api: APIClient? { session.serverURL.map { APIClient(baseURL: $0) } }
    private var token: String? { session.tokenForActiveUser }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(session.localized("mydata.caption"))
                .font(.system(size: 12.5)).foregroundStyle(theme.inkSoft).lineSpacing(2)

            card(title: session.localized("mydata.export.title"), text: session.localized("mydata.export.text")) {
                action(icon: "square.and.arrow.up", label: session.localized("mydata.export.button"),
                       busy: exportPhase == .preparing) { Task { await export() } }
                switch exportPhase {
                case .failed(let why): line(session.localized("mydata.failed", why), bad: true)
                case .ready: line(session.localized("mydata.export.done"), ok: true)
                case .preparing: line(session.localized("mydata.export.preparing"))
                case .idle: EmptyView()
                }
            }
            .fileMover(isPresented: $showMover, file: exported) { result in
                if case .success = result { exportPhase = .ready } else { exportPhase = .idle }
                exported = nil
            }

            card(title: session.localized("mydata.import.title"), text: session.localized("mydata.import.text")) {
                action(icon: "square.and.arrow.down", label: session.localized("mydata.import.button"),
                       busy: importPhase == .uploading) { showPicker = true }
                switch importPhase {
                case .failed(let why): line(session.localized("mydata.failed", why), bad: true)
                case .done(let what): line(what, ok: true)
                case .uploading: line(session.localized("mydata.import.uploading"))
                case .idle: EmptyView()
                }
            }
            .fileImporter(isPresented: $showPicker, allowedContentTypes: [.gzip, .data], allowsMultipleSelection: false) { result in
                guard case .success(let urls) = result, let url = urls.first else { return }
                Task { await upload(url) }
            }

            card(title: session.localized("mydata.erase.title"), text: session.localized("mydata.erase.text")) {
                action(icon: "eraser", label: session.localized("mydata.erase.button"), destructive: true) { erasing = .data }
                if let erased, erased.scope == "data" { residual(erased) }
            }

            card(title: session.localized("mydata.delete.title"), text: session.localized("mydata.delete.text")) {
                action(icon: "person.crop.circle.badge.xmark", label: session.localized("mydata.delete.button"), destructive: true) { erasing = .account }
            }

            Text(session.localized("mydata.backups"))
                .font(.system(size: 11.5)).foregroundStyle(theme.inkMute).lineSpacing(1)
        }
        .sheet(item: $erasing) { scope in
            EraseConfirmSheet(scope: scope, accent: accent) { answer in
                erasing = nil
                if scope == .account {
                    if let uid = session.activeUserId { session.logoutUser(uid) }
                    close()
                } else {
                    erased = answer
                }
            }
        }
    }

    // MARK: - Pieces

    private func card<Content: View>(title: String, text: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.system(size: 13.5, weight: .medium)).foregroundStyle(theme.ink)
            Text(text).font(.system(size: 11.5)).foregroundStyle(theme.inkSoft).lineSpacing(1)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(theme.surfaceAlt, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(theme.rule, lineWidth: 0.5))
    }

    private func action(icon: String, label: String, busy: Bool = false, destructive: Bool = false, run: @escaping () -> Void) -> some View {
        let tint: Color = destructive ? .red.opacity(0.85) : accent.legible(onDark: theme.isDark)
        return Button(action: run) {
            HStack(spacing: 6) {
                if busy { ProgressView().controlSize(.small) }
                Image(systemName: icon).font(.system(size: 12))
                Text(label).font(.system(size: 12, weight: .medium))
            }
            .foregroundStyle(tint)
            .padding(.horizontal, 12).padding(.vertical, 6)
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(tint.opacity(0.8), lineWidth: 0.5))
        }
        .buttonStyle(.plain)
        .disabled(busy)
    }

    private func line(_ text: String, ok: Bool = false, bad: Bool = false) -> some View {
        Text(text).font(.system(size: 11.5)).foregroundStyle(bad ? .red : ok ? .green : theme.inkSoft)
    }

    /// What the server could not reach, said plainly.
    @ViewBuilder private func residual(_ a: EraseAnswer) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            line(session.localized("mydata.erase.done"), ok: true)
            if !a.corpus { line(session.localized("mydata.residual.corpus")) }
            ForEach(a.residual.garden_remotes, id: \.self) { remote in
                line(session.localized("mydata.residual.remote", remote))
            }
            if a.residual.published_site { line(session.localized("mydata.residual.site")) }
            if a.residual.household_archives > 0 { line(session.localized("mydata.residual.archives", a.residual.household_archives)) }
        }
    }

    // MARK: - Work

    private func export() async {
        guard let api, let token else { return }
        exportPhase = .preparing
        do {
            exported = try await api.download("/api/me/export", token: token, fallbackName: "maurice-member.tar.gz")
            exportPhase = .idle
            showMover = true
        } catch {
            exportPhase = .failed(error.localizedDescription)
        }
    }

    private func upload(_ url: URL) async {
        guard let api, let token else { return }
        importPhase = .uploading
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { importPhase = .failed("read"); return }
        do {
            let a: MemberImportAnswer = try await api.upload("/api/me/import", fileName: url.lastPathComponent, fileData: data, token: token)
            importPhase = .done(session.localized("mydata.import.done", a.report.conversations, a.report.files, a.report.notes))
        } catch APIError.server(let code, let message) {
            importPhase = .failed(code == 409 ? session.localized("mydata.import.already") : message)
        } catch {
            importPhase = .failed(error.localizedDescription)
        }
    }
}

/// The last step before an erasure: the username typed, the password or PIN
/// asked again. Nothing is sent until both are there.
private struct EraseConfirmSheet: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.mauriceTheme) private var theme
    @Environment(\.dismiss) private var dismiss
    let scope: EraseScope
    let accent: Color
    let done: (EraseAnswer) -> Void

    @State private var confirm = ""
    @State private var secret = ""
    @State private var busy = false
    @State private var failure: String?

    private var username: String { session.activeDeviceUser?.username ?? "" }
    private var ready: Bool { !busy && !username.isEmpty && confirm.trimmingCharacters(in: .whitespaces) == username }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(session.localized(scope == .account ? "mydata.delete.title" : "mydata.erase.title"))
                .font(.system(size: 16, weight: .semibold)).foregroundStyle(theme.ink)
            Text(session.localized(scope == .account ? "mydata.confirm.account" : "mydata.confirm.data"))
                .font(.system(size: 12.5)).foregroundStyle(theme.inkSoft).lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: 6) {
                Text(session.localized("mydata.confirm.type", username))
                    .font(.system(size: 11.5)).foregroundStyle(theme.inkSoft)
                TextField(username, text: $confirm)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
                SecureField(session.localized("mydata.confirm.secret"), text: $secret)
                    .textFieldStyle(.roundedBorder)
            }

            if let failure {
                Text(failure).font(.system(size: 11.5)).foregroundStyle(.red)
            }

            HStack {
                Button(session.localized("mydata.confirm.cancel")) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Spacer()
                Button(role: .destructive) { Task { await erase() } } label: {
                    HStack(spacing: 6) {
                        if busy { ProgressView().controlSize(.small) }
                        Text(session.localized(scope == .account ? "mydata.delete.button" : "mydata.erase.button"))
                    }
                }
                .disabled(!ready)
            }
        }
        .padding(22)
        .frame(minWidth: 320, idealWidth: 420)
        .presentationDetents([.medium, .large])
    }

    private func erase() async {
        guard let url = session.serverURL, let token = session.tokenForActiveUser else { return }
        busy = true
        failure = nil
        defer { busy = false }
        let body = EraseRequest(scope: scope.rawValue, confirm: confirm.trimmingCharacters(in: .whitespaces),
                                password: secret.isEmpty ? nil : secret, pin: secret.isEmpty ? nil : secret)
        do {
            // An erasure rewrites the night's snapshots too: give it the time.
            let answer: EraseAnswer = try await APIClient(baseURL: url).post("/api/me/erase", body: body, token: token, timeout: 600)
            done(answer)
        } catch APIError.server(_, let code) {
            let key = "mydata.error.\(code)"
            let text = session.localized(key)
            failure = text == key ? code : text
        } catch {
            failure = error.localizedDescription
        }
    }
}
