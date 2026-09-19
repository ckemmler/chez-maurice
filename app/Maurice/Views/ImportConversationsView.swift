import SwiftUI
import UniformTypeIdentifiers

// "Import my conversations" — a pane of the settings (P4 of the domains'
// roadmap, 19 September 2026), never a step of the onboarding: the member
// brings the data export of ChatGPT or Claude, the server's importer turns
// it into conversations of theirs (badged by origin, searchable), and the
// night after, Maurice reads them and may propose their domains. One card
// per provider: where the export comes from, what was synced, the button,
// live progress while the corpus parses and indexes.

struct ImportRun: Decodable, Identifiable {
    let id: String
    let provider: String
    let range_from: String?
    let range_to: String?
    let conversations: Int
    let messages: Int
    let ran_at: String
    let status: String
}

struct ImportHistory: Decodable {
    let provider: String
    let watermark: String?
    let history: [ImportRun]
}

private struct ImportJob: Decodable { let job_id: String; let provider: String }

private struct ImportStatus: Decodable {
    struct Result: Decodable { let conversations: Int; let messages: Int }
    let phase: String?
    let done: Int?
    let total: Int?
    let status: String?
    let error: String?
    let result: Result?
}

enum ImportProvider: String, CaseIterable, Identifiable {
    case anthropic, chatgpt
    var id: String { rawValue }
    var label: String { self == .anthropic ? "Claude" : "ChatGPT" }
}

/// What the settings index shows beside the row, kept by the parent so the
/// value survives leaving the pane.
struct ImportSummary {
    var histories: [ImportProvider: ImportHistory] = [:]
    var synced: Bool { histories.values.contains { $0.watermark != nil } }
}

struct ImportConversationsView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.mauriceTheme) private var theme
    let accent: Color
    @Binding var summary: ImportSummary

    private var api: APIClient? { session.serverURL.map { APIClient(baseURL: $0) } }
    private var token: String? { session.tokenForActiveUser }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(session.localized("settings.import.caption"))
                .font(.system(size: 12.5)).foregroundStyle(theme.inkSoft).lineSpacing(2)
            ForEach(ImportProvider.allCases) { provider in
                ImportProviderCard(provider: provider, accent: accent,
                                   history: summary.histories[provider],
                                   reload: { await load(provider) })
            }
            Text(session.localized("settings.import.night"))
                .font(.system(size: 11.5)).foregroundStyle(theme.inkMute).lineSpacing(1)
        }
        .task { for p in ImportProvider.allCases { await load(p) } }
    }

    private func load(_ provider: ImportProvider) async {
        guard let api, let token else { return }
        if let h: ImportHistory = try? await api.get("/api/import/history?provider=\(provider.rawValue)", token: token) {
            summary.histories[provider] = h
        }
    }
}

/// Loads the histories for the settings index without opening the pane.
extension ImportSummary {
    static func load(session: SessionStore) async -> ImportSummary {
        var s = ImportSummary()
        guard let url = session.serverURL, let token = session.tokenForActiveUser else { return s }
        let api = APIClient(baseURL: url)
        for p in ImportProvider.allCases {
            if let h: ImportHistory = try? await api.get("/api/import/history?provider=\(p.rawValue)", token: token) {
                s.histories[p] = h
            }
        }
        return s
    }
}

private struct ImportProviderCard: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.mauriceTheme) private var theme
    let provider: ImportProvider
    let accent: Color
    let history: ImportHistory?
    let reload: () async -> Void

    private enum Phase: Equatable { case idle, uploading, parsing, indexing(Int, Int), done(Int, Int), failed(String) }
    @State private var phase: Phase = .idle
    @State private var showPicker = false

    private var api: APIClient? { session.serverURL.map { APIClient(baseURL: $0) } }
    private var token: String? { session.tokenForActiveUser }
    private var busy: Bool {
        switch phase { case .uploading, .parsing, .indexing: return true; default: return false }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text(provider.label).font(.system(size: 13.5, weight: .medium)).foregroundStyle(theme.ink)
                Spacer(minLength: 8)
                Text(statusLine).font(.system(size: 10, design: .monospaced)).foregroundStyle(theme.inkMute)
            }
            Text(session.localized("settings.import.intro", provider.label, session.localized("settings.import.source.\(provider.rawValue)")))
                .font(.system(size: 11.5)).foregroundStyle(theme.inkSoft).lineSpacing(1)

            if let h = history, !h.history.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(h.history.prefix(3)) { run in
                        HStack(spacing: 8) {
                            Circle().fill(run.status == "done" ? Color.green.opacity(0.7) : run.status == "failed" ? Color.red.opacity(0.7) : Color.orange.opacity(0.7))
                                .frame(width: 6, height: 6)
                            Text(session.localized("settings.import.run", run.conversations, run.messages))
                                .font(.system(size: 10.5, design: .monospaced)).foregroundStyle(theme.inkMute)
                            Spacer(minLength: 4)
                            Text(day(run.ran_at)).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(theme.inkMute)
                        }
                    }
                }
            }

            progress

            Button { showPicker = true } label: {
                HStack(spacing: 6) {
                    if busy { ProgressView().controlSize(.small) }
                    Image(systemName: "square.and.arrow.down").font(.system(size: 12))
                    Text(session.localized(history?.watermark == nil ? "settings.import.choose" : "settings.import.choose_more"))
                        .font(.system(size: 12, weight: .medium))
                }
                .foregroundStyle(accent.legible(onDark: theme.isDark))
                .padding(.horizontal, 12).padding(.vertical, 6)
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(accent.opacity(0.8), lineWidth: 0.5))
            }
            .buttonStyle(.plain)
            .disabled(busy)
            .fileImporter(isPresented: $showPicker, allowedContentTypes: [.zip], allowsMultipleSelection: false) { result in
                guard case .success(let urls) = result, let url = urls.first else { return }
                Task { await upload(url) }
            }
        }
        .padding(14)
        .background(theme.surfaceAlt, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(theme.rule, lineWidth: 0.5))
    }

    @ViewBuilder private var progress: some View {
        switch phase {
        case .idle: EmptyView()
        case .uploading: line(session.localized("settings.import.uploading"))
        case .parsing: line(session.localized("settings.import.parsing"))
        case .indexing(let done, let total): line(session.localized("settings.import.indexing", done, total))
        case .done(let c, let m): line(c == 0 ? session.localized("settings.import.done_none") : session.localized("settings.import.done", c, m), ok: true)
        case .failed(let why): line(session.localized("settings.import.failed", why), bad: true)
        }
    }

    private func line(_ text: String, ok: Bool = false, bad: Bool = false) -> some View {
        Text(text).font(.system(size: 11.5)).foregroundStyle(bad ? .red : ok ? .green : theme.inkSoft)
    }

    private var statusLine: String {
        if let wm = history?.watermark { return session.localized("settings.import.synced_through", day(wm)) }
        return session.localized("settings.import.never")
    }

    private func day(_ iso: String) -> String {
        let s = iso.replacingOccurrences(of: " ", with: "T")
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let d = f.date(from: s) ?? { f.formatOptions = [.withInternetDateTime]; return f.date(from: s) }()
            ?? { f.formatOptions = [.withFullDate]; return f.date(from: String(s.prefix(10))) }()
        guard let d else { return String(iso.prefix(10)) }
        return d.formatted(date: .abbreviated, time: .omitted)
    }

    private func upload(_ url: URL) async {
        guard let api, let token else { return }
        guard url.pathExtension.lowercased() == "zip" else { phase = .failed(session.localized("settings.import.not_zip")); return }
        phase = .uploading
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { phase = .failed("read"); return }
        do {
            let job: ImportJob = try await api.upload("/api/import?provider=\(provider.rawValue)", fileName: url.lastPathComponent, fileData: data, token: token)
            phase = .parsing
            await poll(job.job_id)
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    private func poll(_ jobId: String) async {
        guard let api, let token else { return }
        for _ in 0..<2000 {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard let s: ImportStatus = try? await api.get("/api/import/status?job=\(jobId)", token: token) else { continue }
            if s.status == "failed" { phase = .failed(s.error ?? "?"); await reload(); return }
            if s.status == "done" { phase = .done(s.result?.conversations ?? 0, s.result?.messages ?? 0); await reload(); return }
            if s.phase == "indexing" { phase = .indexing(s.done ?? 0, s.total ?? 0) }
        }
    }
}
