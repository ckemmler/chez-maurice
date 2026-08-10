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

        var messageKey: String {
            switch self {
            case .speechDenied:    return "dictation.error.speech_denied"
            case .micDenied:       return "dictation.error.mic_denied"
            case .unavailable:     return "dictation.error.unavailable"
            case .noOnDeviceModel: return "dictation.error.no_offline_model"
            case .needsServerConsent: return "dictation.consent.body"
            case .audioSession:    return "dictation.error.audio_session"
            case .audioEngine:     return "dictation.error.audio_engine"
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
    /// What has been heard so far this session, including the unstable tail the
    /// recognizer may still revise.
    private(set) var transcript = ""

    var isListening: Bool { state == .listening }

    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let engine = AVAudioEngine()

    /// Called with the final text when listening stops for any reason, so the
    /// composer can append it in one piece.
    var onFinish: ((String) -> Void)?

    // MARK: - Control

    func toggle(locale: Locale, allowServer: Bool) {
        isListening ? stop() : start(locale: locale, allowServer: allowServer)
    }

    func start(locale: Locale, allowServer: Bool) {
        guard !isListening else { return }
        transcript = ""

        // Ask for both permissions up front. Speech authorisation gates the
        // recognizer; microphone authorisation gates the audio tap. Being
        // refused either one leaves us listening to nothing.
        SFSpeechRecognizer.requestAuthorization { [weak self] speechAuth in
            Task { @MainActor in
                guard let self else { return }
                guard speechAuth == .authorized else {
                    self.state = .failed(.speechDenied)
                    return
                }
                self.requestMicrophone { granted in
                    guard granted else {
                        self.state = .failed(.micDenied)
                        return
                    }
                    self.beginListening(locale: locale, allowServer: allowServer)
                }
            }
        }
    }

    func stop() {
        guard isListening else { return }
        finish()
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
        let siblings = SFSpeechRecognizer.supportedLocales()
            .filter { $0.language.languageCode?.identifier == language }
            // Prefer the variant for the region the device is set to, then take
            // the rest in a stable order. Enumeration order alone is arbitrary —
            // it would answer an Irish-English request with Philippine English
            // while the machine had British sitting right there.
            .sorted { a, b in
                let region = Locale.current.region?.identifier
                let aHome = a.region?.identifier == region
                let bHome = b.region?.identifier == region
                return aHome == bHome ? a.identifier < b.identifier : aHome
            }
        for candidate in siblings {
            if let rec = SFSpeechRecognizer(locale: candidate),
               rec.isAvailable, rec.supportsOnDeviceRecognition {
                return rec
            }
        }
        return nil
    }

    private func beginListening(locale: Locale, allowServer: Bool) {
        var onDevice = true
        var recognizer: SFSpeechRecognizer?

        if let rec = onDeviceRecognizer(for: locale) {
            recognizer = rec
        } else if allowServer {
            // The user has agreed that audio may go to Apple for languages with
            // no local model. Any available recogniser for the language will do
            // now, since the transcription happens server-side either way.
            onDevice = false
            recognizer = SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer()
        }

        guard let rec = recognizer, rec.isAvailable else {
            // Nothing usable. Separate "the model isn't installed" from "the
            // recogniser exists but isn't available right now" — the first asks
            // the user to go install something, and sending them to Settings
            // over a transient outage wastes their time on the wrong errand.
            let exists = SFSpeechRecognizer(locale: locale) != nil
            let available = SFSpeechRecognizer(locale: locale)?.isAvailable ?? false
            let language = locale.localizedString(forLanguageCode: locale.language.languageCode?.identifier ?? "")
                ?? locale.identifier
            if exists && !available {
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

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.requiresOnDeviceRecognition = onDevice
        request = req

        #if os(iOS)
        do {
            let session = AVAudioSession.sharedInstance()
            // .measurement keeps iOS from applying the processing it uses for
            // calls, which costs transcription accuracy.
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            state = .failed(.audioSession)
            return
        }
        #endif

        let input = engine.inputNode
        // Tap the node's own format. Hardcoding a rate here is the classic way
        // to crash on a device whose input runs at something else.
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak req] buffer, _ in
            req?.append(buffer)
        }

        engine.prepare()
        do {
            try engine.start()
        } catch {
            state = .failed(.audioEngine)
            teardown()
            return
        }

        task = rec.recognitionTask(with: req) { [weak self] result, error in
            Task { @MainActor in
                guard let self else { return }
                if let result {
                    self.transcript = result.bestTranscription.formattedString
                    if result.isFinal { self.finish() }
                } else if error != nil, self.isListening {
                    // A recogniser error after real speech still has a usable
                    // partial: keep what was heard rather than discarding it.
                    self.finish()
                }
            }
        }

        state = .listening
    }

    /// Stop everything and hand the text over exactly once.
    private func finish() {
        let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        teardown()
        if state == .listening { state = .idle }
        // Called even when nothing was heard: the composer keeps a note of what
        // the field held before dictation started, and this is what tells it to
        // let go. Skipping the empty case leaves that note behind, and the next
        // dictation rebuilds the field from a stale starting point.
        onFinish?(text)
        transcript = ""
    }

    private func teardown() {
        usingServer = false
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        recognizer = nil
        #if os(iOS)
        // Hand the audio route back so music resumes; failing to do so is a
        // "why did my podcast stop" bug, not a crash, which makes it easy to miss.
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }
}
