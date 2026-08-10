import Foundation
#if os(iOS)
import AppIntents

/// A request from outside the app to start dictating.
///
/// The intent can't reach into the composer itself: it runs before there is a
/// view to talk to on a cold launch, and the microphone belongs to whichever
/// chat is on screen. So it leaves a note here and the composer picks it up when
/// it appears.
///
/// The note expires. A request that arrives while the phone is in a pocket, or
/// that loses its race with a launch that took too long, must not open the
/// microphone ten minutes later when the app is next opened by hand — recording
/// someone who didn't ask is the one failure that isn't merely annoying.
/// Observable, not merely readable. The composer cannot poll for this: on a cold
/// launch the intent may set it before any view exists, and on a warm one it
/// lands well after the view appeared and stopped looking. Only one of those two
/// is covered by checking on appearance, and which one happens is up to the
/// system. Bumping a counter lets the composer react whenever it arrives.
@Observable @MainActor
final class DictationRequest {
    static let shared = DictationRequest()
    private(set) var token = 0
    private var madeAt: Date?

    /// How long a pending request stays good. Long enough to cover a cold launch
    /// on a busy phone, short enough that it can't be mistaken for intent later.
    private static let window: TimeInterval = 20

    func make() {
        madeAt = Date()
        token &+= 1
    }

    /// Consume the request if there is a fresh one. Returns false otherwise, and
    /// clears a stale note so it can't fire later.
    func take() -> Bool {
        defer { madeAt = nil }
        guard let madeAt else { return false }
        return Date().timeIntervalSince(madeAt) < Self.window
    }
}

/// "Dictate to Maurice" — what the Action Button runs.
///
/// `openAppWhenRun` because the point is to land in the composer with the text:
/// transcribing in the background and filing it somewhere unseen would be a
/// different feature, and a worse one for a thought you want to keep working on.
struct DictateIntent: AppIntent {
    static var title: LocalizedStringResource = "Dictate to Maurice"
    static var description = IntentDescription(
        "Opens Maurice and starts listening, so you can speak a message instead of typing it."
    )
    static var openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        DictationRequest.shared.make()
        return .result()
    }
}

/// Publishing the shortcut is what makes Maurice appear in the Action Button's
/// list at all — third-party apps get there through Shortcuts, and an App
/// Shortcut is one the user doesn't have to assemble first.
struct MauriceShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: DictateIntent(),
            phrases: [
                "Dictate to \(.applicationName)",
                "Talk to \(.applicationName)",
                "Dicter à \(.applicationName)",
            ],
            shortTitle: "Dictate",
            systemImageName: "mic",
        )
    }
}
#endif
