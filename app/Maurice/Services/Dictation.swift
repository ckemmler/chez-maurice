import Foundation
import Speech
import AVFoundation
import Accelerate

/// Speech-to-text for the composer.
///
/// Three engines, the best one available chosen at each start:
///
/// 1. **SpeechAnalyzer** (iOS and macOS 26) — Apple's long-form recogniser,
///    the one Notes and Voice Memos use, on the device. Words appear as they
///    are spoken and a pause doesn't end anything. The language's model is
///    fetched by the system ahead of the first dictation (`prefetchModel`);
///    while it isn't there yet another engine listens instead, and only when
///    none can does a start wait on the download, saying so.
/// 2. **The household's server** — the clip is recorded here and sent whole to
///    `/api/dictation`, where Whisper transcribes it (whisper.cpp on the home
///    server, or the household's provider). Used where SpeechAnalyzer isn't —
///    an older system, a language it lacks — or everywhere when the member
///    prefers it. No text until the recording stops; then the best text of the
///    three, with the household's names spelled right.
/// 3. **SFSpeechRecognizer** — the recogniser this file used to be, kept as the
///    last resort: no new API and no server reachable. Its on-device models are
///    the weakest, and not every language has one; the caller may pass
///    `allowServer`, which the user grants explicitly and can withdraw, to let
///    Apple's servers do it. It is never assumed, never silent, and while it is
///    in use `usingServer` is true so the UI can say so. It also transcribes a
///    recording the household's server could not.
///
/// The text lands in the composer for the user to read and edit; nothing is sent
/// on their behalf. Recognition mishears, and a mishearing that auto-sends costs
/// a whole turn to undo.

/// Where audio from the tap goes. Called on the realtime audio thread: no
/// awaiting, no main actor.
private protocol AudioSink: AnyObject {
    func consume(_ buffer: AVAudioPCMBuffer)
}

/// The tap's current destination, swapped by the main actor between sessions.
/// Locked rather than actor-isolated: the tap must not await.
private final class SinkBox: @unchecked Sendable {
    private let lock = NSLock()
    private var sink: AudioSink?

    func set(_ value: AudioSink?) {
        lock.lock(); defer { lock.unlock() }
        sink = value
    }

    func consume(_ buffer: AVAudioPCMBuffer) {
        lock.lock(); defer { lock.unlock() }
        sink?.consume(buffer)
    }
}

/// One microphone, several listeners: the recording for the household's
/// server and the on-device recogniser that previews it.
private final class FanOut: AudioSink {
    private let sinks: [AudioSink]
    init(_ sinks: [AudioSink]) { self.sinks = sinks }
    func consume(_ buffer: AVAudioPCMBuffer) {
        for sink in sinks { sink.consume(buffer) }
    }
}

/// Holds the live recognition request for the audio tap, which runs off the
/// main actor. Locked rather than actor-isolated: the tap must not await.
/// (SFSpeechRecognizer only.)
private final class RequestBox: AudioSink, @unchecked Sendable {
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

    func consume(_ buffer: AVAudioPCMBuffer) {
        append(FormatBridge.firstChannel(of: buffer))
    }

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

/// The microphone's buffers, in the one format a consumer wants.
///
/// The input node speaks whatever the hardware does — 48 kHz on a phone, ten
/// channels in the Simulator, something else again once AirPods connect — and
/// both the analyzer and the recording want 16 kHz mono. The converter is kept
/// across buffers (resampling carries state from one to the next) and rebuilt
/// only when the input format changes under it.
private final class FormatBridge {
    let target: AVAudioFormat
    private var converter: AVAudioConverter?

    init(target: AVAudioFormat) {
        self.target = target
    }

    func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        let mono = Self.firstChannel(of: buffer)
        if mono.format == target { return mono }
        if converter?.inputFormat != mono.format {
            converter = AVAudioConverter(from: mono.format, to: target)
        }
        guard let converter else { return nil }
        let ratio = target.sampleRate / mono.format.sampleRate
        let capacity = AVAudioFrameCount((Double(mono.frameLength) * ratio).rounded(.up)) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return nil }
        var fed = false
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, inputStatus in
            // One buffer per call, then "nothing yet" rather than "ended": an
            // end of stream would flush the resampler and click at every seam.
            if fed {
                inputStatus.pointee = .noDataNow
                return nil
            }
            fed = true
            inputStatus.pointee = .haveData
            return mono
        }
        guard status != .error, out.frameLength > 0 else { return nil }
        return out
    }

    /// The recogniser hears one voice on one channel. A phone's microphone is
    /// mono already; a USB interface on an iPad, or the Simulator (ten
    /// channels), is not — and handed those buffers the recogniser returns
    /// nothing at all, no text and no error. Keep the first channel.
    static func firstChannel(of buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer {
        let format = buffer.format
        guard format.channelCount > 1, !format.isInterleaved,
              let source = buffer.floatChannelData?[0],
              let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: format.sampleRate,
                                       channels: 1, interleaved: false),
              let copy = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buffer.frameLength),
              let target = copy.floatChannelData?[0]
        else { return buffer }
        copy.frameLength = buffer.frameLength
        target.update(from: source, count: Int(buffer.frameLength))
        return copy
    }
}

/// The clip for the household's server, written as it is spoken: AAC, 16 kHz
/// mono — what Whisper hears at anyway, and about a quarter of a megabyte a
/// minute to send.
private final class ClipRecorder: AudioSink, @unchecked Sendable {
    let url: URL
    private let lock = NSLock()
    private var file: AVAudioFile?
    private let bridge: FormatBridge
    private var frames: AVAudioFramePosition = 0

    init?(url: URL) {
        self.url = url
        let base: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
        ]
        // The bitrate is a wish: an encoder that won't take it for this rate
        // makes the init throw, and its own default is fine.
        var settings = base
        settings[AVEncoderBitRateKey] = 32_000
        guard let file = (try? AVAudioFile(forWriting: url, settings: settings,
                                           commonFormat: .pcmFormatFloat32, interleaved: false))
                ?? (try? AVAudioFile(forWriting: url, settings: base,
                                     commonFormat: .pcmFormatFloat32, interleaved: false))
        else { return nil }
        self.file = file
        self.bridge = FormatBridge(target: file.processingFormat)
    }

    func consume(_ buffer: AVAudioPCMBuffer) {
        lock.lock(); defer { lock.unlock() }
        guard let file, let converted = bridge.convert(buffer) else { return }
        do {
            try file.write(from: converted)
            frames += AVAudioFramePosition(converted.frameLength)
        } catch {
            // A full disk mid-sentence: keep what was written, stop writing.
            self.file = nil
        }
    }

    /// Close the file and say how long it is, in seconds.
    func close() -> TimeInterval {
        lock.lock(); defer { lock.unlock() }
        if #available(iOS 18.0, macOS 15.0, *) { file?.close() }
        // Before iOS 18 the file is finalised when its last reference goes,
        // which is this one.
        file = nil
        return Double(frames) / bridge.target.sampleRate
    }
}

/// Loudness of the microphone, measured inside the audio tap.
///
/// The tap sees ~40 buffers a second on a realtime thread. Each one is reduced
/// to its RMS here and only the loudest of every ~50ms window is handed on, so
/// the main actor gets twenty small numbers a second instead of the audio.
private final class LevelMeter: @unchecked Sendable {
    private let lock = NSLock()
    private var peak: Float = 0
    private var frames: AVAudioFrameCount = 0

    /// Feed one buffer; returns a level (0...1) when a window has closed.
    func measure(_ buffer: AVAudioPCMBuffer) -> Float? {
        guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return nil }
        var rms: Float = 0
        vDSP_rmsqv(samples, 1, &rms, vDSP_Length(buffer.frameLength))
        lock.lock(); defer { lock.unlock() }
        peak = max(peak, rms)
        frames += buffer.frameLength
        guard Double(frames) >= buffer.format.sampleRate * 0.05 else { return nil }
        // Speech sits roughly between -50 and -10 dBFS; map that span onto
        // 0...1 so a normal voice fills the bars and silence stays flat.
        let db = 20 * log10(max(peak, 1e-7))
        let level = min(1, max(0, (db + 50) / 40))
        peak = 0
        frames = 0
        return level
    }

    func reset() {
        lock.lock(); defer { lock.unlock() }
        peak = 0
        frames = 0
    }
}

/// The household's server, as dictation needs it: where it is and who is
/// asking. The composer builds one from the session; nil means "no server",
/// and the device does what it can on its own.
struct HouseholdTranscription: Sendable, Equatable {
    let baseURL: String
    let token: String
    /// The member chose the server over the device even where the device has
    /// a good recogniser (Settings › Dictation).
    let preferred: Bool

    /// The dictation route, whatever the stored address ends with.
    private var endpoint: String {
        (baseURL.hasSuffix("/") ? String(baseURL.dropLast()) : baseURL) + "/api/dictation"
    }

    /// What `GET /api/dictation` said, per server, for ten minutes. Asked
    /// only when the server is the candidate, so a device with SpeechAnalyzer
    /// never pays the round trip.
    @MainActor private static var known: [String: (available: Bool, local: Bool, at: Date)] = [:]
    @MainActor private static var unreachable: [String: Date] = [:]

    /// Whether this server transcribes, and whether it does so itself (the
    /// audio stays in the house) rather than through its provider. Nil when
    /// it could not be asked.
    @MainActor func capability() async -> (available: Bool, local: Bool)? {
        if let hit = Self.known[baseURL], Date().timeIntervalSince(hit.at) < 600 {
            return (hit.available, hit.local)
        }
        // A server that could not be asked is not asked again for a minute:
        // off the network, every tap would otherwise wait out the timeout.
        if let miss = Self.unreachable[baseURL], Date().timeIntervalSince(miss) < 60 { return nil }
        guard let url = URL(string: endpoint) else { return nil }
        var request = URLRequest(url: url, timeoutInterval: 3)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        struct Info: Decodable { let available: Bool; let engine: String? }
        guard let (data, response) = try? await URLSession.shared.data(for: request) else {
            Self.unreachable[baseURL] = Date()
            return nil
        }
        let status = (response as? HTTPURLResponse)?.statusCode
        // A server too old to have the route answers 404: that is a "no", and
        // worth remembering. Anything else is "couldn't ask".
        if status == 404 {
            Self.known[baseURL] = (false, false, Date())
            return (false, false)
        }
        guard status == 200, let info = try? JSONDecoder().decode(Info.self, from: data) else { return nil }
        Self.known[baseURL] = (info.available, info.engine == "local", Date())
        return (info.available, info.engine == "local")
    }

    /// Send a recorded clip; the text Whisper heard, or nil on any failure.
    func transcribe(_ file: URL, seconds: TimeInterval, language: String?) async -> String? {
        var components = URLComponents(string: endpoint)
        var query = [URLQueryItem(name: "duration", value: String(format: "%.1f", seconds))]
        if let language { query.append(URLQueryItem(name: "language", value: language)) }
        components?.queryItems = query
        guard let url = components?.url else { return nil }
        // Longer than the server may take on its own (conversion, then up to
        // two minutes of Whisper), so a long clip is not abandoned here while
        // the server is still producing — and, through a provider, billing — it.
        var request = URLRequest(url: url, timeoutInterval: 240)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("audio/mp4", forHTTPHeaderField: "Content-Type")
        struct Reply: Decodable { let text: String }
        guard let (data, response) = try? await URLSession.shared.upload(for: request, fromFile: file),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let reply = try? JSONDecoder().decode(Reply.self, from: data)
        else { return nil }
        return reply.text
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
        /// The recording was made, and neither the household's server nor the
        /// device could turn it into text.
        case transcriptionFailed

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
            case .transcriptionFailed: return "dictation.error.transcription_failed"
            }
        }
    }

    enum State: Equatable {
        case idle
        /// Permissions granted and an engine being readied — which, the first
        /// time a language is used with SpeechAnalyzer, includes downloading
        /// its model.
        case preparing
        case listening
        /// Listening has stopped and the text is on its way: the household's
        /// server is transcribing the clip, or the analyzer is finalising.
        case transcribing
        case failed(Failure)
    }

    /// Which engine the running session uses.
    enum Engine: Equatable {
        case analyzer
        case household
        case legacy
    }

    private(set) var state: State = .idle
    private(set) var engineInUse: Engine?
    /// True while the running session is transcribing through Apple's servers
    /// rather than on the device. The UI shows this: audio leaving the device is
    /// exactly the kind of thing that should be visible while it happens, not
    /// buried in a settings screen the user agreed to once.
    private(set) var usingServer = false
    /// True while the running session records for the household's server.
    private(set) var usingHousehold = false
    /// True while a recording for the household's server is also heard on the
    /// device, its words written as a preview that the server's text replaces
    /// at the end.
    private(set) var previewing = false
    /// While a start waits on the system downloading SpeechAnalyzer's model
    /// for the language — the first use, with nothing else to dictate with —
    /// how far along it is (0...1). The composer says what is happening: a
    /// first download can take minutes, and a spinner alone reads as broken.
    private(set) var modelDownloadProgress: Double?
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
    /// The live utterance's latest text and where its first word sits in the
    /// request's audio — what tells a revision apart from a fresh start.
    private var segment = ""
    private var segmentStart: TimeInterval = 0
    /// What has been heard so far this session, including the unstable tail the
    /// recognizer may still revise.
    private(set) var transcript = ""

    var isListening: Bool { state == .listening }
    /// Something is under way that isn't listening: an engine coming up, or
    /// text on its way. The mic shows progress and takes no taps meanwhile.
    var isBusy: Bool { state == .preparing || state == .transcribing }

    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    /// The tap's destination: the legacy request box, the analyzer's feed, or
    /// the clip being recorded.
    ///
    /// The tap runs on a realtime audio thread and cannot touch main-actor
    /// state, while the session swaps destinations. A small locked box is the
    /// whole of the synchronisation needed.
    private nonisolated let sinkBox = SinkBox()
    private nonisolated let requestBox = RequestBox()
    private nonisolated let levelMeter = LevelMeter()
    /// The microphone's recent loudness, oldest first, one value (0...1) per
    /// ~50ms — what the composer draws as a waveform while listening.
    private(set) var levels: [Float] = []
    /// Three seconds of history: more than the widest strip can show.
    static let levelHistory = 60
    /// The format the tap was installed with, to notice when a new input
    /// brings another.
    private var tapFormat: AVAudioFormat?
    /// Engine restarts after an input change, this session.
    private var restarts = 0
    private var task: SFSpeechRecognitionTask?
    private let engine = AVAudioEngine()

    /// The running analyzer session, typed loosely because its type only
    /// exists on 26.
    private var analyzerSession: AnyObject?
    /// The clip being recorded for the household's server.
    private var recorder: ClipRecorder?
    /// What this session was started with, for the recording's fallback.
    private var locale = Locale.current
    private var allowServer = false
    private var household: HouseholdTranscription?
    /// A failure to report once the text is delivered — an interruption that
    /// ended a recording still has a recording to transcribe.
    private var pendingFailure: Failure?

    /// Called with the final text when listening stops for any reason. The flag
    /// says whether the user asked for the stop — leaving the screen and
    /// backgrounding end dictation too, and the composer must not treat those
    /// like a deliberate "done".
    var onFinish: ((String, Bool) -> Void)?

    // MARK: - Control

    /// Start listening.
    ///
    /// - `household`: the household's server, for the engines that use it.
    /// - `vocabulary`: names the recogniser should expect — the household's
    ///   members, its Maurices. The server adds its own; this is for the device.
    func start(locale: Locale, allowServer: Bool,
               household: HouseholdTranscription? = nil, vocabulary: [String] = []) {
        // isListening only becomes true at the end of beginListening, after
        // async permission callbacks — so it cannot be the re-entrancy guard. A
        // double tap, or the Action Button racing a tap, otherwise runs
        // beginListening twice: the second overwrites the first's task without
        // cancelling it, and the orphan goes on writing the transcript until it
        // reports final and tears down the session that replaced it.
        guard !isListening, !isStarting, !isBusy else { return }
        isStarting = true
        generation &+= 1
        let attempt = generation
        transcript = ""
        committed = ""
        segment = ""
        pendingFailure = nil
        self.locale = locale
        self.allowServer = allowServer
        self.household = household
        // Back to idle before trying again. The composer reacts to `state`
        // changing, so leaving the previous failure in place meant a second
        // attempt that failed the same way assigned the same value, fired no
        // change, and showed nothing at all — a button that had simply died.
        state = .idle

        Task { @MainActor in
            // The microphone first: every engine needs it.
            guard await Self.microphoneGranted() else {
                guard attempt == self.generation else { return }
                self.isStarting = false
                self.state = .failed(.micDenied)
                return
            }
            guard attempt == self.generation else { return }
            self.state = .preparing
            let engine = await self.chooseEngine(locale: locale, household: household)
            guard attempt == self.generation else { return }

            // Speech authorisation gates Apple's recognisers, not a recording.
            if engine != .household {
                guard await Self.speechAuthorized() else {
                    guard attempt == self.generation else { return }
                    self.isStarting = false
                    self.state = .failed(.speechDenied)
                    return
                }
                guard attempt == self.generation else { return }
            }

            switch engine {
            case .analyzer:
                if #available(iOS 26.0, macOS 26.0, *) {
                    await self.beginAnalyzer(locale: locale, vocabulary: vocabulary, attempt: attempt)
                }
            case .household:
                await self.beginRecording(locale: locale, vocabulary: vocabulary, attempt: attempt)
            case .legacy:
                self.beginListening(locale: locale, allowServer: allowServer, vocabulary: vocabulary)
            }
        }
    }

    func stop(userStopped: Bool = false) {
        // A start in flight has to be cancellable. isListening only turns true
        // after async permission callbacks, so a stop() arriving before that —
        // leaving the chat, backgrounding the app — used to be a no-op, and the
        // callbacks then went on to activate the audio session and open the mic
        // with no composer on screen. Bumping the generation is what makes them
        // abandon: they compare against the value they captured.
        if isStarting {
            generation &+= 1
            isStarting = false
            // The download itself goes on, in the system; only the wait ends.
            modelDownloadProgress = nil
            if let session = analyzerSession {
                analyzerSession = nil
                if #available(iOS 26.0, macOS 26.0, *) { (session as? AnalyzerSession)?.cancel() }
            }
            teardown()   // the preview too
            state = .idle
            return
        }
        guard isListening else { return }
        finish(userStopped: userStopped)
    }

    // MARK: - Choosing

    /// The best engine for this start.
    ///
    /// The member's preference for the server wins where the server can take
    /// it; then SpeechAnalyzer where the system has it for this language; then
    /// the server; then the old recogniser.
    ///
    /// Unasked, the audio only goes to a server that transcribes it itself —
    /// whisper.cpp at home, where it never leaves the house. A household whose
    /// server hands clips on to its provider is used only by a member who
    /// chose the server in Settings.
    private func chooseEngine(locale: Locale, household: HouseholdTranscription?) async -> Engine {
        // Asked at most once per start, and only when the answer matters.
        var asked = false
        var capability: (available: Bool, local: Bool)?
        func serverCapability() async -> (available: Bool, local: Bool)? {
            if !asked, let household {
                capability = await household.capability()
                asked = true
            }
            return capability
        }
        if let household, household.preferred, await serverCapability()?.available ?? false {
            return .household
        }
        if #available(iOS 26.0, macOS 26.0, *), await AnalyzerSession.supports(locale) {
            if await AnalyzerAssets.isInstalled(locale) { return .analyzer }
            // The model isn't here yet. The system fetches it on its own and
            // keeps going if the app leaves — but that can take minutes, and
            // nobody should wait on it while another engine can listen now.
            AnalyzerAssets.ensure(locale)
            if let server = await serverCapability(), server.available, server.local {
                return .household
            }
            if legacyUsable(locale) { return .legacy }
            // Nothing else hears this language: wait, and say so.
            return .analyzer
        }
        if let server = await serverCapability(), server.available, server.local {
            return .household
        }
        return .legacy
    }

    /// Whether the old recogniser can take this language without asking
    /// anything of the user: a model on the device, or Apple's servers
    /// already allowed.
    private func legacyUsable(_ locale: Locale) -> Bool {
        if onDeviceRecognizer(for: locale) != nil { return true }
        return allowServer && anyRecognizer(for: locale)?.isAvailable == true
    }

    /// Have the system fetch SpeechAnalyzer's model for this language ahead
    /// of the first dictation, so the first tap doesn't wait on a download.
    /// The composer calls it when it appears; it does nothing before OS 26,
    /// when the model is already there, or for a language the analyzer lacks.
    static func prefetchModel(for locale: Locale) {
        if #available(iOS 26.0, macOS 26.0, *) {
            Task { @MainActor in
                guard await AnalyzerSession.supports(locale),
                      !(await AnalyzerAssets.isInstalled(locale)) else { return }
                AnalyzerAssets.ensure(locale)
            }
        }
    }

    // MARK: - Permissions

    private static func microphoneGranted() async -> Bool {
        await withCheckedContinuation { continuation in
            #if os(iOS)
            // AVAudioApplication is the iOS 17 home for this; AVAudioSession's
            // version is deprecated there.
            AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
            #else
            AVCaptureDevice.requestAccess(for: .audio) { continuation.resume(returning: $0) }
            #endif
        }
    }

    private static func speechAuthorized() async -> Bool {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
        }
    }

    // MARK: - Shared machinery

    /// Take the microphone: the audio session, the tap, the engine. On failure
    /// the state says why and false comes back.
    private func openMicrophone() -> Bool {
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
            return false
        }
        #endif

        levels = []
        levelMeter.reset()
        restarts = 0
        installTap()

        engine.prepare()
        do {
            try engine.start()
        } catch {
            teardown()
            isStarting = false
            state = .failed(.audioEngine)
            return false
        }

        observeInterruptions()
        return true
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
                // them. One that stopped it has moved the microphone, not taken
                // it: start again on the new input.
                guard !self.engine.isRunning else { return }
                self.resumeAfterReconfiguration()
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

    /// Tap the microphone in its current format, and remember that format.
    private func installTap() {
        let input = engine.inputNode
        // Tap the node's own format. Hardcoding a rate here is the classic way
        // to crash on a device whose input runs at something else.
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        tapFormat = format
        // Hand the buffer on synchronously, inside the tap. The buffer belongs
        // to the engine and its backing storage may be recycled the moment this
        // block returns, so hopping to the main actor first hands the
        // recogniser audio that has since been overwritten — garbled or dropped
        // words rather than a crash. It also kept ~50 buffers a second off the
        // main thread.
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            self.sinkBox.consume(buffer)
            if let level = self.levelMeter.measure(buffer) {
                Task { @MainActor [weak self] in self?.pushLevel(level) }
            }
        }
    }

    /// The input changed under a running session and the engine stopped: pick
    /// the microphone up again where it now is, rather than end the dictation.
    ///
    /// AirPods connecting mid-sentence do this, and so does the Simulator, which
    /// rebuilds its audio device a few milliseconds after every start. A real
    /// interruption — a call, Siri — arrives through the audio session instead
    /// and still ends the session.
    private func resumeAfterReconfiguration() {
        guard state == .listening else { return }
        // Bounded: an input that keeps collapsing is not coming back.
        guard restarts < 3 else { interrupted(); return }
        restarts += 1
        let previous = tapFormat
        installTap()
        engine.prepare()
        do {
            try engine.start()
        } catch {
            interrupted()
            return
        }
        // The analyzer and the recording convert whatever arrives; only the
        // old recogniser's request is tied to one format. If the new input
        // speaks another, bank what was heard and hand over to a fresh
        // request; the box holds the new audio meanwhile. Not endAudio(): an
        // utterance that had heard nothing yet ends in a "no speech" error,
        // which ends the whole session.
        if engineInUse == .legacy || (engineInUse == .household && previewing && analyzerSession == nil),
           let previous, let now = tapFormat, previous != now, let rec = recognizer {
            committed = transcript
            segment = ""
            requestBox.detach()
            let old = task
            listen(with: rec)
            old?.cancel()
        }
    }

    /// Deliver what was heard, then say why it stopped.
    private func interrupted() {
        guard state == .listening else { return }
        if engineInUse == .legacy {
            finish()
            // After finish(), which resets to .idle — the composer has the text
            // by then, so this only has to explain the stop.
            state = .failed(.interrupted)
        } else {
            // The text is still on its way; say why once it has arrived.
            pendingFailure = .interrupted
            finish()
        }
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
        let attempt = generation
        switch engineInUse {
        case .analyzer:
            let session = analyzerSession
            analyzerSession = nil
            stopMicrophone()
            state = .transcribing
            Task { @MainActor in
                var text = self.transcript
                if #available(iOS 26.0, macOS 26.0, *), let session = session as? AnalyzerSession {
                    text = await session.finish()
                }
                guard attempt == self.generation else { return }
                self.deliver(text, userStopped: userStopped)
            }
        case .household:
            let recorder = self.recorder
            self.recorder = nil
            stopMicrophone()
            // The preview has done its work; what it heard stands in should
            // the server not answer.
            let preview = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
            stopPreview()
            let seconds = recorder?.close() ?? 0
            state = .transcribing
            let household = self.household
            let locale = self.locale
            Task { @MainActor in
                defer { if let url = recorder?.url { try? FileManager.default.removeItem(at: url) } }
                var text: String?
                if let recorder, seconds > 0.3 {
                    text = await household?.transcribe(recorder.url, seconds: seconds,
                                                       language: locale.language.languageCode?.identifier)
                    // The server couldn't: the preview is the next best text,
                    // then the device tries the same clip, so what was said
                    // isn't lost to a dropped connection.
                    if text == nil, !preview.isEmpty { text = preview }
                    if text == nil {
                        text = await self.recogniseFile(recorder.url, locale: locale)
                    }
                } else {
                    text = ""   // A tap and a release: nothing was said.
                }
                guard attempt == self.generation else { return }
                if text == nil, self.pendingFailure == nil { self.pendingFailure = .transcriptionFailed }
                self.deliver(text ?? "", userStopped: userStopped)
            }
        case .legacy, nil:
            let text = transcript
            teardown()
            deliver(text, userStopped: userStopped)
        }
    }

    /// The text to the composer, and the session closed.
    private func deliver(_ raw: String, userStopped: Bool) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        teardown()
        state = .idle
        // Called even when nothing was heard: the composer keeps a note of what
        // the field held before dictation started, and this is what tells it to
        // let go. Skipping the empty case leaves that note behind, and the next
        // dictation rebuilds the field from a stale starting point.
        onFinish?(text, userStopped)
        transcript = ""
        if let failure = pendingFailure {
            pendingFailure = nil
            state = .failed(failure)
        }
    }

    private func pushLevel(_ level: Float) {
        guard isListening || isStarting else { return }
        levels.append(level)
        if levels.count > Self.levelHistory { levels.removeFirst(levels.count - Self.levelHistory) }
    }

    /// Release the microphone; leaves the session's own state alone.
    private func stopMicrophone() {
        removeInterruptionObservers()
        levels = []
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        sinkBox.set(nil)
        #if os(iOS)
        // Hand the audio route back so music resumes; failing to do so is a
        // "why did my podcast stop" bug, not a crash, which makes it easy to miss.
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }

    private func teardown() {
        stopMicrophone()
        stopPreview()
        usingServer = false
        usingHousehold = false
        engineInUse = nil
        committed = ""
        segment = ""
        request?.endAudio()
        task?.cancel()
        request = nil
        requestBox.clear()
        task = nil
        recognizer = nil
        if let recorder {
            _ = recorder.close()
            try? FileManager.default.removeItem(at: recorder.url)
            self.recorder = nil
        }
    }

    // MARK: - SpeechAnalyzer

    @available(iOS 26.0, macOS 26.0, *)
    private func beginAnalyzer(locale: Locale, vocabulary: [String], attempt: Int) async {
        // The model may still be downloading: show how far along, for as long
        // as this start is the current one.
        let watch = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self, attempt == self.generation else { return }
                self.modelDownloadProgress = AnalyzerAssets.progress(for: locale)
                try? await Task.sleep(nanoseconds: 250_000_000)
            }
        }
        defer {
            watch.cancel()
            modelDownloadProgress = nil
        }
        let session: AnalyzerSession
        do {
            session = try await AnalyzerSession.make(locale: locale, vocabulary: vocabulary) { [weak self] text in
                guard let self, attempt == self.generation, self.state == .listening else { return }
                self.transcript = text
            }
        } catch {
            guard attempt == generation else { return }
            // The new recogniser could not come up — a model that would not
            // download, most likely. The old one may still serve.
            beginListening(locale: locale, allowServer: allowServer, vocabulary: vocabulary)
            return
        }
        // Abandoned while the model was downloading.
        guard attempt == generation else {
            session.cancel()
            return
        }
        analyzerSession = session
        engineInUse = .analyzer
        sinkBox.set(session.feed)
        guard openMicrophone() else {
            analyzerSession = nil
            session.cancel()
            return
        }
        isStarting = false
        state = .listening
    }

    // MARK: - The household's server

    private func beginRecording(locale: Locale, vocabulary: [String], attempt: Int) async {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("dictation-\(UUID().uuidString).m4a")
        guard let recorder = ClipRecorder(url: url) else {
            isStarting = false
            state = .failed(.audioEngine)
            return
        }

        // A preview, so the words show as they are spoken: the server hears
        // the clip whole only at the end. On the device only — SpeechAnalyzer
        // if its model is here, else the old recogniser's local model — and
        // nothing if neither: the recording alone still makes the text.
        var sinks: [AudioSink] = [recorder]
        var legacyPreview: SFSpeechRecognizer?
        if await Self.speechAuthorized() {
            guard attempt == generation else { return }
            if #available(iOS 26.0, macOS 26.0, *),
               await AnalyzerSession.supports(locale), await AnalyzerAssets.isInstalled(locale),
               let session = try? await AnalyzerSession.make(locale: locale, vocabulary: vocabulary, onText: { [weak self] text in
                   guard let self, attempt == self.generation, self.state == .listening, self.previewing else { return }
                   self.transcript = text
               }) {
                guard attempt == generation else {
                    session.cancel()
                    return
                }
                analyzerSession = session
                sinks.append(session.feed)
            } else if let rec = onDeviceRecognizer(for: locale) {
                legacyPreview = rec
                self.recognizer = rec
                self.vocabulary = vocabulary
                sinks.append(requestBox)
            }
        }
        guard attempt == generation else { return }

        self.recorder = recorder
        engineInUse = .household
        usingHousehold = true
        previewing = sinks.count > 1
        sinkBox.set(sinks.count == 1 ? recorder : FanOut(sinks))
        guard openMicrophone() else { return }
        isStarting = false
        state = .listening
        if let legacyPreview { listen(with: legacyPreview) }
    }

    /// End the on-device preview of a recording; the recording goes on.
    private func stopPreview() {
        previewing = false
        if engineInUse == .household, let session = analyzerSession {
            analyzerSession = nil
            if #available(iOS 26.0, macOS 26.0, *) { (session as? AnalyzerSession)?.cancel() }
        }
        if engineInUse == .household {
            request?.endAudio()
            task?.cancel()
            request = nil
            task = nil
            requestBox.clear()
        }
    }

    /// Transcribe a recorded clip on the device — the household's server could
    /// not. On the device only, never through Apple: by now the mic shows
    /// progress, not a cloud, so audio leaving here would do so unseen.
    private func recogniseFile(_ url: URL, locale: Locale) async -> String? {
        guard await Self.speechAuthorized() else { return nil }
        guard let rec = onDeviceRecognizer(for: locale) else { return nil }
        let request = SFSpeechURLRecognitionRequest(url: url)
        request.requiresOnDeviceRecognition = true
        request.addsPunctuation = true
        request.shouldReportPartialResults = false
        final class Once: @unchecked Sendable {
            private let lock = NSLock()
            private var done = false
            func claim() -> Bool { lock.lock(); defer { lock.unlock() }; if done { return false }; done = true; return true }
        }
        let once = Once()
        return await withCheckedContinuation { continuation in
            let task = rec.recognitionTask(with: request) { result, error in
                if error != nil {
                    if once.claim() { continuation.resume(returning: nil) }
                } else if let result, result.isFinal {
                    if once.claim() { continuation.resume(returning: result.bestTranscription.formattedString) }
                }
            }
            // A task that never calls back would leave the mic spinning for
            // good. A minute is far longer than a dictated clip takes.
            Task {
                try? await Task.sleep(nanoseconds: 60_000_000_000)
                if once.claim() {
                    task.cancel()
                    continuation.resume(returning: nil)
                }
            }
        }
    }

    // MARK: - SFSpeechRecognizer

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

    private func beginListening(locale: Locale, allowServer: Bool, vocabulary: [String]) {
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
        self.vocabulary = vocabulary
        usingServer = !onDevice
        engineInUse = .legacy
        sinkBox.set(requestBox)

        guard openMicrophone() else { return }

        // State first: the task callback ignores anything arriving outside a
        // listening session, and the first result can land immediately.
        isStarting = false
        state = .listening
        listen(with: rec)
    }

    /// Names for the old recogniser's requests, kept for each new utterance.
    private var vocabulary: [String] = []

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
        // Full stops and question marks from the recogniser, which hears the
        // intonation; without it a dictated paragraph arrives as one run-on.
        req.addsPunctuation = true
        // The household's names, which a general model otherwise guesses at.
        req.contextualStrings = vocabulary
        request = req
        segment = ""
        segmentStart = 0
        requestBox.install(req)

        let generation = self.generation
        task = rec.recognitionTask(with: req) { [weak self] result, error in
            Task { @MainActor in
                guard let self, self.state == .listening else { return }
                // A task outlives the session that created it; without this an
                // orphan goes on writing the transcript of the session that
                // replaced it.
                guard generation == self.generation else { return }
                // Nor may a task that has been handed over — after an input
                // change it is cancelled, and its cancellation error must not
                // end the session its successor is running.
                guard self.request === req else { return }
                // Error FIRST. SFSpeechRecognitionTask routinely delivers a
                // non-nil result AND a non-nil error together (an on-device
                // asset fault, a dropped connection in server mode). Testing
                // `result` first made the error branch unreachable, so a final
                // result carrying a persistent fault spawned a replacement task,
                // which failed identically — an unbounded restart loop with the
                // microphone open and nothing ever surfaced to the user.
                if error != nil {
                    // A preview that fails costs only the preview: the
                    // recording for the server goes on.
                    if self.engineInUse == .household {
                        self.stopPreview()
                        return
                    }
                    // Whatever was heard is still worth keeping, so end rather
                    // than restart.
                    self.finish()
                    return
                }
                if let result {
                    let best = result.bestTranscription
                    let text = best.formattedString
                    let start = best.segments.first?.timestamp ?? 0
                    // After a pause the recogniser often starts over inside
                    // the same task, without ever reporting final: the next
                    // partial holds only the new words. Taking it at face value
                    // wiped the sentence just spoken from the composer and put
                    // the next one in its place. Bank the old one first.
                    if !result.isFinal,
                       Self.startedOver(from: self.segment, at: self.segmentStart, to: text, at: start) {
                        self.committed = Self.join(self.committed, self.segment)
                    }
                    self.segment = text
                    self.segmentStart = start
                    self.transcript = Self.join(self.committed, text)
                    if result.isFinal {
                        self.committed = self.transcript
                        self.segment = ""
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

    /// Whether a partial result begins a new utterance rather than revising
    /// the current one.
    ///
    /// Revisions keep the utterance's opening: the first word stays put in the
    /// audio and, give or take its capital, in the text. A fresh start moves
    /// the first word later in the audio — when the recogniser reports timings,
    /// which partial results don't always — or, failing that, opens on another
    /// word with less text than there was.
    nonisolated static func startedOver(from old: String, at oldStart: TimeInterval,
                                        to new: String, at newStart: TimeInterval) -> Bool {
        guard !old.isEmpty, !new.isEmpty else { return false }
        if oldStart > 0, newStart > oldStart + 1 { return true }
        func firstWord(_ s: String) -> Substring {
            s.split(whereSeparator: { $0.isWhitespace || $0.isPunctuation }).first ?? ""
        }
        let sameOpening = firstWord(old).lowercased() == firstWord(new).lowercased()
        return !sameOpening && new.count < old.count
    }

    /// Two spoken fragments, with a single space between them.
    ///
    /// A fragment ends where the speaker paused. When the next one opens on a
    /// capital the recogniser took it for a new sentence, so the previous one
    /// gets the full stop it is missing — the recogniser only punctuates within
    /// what it heard, never across the pause.
    nonisolated static func join(_ a: String, _ b: String) -> String {
        var left = a.trimmingCharacters(in: .whitespacesAndNewlines)
        let right = b.trimmingCharacters(in: .whitespacesAndNewlines)
        if left.isEmpty { return right }
        if right.isEmpty { return left }
        if let last = left.last, !".?!…:;".contains(last),
           right.first?.isUppercase == true {
            left += "."
        }
        return left + " " + right
    }
}

// MARK: - The analyzer's models

/// SpeechAnalyzer's per-language models, fetched by the system.
///
/// The download runs in the system, not in the app: measured on macOS 26
/// (16 October 2026), a request whose process was killed at 0 % went on to
/// `installed` by itself. So a fetch is started once per language and never
/// cancelled — leaving the app, or the composer, does not lose it — and
/// whoever needs the model awaits the same task.
@available(iOS 26.0, macOS 26.0, *)
@MainActor
enum AnalyzerAssets {
    private static var fetches: [String: Task<Bool, Never>] = [:]
    private static var progresses: [String: Progress] = [:]

    private static func module(for locale: Locale) async -> SpeechTranscriber? {
        guard let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else { return nil }
        return SpeechTranscriber(locale: supported, preset: .progressiveTranscription)
    }

    static func isInstalled(_ locale: Locale) async -> Bool {
        guard let module = await module(for: locale) else { return false }
        return await AssetInventory.status(forModules: [module]) == .installed
    }

    /// How far along this language's download is, while one is running.
    static func progress(for locale: Locale) -> Double? {
        progresses[locale.identifier]?.fractionCompleted
    }

    /// Fetch the model if it isn't here; true once it is.
    @discardableResult
    static func ensure(_ locale: Locale) -> Task<Bool, Never> {
        let key = locale.identifier
        if let running = fetches[key] { return running }
        let task = Task { @MainActor () -> Bool in
            defer {
                fetches[key] = nil
                progresses[key] = nil
            }
            guard let module = await module(for: locale) else { return false }
            do {
                if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
                    progresses[key] = request.progress
                    try await request.downloadAndInstall()
                }
                return true
            } catch {
                return false
            }
        }
        fetches[key] = task
        return task
    }
}

// MARK: - The analyzer session

/// One SpeechAnalyzer run: the transcriber, the stream the tap feeds, and the
/// text so far.
///
/// The analyzer hears the whole session as one recording, so it punctuates
/// across pauses and never starts over — none of the old recogniser's
/// utterance juggling applies here.
@available(iOS 26.0, macOS 26.0, *)
@MainActor
private final class AnalyzerSession {
    let feed: AnalyzerFeed
    private let analyzer: SpeechAnalyzer
    private let continuation: AsyncStream<AnalyzerInput>.Continuation
    private var results: Task<Void, Never>?
    /// Text the analyzer will not revise, and the tail it still may.
    private var finalized = ""
    private var volatile = ""
    private let onText: (String) -> Void

    private init(analyzer: SpeechAnalyzer, feed: AnalyzerFeed,
                 continuation: AsyncStream<AnalyzerInput>.Continuation, onText: @escaping (String) -> Void) {
        self.analyzer = analyzer
        self.feed = feed
        self.continuation = continuation
        self.onText = onText
    }

    /// Whether the device has the analyzer and it knows this language — model
    /// downloaded or not: `make` fetches it.
    static func supports(_ locale: Locale) async -> Bool {
        guard SpeechTranscriber.isAvailable else { return false }
        return await SpeechTranscriber.supportedLocale(equivalentTo: locale) != nil
    }

    static func make(locale: Locale, vocabulary: [String],
                     onText: @escaping (String) -> Void) async throws -> AnalyzerSession {
        guard let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else {
            throw CocoaError(.featureUnsupported)
        }
        // The model, the first time this language is used. The system
        // downloads it; nothing for the user to find in Settings.
        guard await AnalyzerAssets.ensure(locale).value else { throw CocoaError(.featureUnsupported) }
        let transcriber = SpeechTranscriber(locale: supported, preset: .progressiveTranscription)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        if !vocabulary.isEmpty {
            let context = AnalysisContext()
            context.contextualStrings[.general] = vocabulary
            try? await analyzer.setContext(context)
        }
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            throw CocoaError(.featureUnsupported)
        }
        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        let session = AnalyzerSession(analyzer: analyzer, feed: AnalyzerFeed(format: format, continuation: continuation),
                                      continuation: continuation, onText: onText)
        try await analyzer.prepareToAnalyze(in: format)
        session.results = Task { @MainActor [weak session] in
            do {
                for try await result in transcriber.results {
                    guard let session else { return }
                    let text = String(result.text.characters)
                    if result.isFinal {
                        session.finalized = Self.join(session.finalized, text)
                        session.volatile = ""
                    } else {
                        session.volatile = text
                    }
                    session.onText(session.text)
                }
            } catch {
                // The analyzer ended in error: what was finalised stands.
            }
        }
        try await analyzer.start(inputSequence: stream)
        return session
    }

    var text: String { Self.join(finalized, volatile) }

    /// End of input: let the analyzer finalise the tail, and give the whole text.
    func finish() async -> String {
        continuation.finish()
        // Finalising takes a moment; one that never ends would leave the mic
        // spinning for good, so after ten seconds what is there is what there is.
        let analyzer = self.analyzer
        let results = self.results
        let watchdog = Task {
            try? await Task.sleep(nanoseconds: 10_000_000_000)
            guard !Task.isCancelled else { return }
            await analyzer.cancelAndFinishNow()
            results?.cancel()
        }
        try? await analyzer.finalizeAndFinishThroughEndOfInput()
        await results?.value
        watchdog.cancel()
        // Anything still volatile at the very end is the best there is.
        return text
    }

    func cancel() {
        continuation.finish()
        results?.cancel()
        Task { await analyzer.cancelAndFinishNow() }
    }

    /// The analyzer's pieces carry their own spacing most of the time; this
    /// only makes sure two of them never touch or double up.
    private static func join(_ a: String, _ b: String) -> String {
        if a.isEmpty { return b.trimmingCharacters(in: .whitespaces) }
        if b.isEmpty { return a }
        let left = a.hasSuffix(" ") ? String(a.dropLast()) : a
        let right = b.trimmingCharacters(in: .whitespaces)
        return right.isEmpty ? left : left + " " + right
    }
}

/// The tap's side of the analyzer: buffers converted to the analyzer's format
/// and yielded into its input stream.
@available(iOS 26.0, macOS 26.0, *)
private final class AnalyzerFeed: AudioSink, @unchecked Sendable {
    private let lock = NSLock()
    private let bridge: FormatBridge
    private let continuation: AsyncStream<AnalyzerInput>.Continuation

    init(format: AVAudioFormat, continuation: AsyncStream<AnalyzerInput>.Continuation) {
        bridge = FormatBridge(target: format)
        self.continuation = continuation
    }

    func consume(_ buffer: AVAudioPCMBuffer) {
        lock.lock(); defer { lock.unlock() }
        guard let converted = bridge.convert(buffer) else { return }
        continuation.yield(AnalyzerInput(buffer: converted))
    }
}
