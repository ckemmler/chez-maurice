import Foundation

/// A page shared with Maurice from another app, as the share sheet saw it.
struct SharedPage: Codable, Equatable {
    var url: String
    /// The page's own title; empty when the sharing app sent an address alone.
    var title: String
    /// The DOM Safari rendered — past the paywall a server fetch would meet.
    /// Empty from any other app, and the server then fetches the URL.
    var html: String
    /// The passage highlighted in Safari, if any.
    var selection: String
    var sharedAt: Date
}

/// Where the share extension leaves a page for the app.
///
/// The extension cannot read the article itself: the server does that, and the
/// session's token lives in the app's own defaults. So it drops the page in the
/// app group's container and opens the app, which picks it up, has the server
/// read it, and lays it in the composer of a new conversation.
enum ShareInbox {
    static let appGroup = "group.eu.chezmaurice.maurice"
    /// What the extension opens; the app reads the inbox on it.
    static let openURL = URL(string: "maurice://share")!
    /// A share the app never picked up — its opening failed, and Maurice was
    /// opened by hand much later — is no longer what anyone is reaching for.
    static let freshFor: TimeInterval = 6 * 3600

    private static var directory: URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
            .appendingPathComponent("share-inbox", isDirectory: true)
    }

    static func put(_ page: SharedPage) throws {
        guard let dir = directory else { throw CocoaError(.fileNoSuchFile) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(page)
        try data.write(to: dir.appendingPathComponent("\(UUID().uuidString).json"), options: .atomic)
    }

    /// Whether a page is waiting, without taking it.
    static var hasPending: Bool {
        guard let dir = directory,
              let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return false }
        return names.contains { $0.hasSuffix(".json") }
    }

    /// The latest fresh share, and the inbox emptied: two shares in a row mean
    /// the first was a mistake, not that both should open.
    static func take() -> SharedPage? {
        guard let dir = directory,
              let files = try? FileManager.default.contentsOfDirectory(
                at: dir, includingPropertiesForKeys: nil) else { return nil }
        let pages = files.filter { $0.pathExtension == "json" }.compactMap { file -> SharedPage? in
            defer { try? FileManager.default.removeItem(at: file) }
            guard let data = try? Data(contentsOf: file) else { return nil }
            return try? JSONDecoder().decode(SharedPage.self, from: data)
        }
        guard let latest = pages.max(by: { $0.sharedAt < $1.sharedAt }),
              Date().timeIntervalSince(latest.sharedAt) < freshFor else { return nil }
        return latest
    }
}
