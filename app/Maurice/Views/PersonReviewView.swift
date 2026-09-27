import SwiftUI
import MarkdownUI

// The member's word on a person fiche, in the app (27 September 2026).
//
// The mail pass writes what it read about a person — who they are to the
// member, their addresses, what is going on — into their fiche in the garden,
// pending until the member says it holds (specs/contacts.md, lots 3 and 4).
// The web garden had the page for that; this is the same page, native:
// ✓ confirm, ✗ reject, ✎ correct, element by element, and "confirm all".
//
// Nothing is decided here. Every gesture goes to the server
// (`POST /api/people/:locale/:basename/review`, services/personReview.ts),
// which writes the fiche and its fragments as markdown in the garden and
// commits them: what the member sees in Obsidian or on the web is what this
// screen changed, and a correction is the member's own markdown.
//
// Two ways in: the "À vérifier" card under a reply (`ReviewCard`), and the
// footer's links in older replies, which the chat now opens here instead of
// in the browser.

/// A person fiche, by where it lives: `people/<locale>/<basename>.md`, and the
/// element to scroll to (`relation`, `identity-2`, `fragment-003`, `review`).
struct PersonRef: Identifiable, Hashable {
    let locale: String
    let basename: String
    var anchor: String? = nil
    var id: String { "\(locale)/\(basename)" }

    /// A link into the web garden's fiche page — `/g/<member>/<locale>/fiches/people/<basename>#anchor` — or nil.
    init?(gardenURL url: URL) {
        let parts = url.path.split(separator: "/").map(String.init)
        guard parts.count >= 6, parts[0] == "g", parts[3] == "fiches", parts[4] == "people" else { return nil }
        let base = parts[5].hasSuffix("-fiche") ? parts[5] : "\(parts[5])-fiche"
        self.init(locale: parts[2], basename: base, anchor: url.fragment)
    }

    init(locale: String, basename: String, anchor: String? = nil) {
        self.locale = locale
        self.basename = basename
        self.anchor = anchor
    }
}

// MARK: - The fiche, as the server describes it (services/personReview.ts, personView)

struct PersonReviewModel: Decodable, Equatable {
    struct Relation: Decodable, Equatable {
        let text: String?
        let status: String?
        let since: String?
        let until: String?
        let edited: Bool?
    }
    struct Identity: Decodable, Equatable {
        let address: String
        let mailboxes: [String]
        let status: String
        let source: String
        let conflict: String?
    }
    struct Fragment: Decodable, Equatable, Identifiable {
        let id: String
        let summary: String
        let status: String
        let origin: String?
        let address: String?
        let mailbox: String?
        let body: String
        let edited: Bool?
    }
    let title: String
    let locale: String
    let basename: String
    let status: String
    let byMaurice: Bool
    let relation: Relation
    let identities: [Identity]
    let fragments: [Fragment]
    let exchanges: String?
    let pending: Int
}

private struct ReviewRequest: Encodable {
    let target: String
    let action: String
    let id: String?
    let text: String?
}

private struct ReviewResponse: Decodable {
    let ok: Bool
    let view: PersonReviewModel?
}

private struct GardenTokenRequest: Encodable { let rotate: Bool }

// MARK: - Opening the garden signed in

/// Open a path of this household's server in the browser, signed in — through
/// `/login?token=…&to=…`, as the garden buttons do.
@MainActor
func openInGarden(_ path: String, session: SessionStore) async {
    guard let server = session.serverURL else { return }
    var target = URL(string: server + path)
    if let token = await gardenToken(session: session) {
        var cs = CharacterSet.alphanumerics
        cs.insert(charactersIn: "-._~")
        if let to = path.addingPercentEncoding(withAllowedCharacters: cs) {
            target = URL(string: "\(server)/login?token=\(token)&to=\(to)") ?? target
        }
    }
    guard let url = target else { return }
    #if os(iOS)
    await UIApplication.shared.open(url)
    #elseif os(macOS)
    NSWorkspace.shared.open(url)
    #endif
}

@MainActor
private func gardenToken(session: SessionStore) async -> String? {
    guard let userId = session.activeUserId else { return nil }
    if let cached = session.mcpToken(for: userId) { return cached }
    guard let s = session.serverURL, let t = session.tokenForActiveUser else { return nil }
    if let resp: McpTokenResponse = try? await APIClient(baseURL: s).post(
        "/api/users/me/mcp-token", body: GardenTokenRequest(rotate: false), token: t) {
        session.saveMcpToken(resp.rawToken, for: userId)
        return resp.rawToken
    }
    return nil
}

/// The links a fiche carries: `maurice-mail:<id>` opens the message it came
/// from (`/api/people/mail/:id`), a garden link opens signed in, anything else
/// as the system would.
@MainActor
private func ficheLink(_ url: URL, session: SessionStore) -> OpenURLAction.Result {
    if url.scheme == "maurice-mail" {
        let id = url.absoluteString.dropFirst("maurice-mail:".count)
        let enc = String(id).removingPercentEncoding ?? String(id)
        var cs = CharacterSet.alphanumerics
        cs.insert(charactersIn: "-._~")
        let path = "/api/people/mail/\(enc.addingPercentEncoding(withAllowedCharacters: cs) ?? enc)"
        Task { await openInGarden(path, session: session) }
        return .handled
    }
    if let s = session.serverURL, let server = URL(string: s), url.host == server.host {
        var path = url.path
        if let f = url.fragment { path += "#\(f)" }
        Task { await openInGarden(path, session: session) }
        return .handled
    }
    return .systemAction
}

/// The reply without the "À vérifier" footer's text, when the reply also
/// carries it as a block the app draws (`ReviewCard`): the block says the
/// same, and says it as something to act on. The text stays in the stored
/// message — the garden and the other clients read it.
func withoutReviewFooter(_ text: String, blocks: [DataBlock]) -> String {
    guard let block = blocks.first(where: { $0.data.cardKind == "review" }) else { return text }
    let footer = block.data.string("footer")
    guard !footer.isEmpty, let r = text.range(of: footer, options: .backwards) else { return text }
    var out = text
    out.removeSubrange(r)
    return out.trimmingCharacters(in: .whitespacesAndNewlines)
}

// MARK: - The card under a reply

/// What the reply rested on that the member has not confirmed yet, one row
/// per person; a tap opens the fiche. A row whose fiche has nothing left to
/// check says so. Drawn from the `review` block the server adds to the turn
/// (services/reviewFooter.ts, takeReview).
struct ReviewCard: View {
    @Environment(\.mauriceTheme) private var theme
    @Environment(SessionStore.self) private var session
    let data: JSONValue

    @State private var open: PersonRef?
    /// What is still pending per fiche, once the member has been in it.
    @State private var left: [String: Int] = [:]

    private struct Row: Identifiable {
        let ref: PersonRef
        let title: String
        let labels: [String]
        var id: String { ref.id }
    }

    private var rows: [Row] {
        (data["fiches"]?.arrayValue ?? []).compactMap { f in
            let locale = f.string("locale"), basename = f.string("basename")
            guard !locale.isEmpty, !basename.isEmpty else { return nil }
            let labels = (f["items"]?.arrayValue ?? []).map { $0.string("label") }
            return Row(ref: PersonRef(locale: locale, basename: basename), title: f.string("title"), labels: labels)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "checkmark.seal").font(.system(size: 11))
                Text(L("review.heading")).font(.system(size: 12, weight: .medium))
            }
            .foregroundStyle(theme.inkSoft)

            ForEach(rows) { row in
                Button { open = row.ref } label: { rowLabel(row) }
                    .buttonStyle(.plain)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(theme.inkMute.opacity(0.06)))
        .sheet(item: $open) { ref in
            PersonReviewView(ref: ref) { model in
                left[ref.id] = model?.pending ?? 0
            }
            .environment(session)
        }
    }

    private func rowLabel(_ row: Row) -> some View {
        let remaining = left[row.id] ?? row.labels.count
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: remaining == 0 ? "checkmark.circle.fill" : "person.crop.circle")
                .font(.system(size: 13))
                .foregroundStyle(remaining == 0 ? theme.inkMute : theme.inkSoft)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title).font(.system(size: 14, weight: .medium)).foregroundStyle(theme.ink)
                Text(summary(row, remaining: remaining))
                    .font(.system(size: 12)).foregroundStyle(theme.inkMute)
                    .lineLimit(2)
            }
            Spacer(minLength: 4)
            Image(systemName: "chevron.right").font(.system(size: 11)).foregroundStyle(theme.inkMute)
        }
        .contentShape(Rectangle())
    }

    private func summary(_ row: Row, remaining: Int) -> String {
        if remaining == 0 { return L("review.all_checked") }
        if left[row.id] == nil, row.labels.count == 1 { return row.labels[0] }
        return remaining == 1 ? L("review.one_item") : L("review.items", remaining)
    }
}

// MARK: - The fiche

struct PersonReviewView: View {
    @Environment(\.mauriceTheme) private var theme
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss

    let ref: PersonRef
    /// Called with the fiche as it stands after each gesture (nil when the
    /// fiche itself went), so the card that opened it can update its row.
    var onChange: (PersonReviewModel?) -> Void = { _ in }

    @State private var model: PersonReviewModel?
    @State private var loadFailed = false
    @State private var working = false
    @State private var failed: String?
    @State private var editing: Editing?
    @State private var asking: Asking?
    /// The `maurice-mail:` pointers after each line, shown or not: the
    /// prose reads alone, the sources are one tap away (the file keeps both).
    @State private var showSources = false

    private struct Editing {
        let target: String
        let id: String?
        let title: String
        var text: String
        var key: String { "\(target)/\(id ?? "")" }
    }

    /// A gesture that undoes something, asked first.
    private struct Asking {
        let target: String
        let id: String?
        let title: String
        let message: String
    }

    private var accent: Color { session.activeDeviceUser?.color ?? .blue }

    var body: some View {
        NavigationStack {
            Group {
                if let m = model {
                    content(m)
                } else if loadFailed {
                    Text(L("review.load_failed")).foregroundStyle(theme.inkMute).padding()
                } else {
                    ProgressView().padding()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(theme.surface)
            .navigationTitle(model?.title ?? "")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("common.done")) { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        Task { await openInGarden(webPath, session: session) }
                    } label: {
                        Label(L("review.open_garden"), systemImage: "safari")
                    }
                }
            }
        }
        .environment(\.openURL, OpenURLAction { ficheLink($0, session: session) })
        .presentationBackground(theme.surface)
        #if os(macOS)
        .frame(minWidth: 520, minHeight: 560)
        #endif
        .task { await load() }
        .sheet(item: Binding(get: { editing.map { EditingBox(value: $0) } }, set: { editing = $0?.value })) { box in
            editSheet(box.value)
        }
        .confirmationDialog(asking?.title ?? "", isPresented: Binding(get: { asking != nil }, set: { if !$0 { asking = nil } }),
                            titleVisibility: .visible, presenting: asking) { a in
            Button(L("review.reject"), role: .destructive) {
                Task { await act(target: a.target, action: "reject", id: a.id) }
            }
            Button(L("common.cancel"), role: .cancel) {}
        } message: { a in
            Text(a.message)
        }
    }

    private struct EditingBox: Identifiable {
        let value: Editing
        var id: String { value.key }
    }

    private var webPath: String {
        let member = session.activeDeviceUser?.username ?? ""
        let slug = ref.basename
        return "/g/\(member)/\(ref.locale)/fiches/people/\(slug)"
    }

    // MARK: Content

    private func content(_ m: PersonReviewModel) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    header(m)
                    relationSection(m).id("relation")
                    if !m.identities.isEmpty { identitiesSection(m) }
                    if !m.fragments.isEmpty { fragmentsSection(m) }
                    if let ex = m.exchanges, !ex.isEmpty { exchangesSection(ex) }
                    if m.byMaurice && m.status != "confirmed" { notAPerson }
                }
                .padding(20)
                .frame(maxWidth: 680, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .onAppear {
                if let a = ref.anchor, a != "review", a != "person" {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        withAnimation { proxy.scrollTo(a, anchor: .top) }
                    }
                }
            }
        }
    }

    private func header(_ m: PersonReviewModel) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(m.title)
                .font(.system(size: 24, design: .serif))
                .foregroundStyle(theme.ink)
            if m.byMaurice {
                Text(L("review.by_maurice")).font(.system(size: 13)).foregroundStyle(theme.inkMute)
            }
            if m.pending > 0 {
                let count = Text(m.pending == 1 ? L("review.one_item") : L("review.items", m.pending))
                    .font(.system(size: 13, weight: .medium)).foregroundStyle(theme.inkSoft)
                let all = Button {
                    Task { await act(target: "all", action: "confirm", id: nil) }
                } label: {
                    Text(L("review.confirm_all")).font(.system(size: 13, weight: .medium)).lineLimit(1)
                }
                .buttonStyle(.borderedProminent)
                .tint(accent)
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) {
                        count
                        Spacer(minLength: 8)
                        all.fixedSize()
                        if working { ProgressView().controlSize(.small) }
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        count
                        HStack(spacing: 10) {
                            all
                            if working { ProgressView().controlSize(.small) }
                        }
                    }
                }
            } else {
                HStack(spacing: 10) {
                    Label(L("review.all_checked"), systemImage: "checkmark.circle.fill")
                        .font(.system(size: 13)).foregroundStyle(theme.inkMute)
                    if working { ProgressView().controlSize(.small) }
                }
            }
            Button {
                withAnimation { showSources.toggle() }
            } label: {
                Label(L(showSources ? "review.hide_sources" : "review.show_sources"), systemImage: "envelope")
                    .font(.system(size: 12))
            }
            .buttonStyle(.plain)
            .foregroundStyle(theme.inkSoft)
            if let f = failed {
                Text(f).font(.system(size: 12)).foregroundStyle(.red)
            }
        }
    }

    private func sectionTitle(_ key: String) -> some View {
        Text(L(key))
            .font(.system(size: 12, weight: .semibold))
            .textCase(.uppercase)
            .tracking(0.6)
            .foregroundStyle(theme.inkMute)
    }

    private func relationSection(_ m: PersonReviewModel) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("review.relation")
            if let text = m.relation.text, !text.isEmpty {
                element(status: m.relation.status ?? "confirmed") {
                    VStack(alignment: .leading, spacing: 6) {
                        markdown(text)
                        if m.relation.since != nil || m.relation.until != nil {
                            Text("\(m.relation.since ?? "?") → \(m.relation.until ?? "…")")
                                .font(.system(size: 12)).foregroundStyle(theme.inkMute)
                        }
                    }
                } actions: {
                    gestures(status: m.relation.status ?? "confirmed", target: "relation", id: nil,
                             editText: text, editTitle: L("review.relation"),
                             reject: (L("review.reject_relation.title"), L("review.reject_relation.message")))
                }
            } else {
                Text(L("review.no_relation")).font(.system(size: 13)).foregroundStyle(theme.inkMute)
            }
        }
    }

    private func identitiesSection(_ m: PersonReviewModel) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("review.addresses")
            ForEach(Array(m.identities.enumerated()), id: \.element.address) { n, i in
                element(status: i.status) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(i.address).font(.system(size: 14, design: .monospaced)).foregroundStyle(theme.ink)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                        if !i.mailboxes.isEmpty {
                            Text(L("review.mailboxes", i.mailboxes.joined(separator: ", ")))
                                .font(.system(size: 12)).foregroundStyle(theme.inkMute)
                        }
                        if let c = i.conflict {
                            Text(conflictText(c)).font(.system(size: 12)).foregroundStyle(.orange)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                } actions: {
                    gestures(status: i.status, target: "identity", id: i.address, editText: nil, editTitle: "",
                             reject: (L("review.reject_address.title"), L("review.reject_address.message")))
                }
                .id("identity-\(n + 1)")
            }
        }
    }

    private func fragmentsSection(_ m: PersonReviewModel) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("review.fragments")
            ForEach(m.fragments) { f in
                element(status: f.status) {
                    VStack(alignment: .leading, spacing: 6) {
                        if !f.summary.isEmpty {
                            Text(f.summary).font(.system(size: 12, weight: .medium)).foregroundStyle(theme.inkSoft)
                        }
                        markdown(f.body)
                    }
                } actions: {
                    gestures(status: f.status, target: "fragment", id: f.id, editText: f.body, editTitle: f.summary,
                             reject: (L("review.reject_fragment.title"), L("review.reject_fragment.message")))
                }
                .id("fragment-\(f.id)")
            }
        }
    }

    private func exchangesSection(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("review.exchanges")
            markdown(text, sources: true)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8).fill(theme.inkMute.opacity(0.05)))
        }
    }

    private var notAPerson: some View {
        Button(role: .destructive) {
            asking = Asking(target: "fiche", id: nil, title: L("review.reject_fiche.title"), message: L("review.reject_fiche.message"))
        } label: {
            Text(L("review.not_person")).font(.system(size: 13))
        }
        .buttonStyle(.bordered)
        .padding(.top, 4)
    }

    // MARK: Pieces

    /// The conflict the mail pass records on an address, in the member's
    /// language: the server writes it in English for the model
    /// (services/mailPeople.ts, resolvePeople).
    private func conflictText(_ c: String) -> String {
        if let m = c.firstMatch(of: /^in (\d+) cards of the address book$/), let n = Int(m.1) {
            return L("review.conflict.cards", n)
        }
        if let m = c.firstMatch(of: /^writes as « (.+) »$/) {
            return L("review.conflict.writes_as", String(m.1))
        }
        return c
    }

    /// One element: its text, its status, its gestures. A pending element
    /// carries a coloured edge, so what is left to check shows at a glance.
    private func element<Content: View, Actions: View>(
        status: String, @ViewBuilder content: () -> Content, @ViewBuilder actions: () -> Actions
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            content()
            // The status and the gestures on one line when they fit; else the
            // gestures under the status; else, with a large text size, the
            // gestures as their symbols alone. Never wider than the screen:
            // a row forced to its natural width widened the whole column past
            // both edges (27 September 2026, on the owner's phone).
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    statusChip(status)
                    Spacer(minLength: 4)
                    HStack(spacing: 8) { actions() }.fixedSize()
                }
                VStack(alignment: .leading, spacing: 8) {
                    statusChip(status)
                    HStack(spacing: 8) { actions() }.fixedSize()
                }
                VStack(alignment: .leading, spacing: 8) {
                    statusChip(status)
                    HStack(spacing: 8) { actions() }.labelStyle(.iconOnly)
                }
            }
            .lineLimit(1)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(theme.inkMute.opacity(status == "pending" ? 0.08 : 0.04)))
        .overlay(alignment: .leading) {
            if status == "pending" {
                RoundedRectangle(cornerRadius: 2).fill(Color.orange.opacity(0.7)).frame(width: 3).padding(.vertical, 8)
            }
        }
    }

    private func statusChip(_ status: String) -> some View {
        let (key, symbol): (String, String) = switch status {
        case "pending": ("review.status.pending", "questionmark.circle")
        case "rejected": ("review.status.rejected", "xmark.circle")
        default: ("review.status.confirmed", "checkmark.circle")
        }
        return Label(L(key), systemImage: symbol)
            .font(.system(size: 12))
            .foregroundStyle(status == "pending" ? Color.orange : theme.inkMute)
    }

    @ViewBuilder
    private func gestures(status: String, target: String, id: String?, editText: String?, editTitle: String,
                          reject: (String, String)) -> some View {
        if status == "pending" {
            Button {
                Task { await act(target: target, action: "confirm", id: id) }
            } label: {
                Label(L("review.confirm"), systemImage: "checkmark")
            }
            .buttonStyle(.borderedProminent)
            .tint(accent)
            Button {
                asking = Asking(target: target, id: id, title: reject.0, message: reject.1)
            } label: {
                Label(L("review.reject"), systemImage: "xmark")
            }
            .buttonStyle(.bordered)
        }
        if let text = editText, status != "rejected" {
            Button {
                editing = Editing(target: target, id: id, title: editTitle, text: text)
            } label: {
                Label(L("review.edit"), systemImage: "pencil")
            }
            .buttonStyle(.bordered)
        }
    }

    private func markdown(_ text: String, sources: Bool = false) -> some View {
        Markdown(sources || showSources ? text : withoutSources(text))
            .markdownTheme(mauriceMarkdownTheme(theme))
            .font(.system(size: 14))
            #if os(macOS)
            .textSelection(.enabled)
            #endif
    }

    private func editSheet(_ e: Editing) -> some View {
        EditElementSheet(title: e.title.isEmpty ? L("review.edit") : e.title, text: e.text) { text in
            editing = nil
            Task { await act(target: e.target, action: "edit", id: e.id, text: text) }
        } onCancel: {
            editing = nil
        }
        .environment(\.mauriceTheme, theme)
    }

    // MARK: Server

    private func load() async {
        guard let base = session.serverURL, let token = session.tokenForActiveUser else { loadFailed = true; return }
        do {
            let m: PersonReviewModel = try await APIClient(baseURL: base).get(
                "/api/people/\(ref.locale)/\(ref.basename)", token: token)
            model = m
            onChange(m)
        } catch {
            loadFailed = true
        }
    }

    private func act(target: String, action: String, id: String?, text: String? = nil) async {
        guard let base = session.serverURL, let token = session.tokenForActiveUser else { return }
        working = true
        failed = nil
        defer { working = false }
        do {
            let r: ReviewResponse = try await APIClient(baseURL: base).post(
                "/api/people/\(ref.locale)/\(ref.basename)/review",
                body: ReviewRequest(target: target, action: action, id: id, text: text), token: token)
            onChange(r.view)
            if let v = r.view {
                withAnimation { model = v }
            } else {
                // The fiche itself went (a person Maurice made, rejected).
                dismiss()
            }
        } catch {
            failed = L("review.failed")
        }
    }
}

/// Correcting an element: the member's own words, in markdown — what the
/// garden will hold. Replacing Maurice's text confirms it.
private struct EditElementSheet: View {
    @Environment(\.mauriceTheme) private var theme
    let title: String
    @State var text: String
    let onSave: (String) -> Void
    let onCancel: () -> Void

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 10) {
                Text(L("review.edit.hint")).font(.system(size: 12)).foregroundStyle(theme.inkMute)
                TextEditor(text: $text)
                    .font(.system(size: 14, design: .monospaced))
                    .scrollContentBackground(.hidden)
                    .padding(8)
                    .background(RoundedRectangle(cornerRadius: 8).fill(theme.inkMute.opacity(0.06)))
            }
            .padding(16)
            .background(theme.surface)
            .navigationTitle(title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L("common.cancel"), action: onCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("common.save")) { onSave(text) }
                        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .presentationBackground(theme.surface)
        #if os(macOS)
        .frame(minWidth: 520, minHeight: 400)
        #endif
    }
}

/// A line's prose without the pointers the mail pass writes after it —
/// ` — [date, sender, « subject » · box](maurice-mail:…) ; […](…)` — so the
/// sentence reads alone. The file keeps them; the screen shows them on demand.
func withoutSources(_ text: String) -> String {
    text.replacing(/\s+—\s+\[(?:\\.|[^\]])*\]\(maurice-mail:[^)]*\)(?:\s*;\s*\[(?:\\.|[^\]])*\]\(maurice-mail:[^)]*\))*/, with: "")
}
