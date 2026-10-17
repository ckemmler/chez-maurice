import Foundation
import UniformTypeIdentifiers

/// Reads what the share sheet handed over into a `SharedPage`.
///
/// Safari sends two things for one page: the results of
/// `ShareExtensionPreprocessor.js` (the rendered DOM) and a plain URL. Every
/// other app sends the URL alone, under whichever representation it chose. All
/// of them are read before deciding, so the DOM is never lost to a URL that
/// happened to load first.
enum SharedPageLoader {
    static func load(from items: [NSExtensionItem], completion: @escaping (SharedPage?) -> Void) {
        let providers = items.flatMap { $0.attachments ?? [] }
        guard !providers.isEmpty else { return completion(nil) }

        var page: SharedPage?
        var url: String?
        let group = DispatchGroup()
        let lock = NSLock()

        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.propertyList.identifier) {
                group.enter()
                provider.loadItem(forTypeIdentifier: UTType.propertyList.identifier) { item, _ in
                    if let found = webPage(fromPropertyList: item) {
                        lock.lock(); page = found; lock.unlock()
                    }
                    group.leave()
                }
            }
            for type in [UTType.url, UTType.plainText] where provider.hasItemConformingToTypeIdentifier(type.identifier) {
                group.enter()
                provider.loadItem(forTypeIdentifier: type.identifier) { item, _ in
                    if let found = asURL(item), found.scheme?.hasPrefix("http") == true {
                        lock.lock(); url = url ?? found.absoluteString; lock.unlock()
                    }
                    group.leave()
                }
            }
        }

        group.notify(queue: .main) {
            if let page { return completion(page) }
            completion(url.map { SharedPage(url: $0, title: "", html: "", selection: "", sharedAt: Date()) })
        }
    }

    /// The dictionary the JavaScript file sent back, nested by Safari under its
    /// own key.
    static func webPage(fromPropertyList item: Any?) -> SharedPage? {
        guard let outer = item as? [String: Any] else { return nil }
        let results = (outer[NSExtensionJavaScriptPreprocessingResultsKey] as? [String: Any]) ?? outer
        guard let url = results["url"] as? String, url.hasPrefix("http") else { return nil }
        return SharedPage(
            url: url,
            title: results["title"] as? String ?? "",
            html: results["html"] as? String ?? "",
            selection: results["selection"] as? String ?? "",
            sharedAt: Date()
        )
    }

    /// `loadItem` answers a URL type with an NSURL, its bytes, or a string,
    /// depending on how the sharing app registered it.
    static func asURL(_ item: Any?) -> URL? {
        if let url = item as? URL { return url }
        if let string = item as? String { return URL(string: string.trimmingCharacters(in: .whitespacesAndNewlines)) }
        if let data = item as? Data, let string = String(data: data, encoding: .utf8) {
            return URL(string: string.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return nil
    }
}
