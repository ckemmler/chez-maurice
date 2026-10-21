#if DEBUG
import SwiftUI

// A page of sample replies, drawn by `ReplyText` — what a change to the
// renderer is checked against, on a device or a simulator that is not
// signed in to a household. Launch with `-ReplyGallery`.

struct ReplyGallery: View {
    static var requested: Bool { ProcessInfo.processInfo.arguments.contains("-ReplyGallery") }

    @State private var dark = ProcessInfo.processInfo.arguments.contains("-ReplyGalleryDark")
    @State private var sample = ReplyGallery.initialSample

    private static var initialSample: Int {
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-ReplyGallerySample"), i + 1 < args.count, let n = Int(args[i + 1]) { return n }
        return 0
    }

    private var theme: MauriceTheme { MauriceTheme.palette(dark ? "studio" : "cream") }

    var body: some View {
        if StreamProbe.chat {
            ChatProbeView().environment(\.mauriceTheme, theme)
        } else if StreamProbe.on {
            StreamProbeView().environment(\.mauriceTheme, theme)
        } else {
            gallery
        }
    }

    private var gallery: some View {
        VStack(spacing: 0) {
            HStack {
                Picker("", selection: $sample) {
                    ForEach(Self.samples.indices, id: \.self) { Text(Self.samples[$0].title).tag($0) }
                }
                .pickerStyle(.menu)
                Spacer()
                Toggle("Dark", isOn: $dark).fixedSize()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    HStack(spacing: 0) {
                        Spacer(minLength: 40)
                        ReplyText(markdown: Self.samples[sample].question)
                            .padding(.horizontal, 15)
                            .padding(.vertical, 11)
                            .background(RoundedRectangle(cornerRadius: 18).fill(theme.surfaceAlt))
                    }
                    ReplyText(markdown: Self.samples[sample].reply, menu: [
                        ReplyMenuItem(title: "Report message", systemImage: "flag") {}])
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(16)
            }
        }
        .background(theme.surface.ignoresSafeArea())
        .task {
            guard ProcessInfo.processInfo.arguments.contains("-ReplyGalleryBench") else { return }
            let all = Self.samples.map(\.reply).joined(separator: "\n\n")
            NSLog("REPLYBENCH %@", ReplyBenchmark.run(all, style: ReplyStyle(theme), width: 370))
        }
        .environment(\.mauriceTheme, theme)
        .preferredColorScheme(dark ? .dark : .light)
    }

    #if os(macOS)
    /// `-WindowSnapshot [seconds]`: draw the window into the container's tmp
    /// folder as reply-gallery.png — a check that needs no screen recording.
    @MainActor static func snapshotIfAsked() async {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-WindowSnapshot") else { return }
        let delay = i + 1 < args.count ? Double(args[i + 1]) ?? 1.5 : 1.5
        try? await Task.sleep(for: .seconds(delay))
        guard let view = NSApp.windows.first(where: { $0.isVisible })?.contentView else { return }
        // `-WindowSnapshotSelect`: every text selected, to see the selection
        // drawn over code panels and tables.
        if args.contains("-WindowSnapshotSelect") {
            func select(in v: NSView) {
                if let t = v as? NSTextView { t.setSelectedRange(NSRange(location: 0, length: t.string.utf16.count)) }
                v.subviews.forEach(select)
            }
            select(in: view)
            try? await Task.sleep(for: .seconds(0.3))
        }
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("reply-gallery.png")
        try? rep.representation(using: .png, properties: [:])?.write(to: url)
    }
    #endif

    struct Sample { let title: String; let question: String; let reply: String }

    static let samples: [Sample] = [
        Sample(title: "Prose", question: "Bonjour", reply: """
        Le **pain au levain** demande du temps, pas de la technique. Une *autolyse* d'une heure, puis des rabats toutes les demi-heures pendant la pointage.

        Le reste est affaire de patience : une nuit au froid, un four très chaud, et une [croûte bien cuite](https://fr.wikipedia.org/wiki/Pain_au_levain).
        Une ligne qui suit sans ligne vide.
        """),
        Sample(title: "Structure", question: "Peux-tu me faire un plan de la semaine, avec les courses et quelques notes ?", reply: """
        ## Plan de la semaine

        Voici une proposition, à ajuster selon vos soirées :

        1. **Lundi** — soupe de légumes et pain
        2. **Mardi** — gratin de courge
           - préparer la béchamel la veille
           - garder un peu de fromage pour le dessus
        3. **Mercredi** — reste du gratin

        ### Courses

        - poireaux, carottes, courge
        - fromage râpé
        - farine `T80`

        > Un plan simple tient mieux qu'un plan parfait.
        > Il laisse de la place pour l'imprévu.

        ---

        Bon appétit !
        """),
        Sample(title: "Code", question: "Comment lire un fichier en Swift ?", reply: """
        Le plus court passe par `String(contentsOf:)` :

        ```swift
        let url = URL(fileURLWithPath: "/tmp/notes.txt")
        let text = try String(contentsOf: url, encoding: .utf8)
        print(text.split(separator: "\\n").count, "lignes dans un fichier dont le nom est particulièrement long")
        ```

        Et sans langage :

        ```
        $ cat /tmp/notes.txt
        ```

        C'est tout.
        """),
        Sample(title: "Tables", question: "Compare les trois options.", reply: """
        | Option | Prix | Note |
        |---|---:|:-:|
        | A | 12 € | ★★ |
        | B | 9 € | ★★★ |
        | C | 15 € | ★ |

        Et un tableau trop large pour un téléphone :

        | Ville | Population | Particularité | Meilleure saison |
        |---|---|---|---|
        | Lyon | 520 000 | Capitale de la gastronomie française | Automne |
        | Marseille | 870 000 | Le plus vieux port de France | Printemps |

        Fin.
        """),
        Sample(title: "Math", question: "Rappelle-moi l'aire du disque.", reply: """
        L'aire d'un disque de rayon \\(r\\) vaut \\(A = \\pi r^2\\), et son périmètre \\(2\\pi r\\).

        $$\\int_0^r 2\\pi t \\, dt = \\pi r^2$$

        Pour \\(r = 3\\), on trouve environ 28,27.
        """),
        Sample(title: "Pasted", question: """
        ```pasted
        Une longue note collée depuis une autre application,
        sur plusieurs lignes.
        ```

        Peux-tu résumer ce texte ?
        """, reply: "En une phrase : c'est une note collée, *sur plusieurs lignes*."),
    ]
}
/// `-ReplyGalleryStream`: a reply streamed as a fast model sends it — bursts
/// of a few characters to a few words, about 350 a second — through the
/// streaming row, every reveal step logged (STREAMTICK).
enum StreamProbe {
    static let chat = ProcessInfo.processInfo.arguments.contains("-ReplyGalleryChat")
    static let on = chat || ProcessInfo.processInfo.arguments.contains("-ReplyGalleryStream")
}

/// `-ReplyGalleryChat`: the real thread view, thirty exchanges deep, with a
/// reply streamed in as the household's tunnel delivers one — a line of
/// about eleven characters every fifty milliseconds.
struct ChatProbeView: View {
    @Environment(ChatService.self) private var chat

    var body: some View {
        NavigationStack { ChatView() }
            .task {
                let now = ISO8601DateFormatter().string(from: Date())
                func msg(_ id: String, _ role: String, _ text: String) -> ServerMessage {
                    ServerMessage(id: id, role: role, content: text, model: nil, author_id: nil,
                                  data: nil, usage: nil, created_at: now)
                }
                var history: [ServerMessage] = []
                for i in 0..<30 {
                    let s = ReplyGallery.samples[i % 4]
                    history.append(msg("u\(i)", "user", s.question))
                    history.append(msg("a\(i)", "assistant", s.reply))
                }
                chat.activeConversationId = "probe"
                chat.messages = history
                try? await Task.sleep(for: .seconds(2))
                let all = Array(ReplyGallery.samples.prefix(4).map(\.reply).joined(separator: "\n\n"))
                chat.messages.append(msg("uq", "user", "Explique-moi tout."))
                chat.turnSerial += 1
                chat.isStreaming = true
                NSLog("STREAMSTART %d chars", all.count)
                var i = 0
                while i < all.count {
                    let n = Int.random(in: 1...22)
                    chat.streamingText += String(all[i..<min(all.count, i + n)])
                    i += n
                    try? await Task.sleep(for: .milliseconds(50))
                }
                NSLog("STREAMEND")
                let text = chat.streamingText
                chat.messages.append(msg("reply", "assistant", text))
                chat.finishing = ChatService.FinishingReply(id: "reply", conversationId: "probe", text: text,
                                                            blocks: [], activity: TurnActivity())
                chat.streamingText = ""
                chat.isStreaming = false
            }
    }
}

struct StreamProbeView: View {
    @State private var text = ""
    @State private var ended = false
    @State private var done = false

    /// The thread above: thirty finished replies, as in a long conversation.
    private static let history = (0..<30).map { ReplyGallery.samples[$0 % 4].reply }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    ForEach(Self.history.indices, id: \.self) { i in
                        ReplyText(markdown: Self.history[i])
                    }
                    if done {
                        ReplyText(markdown: text)
                    } else {
                        StreamingRow(text: text, serverBaseURL: "", ended: ended,
                                     onAdvance: { proxy.scrollTo("bottom", anchor: UnitPoint(x: 0, y: 1)) },
                                     onRevealed: { NSLog("STREAMDONE"); done = true })
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            // As the thread does: follow every token down.
            .onChange(of: text.count) { proxy.scrollTo("bottom", anchor: UnitPoint(x: 0, y: 1)) }
        }
        .task {
            let all = Array(ReplyGallery.samples.prefix(4).map(\.reply).joined(separator: "\n\n"))
            var rng = SystemRandomNumberGenerator()
            var i = 0
            try? await Task.sleep(for: .seconds(1))
            NSLog("STREAMSTART %d chars", all.count)
            while i < all.count {
                let n = Int.random(in: 2...24, using: &rng)
                text += String(all[i..<min(all.count, i + n)])
                i += n
                try? await Task.sleep(for: .milliseconds(Double(n) / 350 * 1000))
            }
            NSLog("STREAMEND")
            ended = true
        }
    }
}
#endif
