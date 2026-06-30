import SwiftUI
import CoreText
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

@main
struct MauriceApp: App {
    init() { registerBundledFonts() }

    #if os(iOS)
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    #elseif os(macOS)
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    #endif
    @State private var session = SessionStore()
    @State private var chatService: ChatService?
    @State private var composer: ComposerStore?
    @State private var maurices: MauriceStore?
    @State private var gardens: GardensStore?
    @State private var studio = StudioState()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(session)
                .environment(resolvedChatService)
                .environment(resolvedComposer)
                .environment(resolvedMaurices)
                .environment(resolvedGardens)
                .environment(studio)
                .environment(\.locale, session.resolvedLocale)
                #if os(macOS)
                // Kill the macOS keyboard focus rings app-wide — they clash with
                // our custom pill/row borders. Propagates to all views + sheets.
                .focusEffectDisabled()
                #endif
        }
        #if os(macOS)
        .defaultSize(width: 900, height: 700)
        .windowStyle(.hiddenTitleBar)
        #endif
    }

    private var resolvedChatService: ChatService {
        if let existing = chatService {
            return existing
        }
        let service = ChatService(session: session)
        DispatchQueue.main.async {
            chatService = service
        }
        return service
    }

    private var resolvedComposer: ComposerStore {
        if let existing = composer { return existing }
        let store = ComposerStore(session: session)
        DispatchQueue.main.async { composer = store }
        return store
    }

    private var resolvedMaurices: MauriceStore {
        if let existing = maurices { return existing }
        let store = MauriceStore(session: session)
        DispatchQueue.main.async { maurices = store }
        return store
    }

    private var resolvedGardens: GardensStore {
        if let existing = gardens { return existing }
        let store = GardensStore(session: session)
        DispatchQueue.main.async { gardens = store }
        return store
    }
}

// MARK: - Bundled fonts

/// Register the app's bundled custom fonts at launch (CoreText), so we don't
/// depend on an Info.plist UIAppFonts/ATSApplicationFontsPath entry. Idempotent —
/// a duplicate registration on a hot reload just no-ops.
private func registerBundledFonts() {
    for name in ["YoungSerif-Regular"] {
        guard let url = Bundle.main.url(forResource: name, withExtension: "ttf"),
              let data = try? Data(contentsOf: url),
              let provider = CGDataProvider(data: data as CFData),
              let font = CGFont(provider) else { continue }
        CTFontManagerRegisterGraphicsFont(font, nil)
    }
}

extension Font {
    /// Young Serif — the "Chez Maurice" wordmark face. Fixed size (matches the
    /// previous `.system(design: .serif)`, which also didn't scale with Dynamic Type).
    static func wordmark(_ size: CGFloat) -> Font { .custom("YoungSerif-Regular", fixedSize: size) }
}

// MARK: - App delegate (APNs device-token registration)

private func apnsHex(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
}

#if os(iOS)
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = apnsHex(deviceToken)
        Task { @MainActor in NotificationManager.shared.setDeviceToken(hex) }
    }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("[push] registration failed: \(error.localizedDescription)")
    }

    // Route every scene through our delegate so we can opt into the compact
    // iPadOS 26 window-control treatment (below). SwiftUI still supplies the
    // scene's content — we only add the windowing-style callback.
    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

/// iPadOS 26 windowing. `.minimal` snaps the window controls right up to the
/// top-leading edge (Safari/Brave's look) and repositions surrounding UI around
/// them — verified to look right. (`.unified` instead tucks the controls *into*
/// the toolbar, which pushed them back over our content, so we don't use it.)
/// The real toolbar on the detail + sidebar columns still exists so the system
/// hosts the sidebar toggle and our re-homed header content shifts clear of the
/// controls. iPhone has no window controls, so the value there is moot.
final class SceneDelegate: NSObject, UIWindowSceneDelegate {
    @available(iOS 26.0, *)
    func preferredWindowingControlStyle(for scene: UIWindowScene) -> UIWindowScene.WindowingControlStyle {
        .minimal
    }
}
#elseif os(macOS)
final class AppDelegate: NSObject, NSApplicationDelegate {
    func application(_ application: NSApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = apnsHex(deviceToken)
        Task { @MainActor in NotificationManager.shared.setDeviceToken(hex) }
    }
    func application(_ application: NSApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("[push] registration failed: \(error.localizedDescription)")
    }
}
#endif
