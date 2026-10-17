import Foundation

#if os(iOS)
/// The share extension opened the app with `maurice://share`.
///
/// Observable, like `DictationRequest`: the URL may arrive before any view
/// exists or long after the composer settled, and the composer has to hear of
/// it either way. The page itself waits in `ShareInbox`.
@Observable @MainActor
final class ShareArrivals {
    static let shared = ShareArrivals()
    private(set) var token = 0

    func arrived() { token &+= 1 }
}

extension ChatService {
    /// Have the server read a shared page into an article for the composer.
    ///
    /// Never fails: a page the server cannot read — offline, a bot wall, no
    /// text in it — still goes in as its title and address, and Maurice can
    /// follow the link with his own tools.
    func readSharedArticle(_ page: SharedPage) async -> SharedArticle {
        let bare = SharedArticle(title: page.title, url: page.url, text: "")
        guard let url = session.serverURL, let token = session.tokenForActiveUser else { return bare }
        struct Body: Encodable { let url: String; let html: String? }
        struct Read: Decodable {
            let url: String
            let title: String
            let site_name: String
            let author: String
            let published_at: String
            let text: String
        }
        do {
            let read: Read = try await APIClient(baseURL: url).post(
                "/api/v1/articles/read",
                body: Body(url: page.url, html: page.html.isEmpty ? nil : page.html),
                token: token,
                // A page Safari did not render is fetched by the server.
                timeout: 45
            )
            return SharedArticle(
                title: read.title.isEmpty ? page.title : read.title,
                site: read.site_name,
                author: read.author,
                date: read.published_at,
                url: read.url,
                text: read.text
            )
        } catch {
            return bare
        }
    }
}
#endif
