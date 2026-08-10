import Foundation
import Speech
import AVFoundation

/// Speech-to-text for the composer.
///
/// Transcription runs **on the device**. Maurice's whole premise is a server in
/// your home and models you can point at yourself; shipping the household's
/// voice off to a transcription service to save a little accuracy would trade
/// away the thing that makes it worth running. `requiresOnDeviceRecognition`
/// enforces that — if the locale has no downloaded model, dictation reports it
/// rather than quietly falling back to the network.
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
        case audioSession
        case audioEngine

        var messageKey: String {
            switch self {
            case .speechDenied:    return "dictation.error.speech_denied"
            case .micDenied:       return "dictation.error.mic_denied"
            case .unavailable:     return "dictation.error.unavailable"
            case .noOnDeviceModel: return "dictation.error.no_offline_model"
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

    func toggle(locale: Locale) {
        isListening ? stop() : start(locale: locale)
    }

    func start(locale: Locale) {
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
                    self.beginListening(locale: locale)
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

    private func beginListening(locale: Locale) {
        // Fall back to the device locale when the app's language has no
        // recognizer — better to transcribe in the wrong language than not at
        // all, and the user hears the result immediately either way.
        let rec = SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer()
        guard let rec, rec.isAvailable else {
            state = .failed(.unavailable)
            return
        }
        guard rec.supportsOnDeviceRecognition else {
            // The language has no downloaded model. Name it: "this language has
            // no model" leaves the user guessing which one the app even asked
            // for, which is exactly the question they need answered.
            let name = locale.localizedString(forIdentifier: locale.identifier)
                ?? locale.identifier
            state = .failed(.noOnDeviceModel(language: name))
            return
        }
        recognizer = rec

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.requiresOnDeviceRecognition = true
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
        if !text.isEmpty { onFinish?(text) }
        transcript = ""
    }

    private func teardown() {
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
