import SwiftUI

// MARK: - Context Composer

// Client for the composer backend (/api/v1/composer/*). The server owns all
// resolution (search, descendant/chapter sets, weights, the snapshot spec); the
// app assembles a tray of items, asks the server to weigh it, and persists the
// spec for the active conversation. The heterogeneous JSON is handled with
// JSONSerialization rather than Codable.

let CTX_BUDGET = 200_000

enum ComposerItemType: String, Codable {
    case note, book, conversation, file, folder
}

/// One chip in the tray. `rawId` is the slug (note), numeric book id (as string),
/// or conversation id. Options map to the backend item shape.
struct TrayItem: Identifiable, Equatable {
    let type: ComposerItemType
    let rawId: String
    var title: String
    var sub: String = ""

    // note / folder options (folder reuses recurse + exclude)
    var recurse: Bool = false
    var includeArchived: Bool = false
    var exclude: [String] = []
    // book options
    var representation: String = "summary" // "summary" | "full"
    var scopeMode: String = "all"          // "all" | "up_to" | "chapters"
    var uptoChapter: Int = 0
    var selectedRefs: [String] = []
    // file options
    var kind: String = ""                  // file kind: text/img/pdf/file
    var na: Bool = false                   // binary file — no token estimate (attachment)
    // flags for chip rendering
    var encrypted: Bool = false
    var moc: Bool = false

    var id: String { "\(type.rawValue)-\(rawId)" }

    /// The backend ComposerItem JSON for weigh / save.
    func payload() -> [String: Any] {
        switch type {
        case .note:
            return ["type": "note", "id": rawId, "recurse": recurse,
                    "include_archived": includeArchived, "exclude": exclude]
        case .book:
            var scope: [String: Any] = ["mode": scopeMode]
            if scopeMode == "up_to" { scope["chapter"] = uptoChapter }
            if scopeMode == "chapters" { scope["refs"] = selectedRefs }
            return ["type": "book", "id": Int(rawId) ?? 0,
                    "representation": representation, "scope": scope]
        case .conversation:
            return ["type": "conversation", "id": rawId]
        case .file:
            return ["type": "file", "id": rawId]
        case .folder:
            return ["type": "folder", "id": rawId, "recurse": recurse, "exclude": exclude]
        }
    }
}

/// A picker search result.
struct SearchEntry: Identifiable {
    let type: ComposerItemType
    let rawId: String
    let title: String
    let sub: String
    let encrypted: Bool
    let moc: Bool
    var kind: String = ""   // file kind (text/img/pdf/file) for glyph
    var id: String { "\(type.rawValue)-\(rawId)" }
}

@Observable @MainActor
final class ComposerStore {
    let session: SessionStore

    var items: [TrayItem] = []
    var trayStyle: TrayStyle = .cards

    // derived from /weigh (kept in lock-step so the two numbers agree)
    var total = 0
    var tier = "light"
    var over = false

    // A specialized Maurice's baked-in context is loaded into the conversation
    // but lives on the persona — the user can ADD context but not remove these.
    // We show them as a read-only summary (count + weight + persona name) and
    // fold their weight into the displayed total so the readout stays honest.
    var lockedName = ""
    var lockedCount = 0
    var lockedWeight = 0

    /// Everything Maurice actually loads = the persona's locked bundle + the
    /// user's added items. This is what the budget readouts display.
    var displayTotal: Int { total + lockedWeight }
    private(set) var weightById: [String: Int] = [:]
    private(set) var countById: [String: Int] = [:]
    private(set) var heavyById: [String: Bool] = [:]
    private(set) var binaryCountById: [String: Int] = [:] // attachments swept in by a folder

    /// Total binary attachments across the tray (folder-swept + single binary files).
    /// Powers the "+N attachments · no estimate" footer line.
    var attachmentCount: Int {
        items.reduce(0) { acc, it in
            if it.type == .folder { return acc + (binaryCountById[it.id] ?? 0) }
            if it.type == .file, it.na { return acc + 1 }
            return acc
        }
    }

    private var conversationId: String?

    enum TrayStyle { case cards, chips }

    init(session: SessionStore) { self.session = session }

    private var base: String? { session.serverURL }
    private var token: String? { session.tokenForActiveUser }

    // MARK: tray edits

    func has(_ entryId: String) -> Bool { items.contains { $0.id == entryId } }

    func add(_ e: SearchEntry) {
        guard !has(e.id) else { return }
        var it = TrayItem(type: e.type, rawId: e.rawId, title: e.title, sub: e.sub)
        it.encrypted = e.encrypted
        it.moc = e.moc
        it.kind = e.kind
        // defaults: notes recurse iff MOC; folders recurse on; books summary/all
        if e.type == .note { it.recurse = e.moc }
        if e.type == .folder { it.recurse = true }
        if e.type == .file { it.na = (e.kind == "img" || e.kind == "pdf") }
        items.append(it)
        Task { await reweigh(); await save() }
    }

    func toggle(_ e: SearchEntry) {
        if has(e.id) { remove(e.id) } else { add(e) }
    }

    func remove(_ id: String) {
        items.removeAll { $0.id == id }
        Task { await reweigh(); await save() }
    }

    func update(_ item: TrayItem) {
        if let i = items.firstIndex(where: { $0.id == item.id }) { items[i] = item }
        Task { await reweigh(); await save() }
    }

    func clear() {
        items = []; total = 0; tier = "light"; over = false
        weightById = [:]; countById = [:]; heavyById = [:]; binaryCountById = [:]
    }

    // MARK: conversation binding

    /// Bind to a conversation, seeding the read-only summary of the bound
    /// Maurice's baked-in context (name/count/weight) so the budget readouts
    /// reflect everything Maurice loads, not just the user's added items.
    func setConversation(
        _ id: String?,
        lockedName: String = "", lockedCount: Int = 0, lockedWeight: Int = 0
    ) async {
        conversationId = id
        self.lockedName = lockedName
        self.lockedCount = lockedCount
        self.lockedWeight = lockedWeight
        clear()
        await loadSpec()
        await reweigh()
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

    func reweigh() async {
        guard !items.isEmpty else { total = 0; tier = "light"; over = false; return }
        let body: [String: Any] = ["items": items.map { $0.payload() }]
        guard let json = await request("POST", "/api/v1/composer/weigh", body: body) as? [String: Any] else { return }
        total = json["total"] as? Int ?? 0
        tier = json["tier"] as? String ?? "light"
        over = json["over"] as? Bool ?? false
        if let arr = json["items"] as? [[String: Any]] {
            for (i, w) in arr.enumerated() where i < items.count {
                let key = items[i].id
                weightById[key] = w["weight"] as? Int ?? 0
                countById[key] = w["count"] as? Int
                heavyById[key] = w["heavy"] as? Bool ?? false
                binaryCountById[key] = w["binaryCount"] as? Int ?? 0
                // resolve real display titles/flags for spec-loaded chips
                if let t = w["title"] as? String, !t.isEmpty { items[i].title = t }
                if let m = w["moc"] as? Bool { items[i].moc = m }
                if let e = w["encrypted"] as? Bool { items[i].encrypted = e }
                // file: kind/na drive the glyph + "n/a" readout; rebuild the meta
                // line (kind · path) so spec-loaded files read right without a search.
                if items[i].type == .file {
                    if let k = w["kind"] as? String { items[i].kind = k }
                    if let n = w["na"] as? Bool { items[i].na = n }
                    let path = w["path"] as? String ?? ""
                    items[i].sub = [items[i].kind, path].filter { !$0.isEmpty }.joined(separator: " · ")
                }
            }
        }
    }

    func save() async {
        guard let cid = conversationId else { return }
        _ = await request("PUT", "/api/v1/composer/context/\(cid)", body: ["items": items.map { $0.payload() }])
    }

    // MARK: upload (file-at-birth from the composer)

    /// Upload bytes to the library (multipart) and return the new file's row.
    /// `/api/files/upload` is owner-scoped; folderId nil files at the library root.
    private func uploadFile(name: String, data: Data, folderId: String?) async -> [String: Any]? {
        guard let base, let token, let url = URL(string: base + "/api/files/upload") else { return nil }
        let boundary = "Boundary-\(UUID().uuidString)"
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        var body = Data()
        func part(_ s: String) { body.append(s.data(using: .utf8)!) }
        part("--\(boundary)\r\n")
        part("Content-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\r\n")
        part("Content-Type: application/octet-stream\r\n\r\n")
        body.append(data)
        part("\r\n")
        if let folderId {
            part("--\(boundary)\r\n")
            part("Content-Disposition: form-data; name=\"folder_id\"\r\n\r\n")
            part(folderId)
            part("\r\n")
        }
        part("--\(boundary)--\r\n")
        req.httpBody = body
        guard let (respData, resp) = try? await URLSession.shared.data(for: req),
              let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return nil }
        return try? JSONSerialization.jsonObject(with: respData) as? [String: Any]
    }

    /// File a freshly-picked document into the library AND attach it as context
    /// in one gesture (the "file-at-birth" flow). folderId nil → library root.
    func addUploadedFile(name: String, data: Data, folderId: String? = nil) async {
        guard let row = await uploadFile(name: name, data: data, folderId: folderId),
              let id = row["id"] as? String, !id.isEmpty, !has("file-\(id)") else { return }
        let kind = row["kind"] as? String ?? "file"
        var it = TrayItem(type: .file, rawId: id, title: row["name"] as? String ?? name)
        it.kind = kind
        it.na = (kind == "img" || kind == "pdf")
        items.append(it)
        await reweigh(); await save()
    }

    func loadSpec() async {
        guard let cid = conversationId else { return }
        guard let json = await request("GET", "/api/v1/composer/context/\(cid)") as? [String: Any],
              let raw = json["items"] as? [[String: Any]] else { return }
        items = raw.compactMap { Self.itemFromSpec($0) }
    }

    nonisolated static func itemFromSpec(_ d: [String: Any]) -> TrayItem? {
        guard let typeStr = d["type"] as? String, let type = ComposerItemType(rawValue: typeStr) else { return nil }
        let rawId: String = (d["id"] as? String) ?? String(describing: d["id"] ?? "")
        var it = TrayItem(type: type, rawId: rawId, title: rawId)
        let snap = d["snapshot"] as? [String: Any]
        switch type {
        case .note:
            it.recurse = d["recurse"] as? Bool ?? false
            it.includeArchived = d["include_archived"] as? Bool ?? false
            it.exclude = d["exclude"] as? [String] ?? []
            it.encrypted = snap?["encrypted"] as? Bool ?? false
        case .book:
            it.representation = d["representation"] as? String ?? "summary"
            if let scope = d["scope"] as? [String: Any] {
                it.scopeMode = scope["mode"] as? String ?? "all"
                it.uptoChapter = scope["chapter"] as? Int ?? 0
                it.selectedRefs = scope["refs"] as? [String] ?? []
            }
        case .conversation:
            break
        case .file:
            it.kind = snap?["kind"] as? String ?? ""
            it.na = snap?["na"] as? Bool ?? false
        case .folder:
            it.recurse = d["recurse"] as? Bool ?? true
            it.exclude = d["exclude"] as? [String] ?? []
        }
        return it
    }

    // MARK: note subtree (for the tree preview)

    struct NoteTreeNode: Identifiable {
        let id: String
        let title: String
        let moc: Bool
        let archived: Bool
        let encrypted: Bool
        let weight: Int
        let childCount: Int
        let included: Bool
        let excluded: Bool
        let children: [NoteTreeNode]

        static func parse(_ d: [String: Any]) -> NoteTreeNode {
            NoteTreeNode(
                id: d["id"] as? String ?? "",
                title: d["title"] as? String ?? "",
                moc: d["moc"] as? Bool ?? false,
                archived: d["archived"] as? Bool ?? false,
                encrypted: d["encrypted"] as? Bool ?? false,
                weight: d["weight"] as? Int ?? 0,
                childCount: d["childCount"] as? Int ?? 0,
                included: d["included"] as? Bool ?? false,
                excluded: d["excluded"] as? Bool ?? false,
                children: (d["children"] as? [[String: Any]] ?? []).map(NoteTreeNode.parse))
        }
    }

    struct NoteResolve {
        let count: Int
        let weight: Int
        let encrypted: Bool
        let archivedWithheld: Int
        let manualExcluded: Int
        let hasChildren: Bool
        let tree: NoteTreeNode
    }

    /// Resolve a note's subtree against the item's current recurse/archived/exclude
    /// options — drives the tree preview (server owns inclusion/exclusion).
    func resolveNote(_ item: TrayItem) async -> NoteResolve? {
        let exc = item.exclude.joined(separator: ",")
            .addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        let path = "/api/v1/composer/notes/\(item.rawId)/resolve"
            + "?recurse=\(item.recurse)&include_archived=\(item.includeArchived)&exclude=\(exc)"
        guard let json = await request("GET", path) as? [String: Any],
              let treeD = json["tree"] as? [String: Any] else { return nil }
        let r = json["resolved"] as? [String: Any] ?? [:]
        return NoteResolve(
            count: r["count"] as? Int ?? 1,
            weight: r["weight"] as? Int ?? 0,
            encrypted: r["encrypted"] as? Bool ?? false,
            archivedWithheld: r["archivedWithheld"] as? Int ?? 0,
            manualExcluded: r["manualExcluded"] as? Int ?? 0,
            hasChildren: r["hasChildren"] as? Bool ?? false,
            tree: NoteTreeNode.parse(treeD))
    }

    // MARK: folder subtree (for the folder card's tree preview)

    struct FileTreeNode: Identifiable {
        let id: String
        let name: String
        let isFolder: Bool
        let kind: String
        let weight: Int
        let na: Bool
        let childCount: Int
        let included: Bool
        let excluded: Bool
        let children: [FileTreeNode]

        static func parse(_ d: [String: Any]) -> FileTreeNode {
            FileTreeNode(
                id: d["id"] as? String ?? "",
                name: d["name"] as? String ?? "",
                isFolder: d["isFolder"] as? Bool ?? false,
                kind: d["kind"] as? String ?? "file",
                weight: d["weight"] as? Int ?? 0,
                na: d["na"] as? Bool ?? false,
                childCount: d["childCount"] as? Int ?? 0,
                included: d["included"] as? Bool ?? false,
                excluded: d["excluded"] as? Bool ?? false,
                children: (d["children"] as? [[String: Any]] ?? []).map(FileTreeNode.parse))
        }
    }

    struct FolderResolve {
        let weight: Int
        let count: Int
        let textCount: Int
        let binaryCount: Int
        let hasChildren: Bool
        let manualExcluded: Int
        let tree: FileTreeNode
    }

    /// Resolve a folder's descendant tree against the item's recurse/exclude
    /// options — drives the folder card preview (server owns inclusion/exclusion).
    func resolveFolder(_ item: TrayItem) async -> FolderResolve? {
        let exc = item.exclude.joined(separator: ",")
            .addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        let path = "/api/v1/composer/folders/\(item.rawId)/resolve?recurse=\(item.recurse)&exclude=\(exc)"
        guard let json = await request("GET", path) as? [String: Any],
              let treeD = json["tree"] as? [String: Any] else { return nil }
        return FolderResolve(
            weight: json["weight"] as? Int ?? 0,
            count: json["count"] as? Int ?? 0,
            textCount: json["textCount"] as? Int ?? 0,
            binaryCount: json["binaryCount"] as? Int ?? 0,
            hasChildren: json["hasChildren"] as? Bool ?? false,
            manualExcluded: json["manualExcluded"] as? Int ?? 0,
            tree: FileTreeNode.parse(treeD))
    }

    // MARK: book chapters (for the Up-to control + section list)

    struct BookChapter: Identifiable {
        let index: Int
        let ref: String
        let name: String
        let hidden: Bool
        let sectionType: String   // "front_matter" | "body" | "back_matter"
        let wordCount: Int
        let hasSummary: Bool
        var id: Int { index }
    }
    private var chaptersCache: [String: [BookChapter]] = [:]

    func bookChapters(_ bookId: String) async -> [BookChapter] {
        if let c = chaptersCache[bookId] { return c }
        guard let json = await request("GET", "/api/v1/composer/books/\(bookId)/chapters") as? [String: Any],
              let chs = json["chapters"] as? [[String: Any]] else { return [] }
        let out = chs.map { c in
            BookChapter(index: c["index"] as? Int ?? 0,
                        ref: c["ref"] as? String ?? "",
                        name: c["name"] as? String ?? "",
                        hidden: c["hidden"] as? Bool ?? false,
                        sectionType: c["section_type"] as? String ?? "body",
                        wordCount: c["word_count"] as? Int ?? 0,
                        hasSummary: c["has_summary"] as? Bool ?? false)
        }
        chaptersCache[bookId] = out
        return out
    }

    // MARK: search

    func search(_ q: String) async -> [SearchEntry] {
        let qs = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        guard let json = await request("GET", "/api/v1/composer/search?q=\(qs)") as? [String: Any],
              let results = json["results"] as? [[String: Any]] else { return [] }
        return results.compactMap { r in
            guard let typeStr = r["type"] as? String, let type = ComposerItemType(rawValue: typeStr) else { return nil }
            let rawId = (r["id"] as? String) ?? String(describing: r["id"] ?? "")
            let badges = r["badges"] as? [String: Any] ?? [:]
            return SearchEntry(
                type: type, rawId: rawId,
                title: r["title"] as? String ?? rawId,
                sub: r["sub"] as? String ?? "",
                encrypted: badges["encrypted"] as? Bool ?? false,
                moc: badges["moc"] as? Bool ?? false,
                kind: badges["kind"] as? String ?? "",
            )
        }
    }
}
