import Foundation
import Speech
import AVFoundation

/// Speech-to-text for the composer.
///
/// Transcription runs **on the device** whenever the language has a local model.
/// Maurice's premise is a server in your home and models you can point at
/// yourself, so audio does not leave the device by default.
///
/// Not every language has one, though: a phone can dictate French through the
/// keyboard all day and still expose no French model to SFSpeechRecognizer —
/// they are separate assets. Rather than leave the button dead for those
/// languages, the caller may pass `allowServer`, which the user grants
/// explicitly and can withdraw. It is never assumed, never silent, and while it
/// is in use `usingServer` is true so the UI can say so.
///
/// The text lands in the composer for the user to read and edit; nothing is sent
/// on their behalf. Recognition mishears, and a mishearing that auto-sends costs
/// a whole turn to undo.
/// Holds the live recognition request for the audio tap, which runs off the
/// main actor. Locked rather than actor-isolated: the tap must not await.
private final class RequestBox: @unchecked Sendable {
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    /// Audio captured while no request is installed, replayed into the next one.
    ///
    /// A pause ends an utterance, and the replacement request is only created
    /// once the recogniser's final result has travelled to the main actor —
    /// silence timeout plus delivery latency. Buffers arriving in that window
    /// used to be appended to a request that had already finished, which
    /// discards them: start speaking again promptly and the first syllables
    /// were gone. They are held here instead.
    private var pending: [AVAudioPCMBuffer] = []

    /// ~1024 frames each, so roughly two seconds at 44.1kHz. Enough to cover the
    /// handover; bounded so a stuck session can't grow without limit.
    private static let maxPending = 90

    /// Append to the live request, or hold the audio until one is installed.
    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock(); defer { lock.unlock() }
        if let request {
            request.append(buffer)
        } else if pending.count < Self.maxPending {
            pending.append(buffer)
        }
    }

    /// Install a request, replaying anything captured during the handover.
    func install(_ value: SFSpeechAudioBufferRecognitionRequest) {
        lock.lock(); defer { lock.unlock() }
        request = value
        for buffer in pending { value.append(buffer) }
        pending.removeAll(keepingCapacity: true)
    }

    /// Detach the current request without discarding what arrives next.
    func detach() {
        lock.lock(); defer { lock.unlock() }
        request = nil
    }

    /// Teardown: no request, and nothing held for a session that has ended.
    func clear() {
        lock.lock(); defer { lock.unlock() }
        request = nil
        pending.removeAll()
    }
}

/// Holds the composer's Dictation, built once.
///
/// SwiftUI evaluates a @State default on every view init; wrapping the object
/// means the AVAudioEngine is allocated once per view lifetime instead.
@MainActor
final class DictationHolder {
    lazy var dictation = Dictation()
    init() {}
}

@Observable @MainActor
final class Dictation {
    /// Why dictation couldn't start. A case rather than a message: the view owns
    /// wording, and it is the only thing holding the SessionStore that knows
    /// which language the user picked *in the app* — `String(localized:)` here
    /// would follow the system language and answer in the wrong one.
    enum Failure: Equatable {
        case speechDenied
        case micDenied
        case unavailable
        /// No downloaded on-device model for this language; carries it so the
        /// message can name it instead of saying "this language".
        case noOnDeviceModel(language: String)
        /// No on-device model, and the user hasn't agreed to send audio to
        /// Apple. Distinct from `noOnDeviceModel` because there is something the
        /// user can decide here, rather than something to go install.
        case needsServerConsent(language: String)
        case audioSession
        case audioEngine
        /// The system took the microphone mid-sentence — a call, Siri, a
        /// headset connecting. Distinct from the two above because nothing went
        /// wrong and nothing needs fixing: what was heard is kept, and the only
        /// thing to say is that dictation stopped there.
        case interrupted

        var messageKey: String {
            switch self {
            case .speechDenied:    return "dictation.error.speech_denied"
            case .micDenied:       return "dictation.error.mic_denied"
            case .unavailable:     return "dictation.error.unavailable"
            case .noOnDeviceModel: return "dictation.error.no_offline_model"
            case .needsServerConsent: return "dictation.consent.body"
            case .audioSession:    return "dictation.error.audio_session"
            case .audioEngine:     return "dictation.error.audio_engine"
            case .interrupted:     return "dictation.error.interrupted"
            }
        }
    }

    enum State: Equatable {
        case idle
        case listening
        case failed(Failure)
    }

    private(set) var state: State = .idle
    /// True while the running session is transcribing through Apple's servers
    /// rather than on the device. The UI shows this: audio leaving the device is
    /// exactly the kind of thing that should be visible while it happens, not
    /// buried in a settings screen the user agreed to once.
    private(set) var usingServer = false
    /// True between start() and the moment listening actually begins or fails.
    private var isStarting = false
    /// Bumped on every start() and every stop(). Each async continuation
    /// captures the value it began with and abandons itself if it no longer
    /// matches — which a shared boolean could not do: a second start() reset the
    /// flag and revived the first attempt's abandoned permission callback, so
    /// two sessions ran at once, each spawning recognition tasks.
    private var generation = 0
    private var interruptionObserver: NSObjectProtocol?
    private var configObserver: NSObjectProtocol?
    /// Utterances the recogniser has already finalised this session. A pause
    /// ends an utterance, not the session, so these accumulate and the live
    /// partial is appended to them rather than replacing them.
    private var committed = ""
    /// What has been heard so far this session, including the unstable tail the
    /// recognizer may still revise.
    private(set) var transcript = ""

    var isListening: Bool { state == .listening }

    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    /// The same request, reachable from the audio tap.
    ///
    /// The tap runs on a realtime audio thread and cannot touch main-actor
    /// state, while listen() swaps a fresh request in for each utterance. A
    /// small locked box is the whole of the synchronisation needed.
    private nonisolated let requestBox = RequestBox()
    private var task: SFSpeechRecognitionTask?
    private let engine = AVAudioEngine()

    /// Called with the final text when listening stops for any reason, so the
    /// composer can append it in one piece.
    /// Called with the final text when listening stops for any reason. The flag
    /// says whether the user asked for the stop — leaving the screen and
    /// backgrounding end dictation too, and the composer must not treat those
    /// like a deliberate "done".
    var onFinish: ((String, Bool) -> Void)?

    // MARK: - Control

    func toggle(locale: Locale, allowServer: Bool) {
        isListening ? stop(userStopped: true) : start(locale: locale, allowServer: allowServer)
    }

    func start(locale: Locale, allowServer: Bool) {
        // isListening only becomes true at the end of beginListening, after two
        // async permission callbacks — so it cannot be the re-entrancy guard. A
        // double tap, or the Action Button racing a tap, otherwise runs
        // beginListening twice: the second overwrites the first's task without
        // cancelling it, and the orphan goes on writing the transcript until it
        // reports final and tears down the session that replaced it.
        guard !isListening, !isStarting else { return }
        isStarting = true
        generation &+= 1
        let attempt = generation
        transcript = ""
        committed = ""
        // Back to idle before trying again. The composer reacts to `state`
        // changing, so leaving the previous failure in place meant a second
        // attempt that failed the same way assigned the same value, fired no
        // change, and showed nothing at all — a button that had simply died.
        state = .idle

        // Ask for both permissions up front. Speech authorisation gates the
        // recognizer; microphone authorisation gates the audio tap. Being
        // refused either one leaves us listening to nothing.
        SFSpeechRecognizer.requestAuthorization { [weak self] speechAuth in
            Task { @MainActor in
                guard let self else { return }
                // Abandoned while we were waiting on the permission sheet — or
                // superseded by a later attempt.
                guard attempt == self.generation else { return }
                guard speechAuth == .authorized else {
                    self.isStarting = false
                    self.state = .failed(.speechDenied)
                    return
                }
                self.requestMicrophone { granted in
                    guard attempt == self.generation else { return }
                    guard granted else {
                        self.isStarting = false
                        self.state = .failed(.micDenied)
                        return
                    }
                    self.beginListening(locale: locale, allowServer: allowServer)
                }
            }
        }
    }

    func stop(userStopped: Bool = false) {
        // A start in flight has to be cancellable. isListening only turns true
        // after two async permission callbacks, so a stop() arriving before that
        // — leaving the chat, backgrounding the app — used to be a no-op, and the
        // callbacks then went on to activate the audio session and open the mic
        // with no composer on screen. Bumping the generation is what makes them
        // abandon: they compare against the value they captured.
        if isStarting {
            generation &+= 1
            isStarting = false
            state = .idle
            return
        }
        guard isListening else { return }
        finish(userStopped: userStopped)
    }

    // MARK: - Machinery

    private func requestMicrophone(_ done: @escaping (Bool) -> Void) {
        #if os(iOS)
        // AVAudioApplication is the iOS 17 home for this; AVAudioSession's
        // version is deprecated there.
        AVAudioApplication.requestRecordPermission { granted in
            Task { @MainActor in done(granted) }
        }
        #else
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            Task { @MainActor in done(granted) }
        }
        #endif
    }

    /// A recognizer for this language that has its model on the device.
    ///
    /// Region is a preference, not a requirement. Someone with French (Belgium)
    /// installed and no French (France) is not missing French — asking for the
    /// exact identifier and giving up turns a working setup into a dead button,
    /// and tells them to install a second model of a language they already have.
    /// Try the exact locale, then any sibling of the same language that is
    /// actually downloaded.
    private func onDeviceRecognizer(for locale: Locale) -> SFSpeechRecognizer? {
        if let exact = SFSpeechRecognizer(locale: locale),
           exact.isAvailable, exact.supportsOnDeviceRecognition {
            return exact
        }
        guard let language = locale.language.languageCode?.identifier else { return nil }
        // Region-qualified siblings, device region first — enumeration order
        // alone would answer an Irish-English request with Philippine English
        // while the machine had British sitting right there.
        for candidate in Self.siblings(of: language) {
            if let rec = SFSpeechRecognizer(locale: candidate),
               rec.isAvailable, rec.supportsOnDeviceRecognition {
                return rec
            }
        }
        return nil
    }

    /// Any recogniser for this language, on-device or not.
    ///
    /// The app's language picker stores bare codes ("fr", "de"), while
    /// SFSpeechRecognizer's supported set is region-qualified ("fr-FR",
    /// "fr-BE"). Bare `SFSpeechRecognizer(locale:)` therefore returns nil for
    /// every language the picker can produce — which made `exists` false, so the
    /// classifier below always answered "Apple has no recogniser for this
    /// language", `.needsServerConsent` was never reached, the consent alert
    /// never appeared, and the allow-server toggle could not take effect at all.
    private func anyRecognizer(for locale: Locale) -> SFSpeechRecognizer? {
        if let exact = SFSpeechRecognizer(locale: locale) { return exact }
        guard let language = locale.language.languageCode?.identifier else { return nil }
        for candidate in Self.siblings(of: language) {
            if let rec = SFSpeechRecognizer(locale: candidate) { return rec }
        }
        return nil
    }

    /// Locales for a language, device region first then stable order.
    private static func siblings(of language: String) -> [Locale] {
        SFSpeechRecognizer.supportedLocales()
            .filter { $0.language.languageCode?.identifier == language }
            .sorted { a, b in
                let region = Locale.current.region?.identifier
                let aHome = a.region?.identifier == region
                let bHome = b.region?.identifier == region
                return aHome == bHome ? a.identifier < b.identifier : aHome
            }
    }

    private func beginListening(locale: Locale, allowServer: Bool) {
        var onDevice = true
        var recognizer: SFSpeechRecognizer?

        if let rec = onDeviceRecognizer(for: locale) {
            recognizer = rec
        } else if allowServer, let server = anyRecognizer(for: locale) {
            // The user has agreed that audio may go to Apple for languages with
            // no local model. Only a recogniser *for this language* will do: the
            // old fallback to the device default meant agreeing to dictate in
            // Icelandic and getting the words transcribed as English, which is
            // worse than refusing.
            onDevice = false
            recognizer = server
        }

        guard let rec = recognizer, rec.isAvailable else {
            // Nothing usable. Separate "the model isn't installed" from "the
            // recogniser exists but isn't available right now" — the first asks
            // the user to go install something, and sending them to Settings
            // over a transient outage wastes their time on the wrong errand.
            let candidate = anyRecognizer(for: locale)
            let exists = candidate != nil
            let available = candidate?.isAvailable ?? false
            let language = locale.localizedString(forLanguageCode: locale.language.languageCode?.identifier ?? "")
                ?? locale.identifier
            isStarting = false
            if !exists {
                // Apple has no recogniser for this language at all. Neither a
                // local model nor consent changes that, so don't offer either.
                state = .failed(.noOnDeviceModel(language: language))
            } else if !available {
                state = .failed(.unavailable)
            } else if !allowServer {
                // There *is* a way forward — it's just one only the user can
                // authorise. Offer the decision instead of a dead end.
                state = .failed(.needsServerConsent(language: language))
            } else {
                // Name the language, not the locale: the fix is "install French",
                // and naming a region would be the wrong instruction for someone
                // running French (Belgium).
                state = .failed(.noOnDeviceModel(language: language))
            }
            return
        }
        self.recognizer = rec
        usingServer = !onDevice

        #if os(iOS)
        do {
            let session = AVAudioSession.sharedInstance()
            // .measurement keeps iOS from applying the processing it uses for
            // calls, which costs transcription accuracy.
            //
            // No .duckOthers: the option is only valid on .playAndRecord,
            // .playback and .multiRoute, and setting it on .record throws
            // BadParam — which our catch turns into "couldn't take over the
            // microphone", i.e. dictation that never works on a real device.
            // The Simulator doesn't enforce the option/category pairing, so this
            // stayed invisible in development.
            try session.setCategory(.record, mode: .measurement)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            // Tear down like every other failure path: setCategory may have
            // succeeded before setActive threw, leaving other apps' audio ducked
            // with nothing to un-duck it.
            teardown()
            isStarting = false
            state = .failed(.audioSession)
            return
        }
        #endif

        let input = engine.inputNode
        // Tap the node's own format. Hardcoding a rate here is the classic way
        // to crash on a device whose input runs at something else.
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        // Weak self, not the request: a new utterance swaps in a new request,
        // and a tap still feeding the old one would go into a task nobody reads.
        // Append synchronously, inside the tap. The buffer belongs to the engine
        // and its backing storage may be recycled the moment this block returns,
        // so hopping to the main actor first hands the recogniser audio that has
        // since been overwritten — garbled or dropped words rather than a crash.
        // It also kept ~50 buffers a second off the main thread.
        //
        // The box is locked because the tap runs on a realtime audio thread
        // while listen() swaps the request in per utterance — and it holds the
        // audio when no request is installed, rather than dropping it.
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.requestBox.append(buffer)
        }

        engine.prepare()
        do {
            try engine.start()
        } catch {
            teardown()
            isStarting = false
            state = .failed(.audioEngine)
            return
        }

        observeInterruptions()

        // State first: the task callback ignores anything arriving outside a
        // listening session, and the first result can land immediately.
        isStarting = false
        state = .listening
        listen(with: rec)
    }

    /// Notice when the system takes the microphone away.
    ///
    /// A call, a Siri invocation or a headset connecting stops the engine
    /// underneath us. Nothing tells the session: `state` stayed `.listening`,
    /// so the mic went on pulsing over a recording that had ended, the
    /// transcript quietly stopped growing, and everything said from that moment
    /// was lost with no indication at all. Ending the session honestly is worth
    /// more than trying to resume one whose audio already has a hole in it —
    /// what was heard is delivered to the composer either way.
    private func observeInterruptions() {
        // Idempotent: registering twice would leave an observer behind that
        // outlives the session and stops the next one on a stale notification.
        removeInterruptionObservers()
        let centre = NotificationCenter.default

        // The engine's own signal: the input format changed under it (a route
        // change, a headset arriving). It also covers macOS, which has no
        // AVAudioSession at all.
        configObserver = centre.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                // This fires for any I/O change, and the engine survives most of
                // them — plugging in headphones mid-sentence should not end the
                // dictation. Only a change that actually stopped the engine has
                // taken the microphone away.
                guard !self.engine.isRunning else { return }
                self.interrupted()
            }
        }

        #if os(iOS)
        interruptionObserver = centre.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(), queue: .main
        ) { [weak self] note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            guard raw == AVAudioSession.InterruptionType.began.rawValue else { return }
            Task { @MainActor in self?.interrupted() }
        }
        #endif
    }

    private func removeInterruptionObservers() {
        let centre = NotificationCenter.default
        if let configObserver { centre.removeObserver(configObserver) }
        if let interruptionObserver { centre.removeObserver(interruptionObserver) }
        configObserver = nil
        interruptionObserver = nil
    }

    /// Deliver what was heard, then say why it stopped.
    private func interrupted() {
        guard state == .listening else { return }
        finish()
        // After finish(), which resets to .idle — the composer has the text by
        // then, so this only has to explain the stop.
        state = .failed(.interrupted)
    }

    /// Run one utterance, and start the next when it ends.
    ///
    /// A pause makes the recogniser finalise what it has and close the task. That
    /// is the end of an utterance, not of the session: treating it as the end
    /// stopped dictation at the first breath, and — because the composer anchors
    /// on the text as it was when dictation began — each new burst replaced the
    /// last instead of continuing it. Finalised text is banked here and a fresh
    /// task takes over, so speaking in four goes reads as one sentence.
    private func listen(with rec: SFSpeechRecognizer) {
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.requiresOnDeviceRecognition = !usingServer
        request = req
        requestBox.install(req)

        let generation = self.generation
        task = rec.recognitionTask(with: req) { [weak self] result, error in
            Task { @MainActor in
                guard let self, self.state == .listening else { return }
                // A task outlives the session that created it; without this an
                // orphan goes on writing the transcript of the session that
                // replaced it.
                guard generation == self.generation else { return }
                // Error FIRST. SFSpeechRecognitionTask routinely delivers a
                // non-nil result AND a non-nil error together (an on-device
                // asset fault, a dropped connection in server mode). Testing
                // `result` first made the error branch unreachable, so a final
                // result carrying a persistent fault spawned a replacement task,
                // which failed identically — an unbounded restart loop with the
                // microphone open and nothing ever surfaced to the user.
                if error != nil {
                    // Whatever was heard is still worth keeping, so end rather
                    // than restart.
                    self.finish()
                    return
                }
                if let result {
                    let segment = result.bestTranscription.formattedString
                    self.transcript = Self.join(self.committed, segment)
                    if result.isFinal {
                        self.committed = self.transcript
                        // Close the finished request and let the box hold what
                        // arrives until the replacement is installed a line
                        // later — the recogniser has stopped consuming, and
                        // appending to it now would silently drop the audio.
                        self.request?.endAudio()
                        self.requestBox.detach()
                        self.listen(with: rec)   // next utterance
                    }
                }
            }
        }
    }

    /// Two spoken fragments, with a single space between them.
    private static func join(_ a: String, _ b: String) -> String {
        let left = a.trimmingCharacters(in: .whitespacesAndNewlines)
        let right = b.trimmingCharacters(in: .whitespacesAndNewlines)
        if left.isEmpty { return right }
        if right.isEmpty { return left }
        return left + " " + right
    }

    /// Stop everything and hand the text over exactly once.
    ///
    /// Twice was possible and it showed: a final result and an error can both
    /// arrive for the same session, and each delivery appended the same words
    /// again. The guard is what makes the doc comment above true.
    private func finish(userStopped: Bool = false) {
        guard state == .listening else { return }
        // Retire this session's generation too, so a recognition callback still
        // in flight can't reopen it after teardown.
        generation &+= 1
        let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        teardown()
        state = .idle
        // Called even when nothing was heard: the composer keeps a note of what
        // the field held before dictation started, and this is what tells it to
        // let go. Skipping the empty case leaves that note behind, and the next
        // dictation rebuilds the field from a stale starting point.
        onFinish?(text, userStopped)
        transcript = ""
    }

    private func teardown() {
        removeInterruptionObservers()
        usingServer = false
        committed = ""
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
        request = nil
        requestBox.clear()
        task = nil
        recognizer = nil
        #if os(iOS)
        // Hand the audio route back so music resumes; failing to do so is a
        // "why did my podcast stop" bug, not a crash, which makes it easy to miss.
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }
}
