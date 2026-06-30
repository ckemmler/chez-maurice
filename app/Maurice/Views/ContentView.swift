import SwiftUI

/// Runtime device idiom. iPad gets the system-toolbar chrome (so iPadOS 26 hosts
/// the window controls + sidebar toggle inline); iPhone keeps its custom header.
/// Idiom never changes at runtime, so it's safe to read once.
enum Platform {
    static let isPad: Bool = {
        #if os(iOS)
        UIDevice.current.userInterfaceIdiom == .pad
        #else
        false
        #endif
    }()
}

struct ContentView: View {
    @Environment(SessionStore.self) private var session
    @Environment(ChatService.self) private var chat
    @Environment(MauriceStore.self) private var maurices
    @Environment(StudioState.self) private var studio
    @Environment(GardensStore.self) private var gardens
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var hSize
    #endif

    @State private var isLoading = true
    // On iPhone the split view collapses to one column; default to the chat
    // (detail) and let the user reveal the sidebar, instead of being stuck on it.
    @State private var preferredColumn: NavigationSplitViewColumn = .detail
    // iPad/regular-width sidebar show/hide, driven by the toolbar's sidebar toggle.
    @State private var columnVisibility: NavigationSplitViewVisibility = .automatic
    // Bumped on acknowledge so `body` re-evaluates `needsDisclosure`.
    @State private var disclosureAck = false

    /// Show the connect disclosure once per server host for non-owner sessions.
    private var needsDisclosure: Bool {
        guard session.hasActiveSession,
              (session.activeDeviceUser?.role ?? "") != "admin",
              let host = session.serverHost else { return false }
        return !ConnectDisclosure.acknowledged(host)
    }

    var body: some View {
        let theme = MauriceTheme.named(session.palette, colorScheme: colorScheme)
        let _ = disclosureAck // create the dependency so acknowledge re-renders

        Group {
            if !session.isPaired {
                PairingView()
            } else if !session.hasActiveSession {
                UserPickerView()
            } else if isLoading {
                HatLoader()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(theme.bg)
                .task {
                    // Hold the loader for at least 2s so the hat animation reads,
                    // running concurrently with the load — slower loads still show
                    // until they finish (total = max(loadTime, 2s)).
                    async let minHold: Void = Task.sleep(for: .seconds(2))
                    async let prefs: () = session.loadPreferences()
                    async let personas: () = maurices.load()
                    await chat.onUserSwitch()
                    await prefs
                    await personas
                    // Anchor the conversation filter on the active conversation's
                    // Maurice (the most-recent one, after onUserSwitch selects it).
                    studio.currentMauriceId = chat.activeConversation?.maurice_id
                    try? await minHold
                    isLoading = false
                    // Foyer badges are non-critical — refresh them in the
                    // background so they never delay showing the UI.
                    Task { await session.refreshFoyers() }
                }
            } else {
                NavigationSplitView(columnVisibility: $columnVisibility,
                                    preferredCompactColumn: $preferredColumn) {
                    SidebarView(onActivateConversation: { preferredColumn = .detail })
                        #if os(macOS)
                        .navigationSplitViewColumnWidth(min: 220, ideal: 240, max: 560)
                        #endif
                } detail: {
                    // The garden tool page fills the main pane while a garden is
                    // open; everything else is the chat. If a reload dissolves
                    // the open garden (its last note moved on), fall back to chat.
                    Group {
                        if let gid = gardens.openGardenId, let g = gardens.garden(gid) {
                            GardenPageView(garden: g,
                                           onOpenSidebar: { preferredColumn = .sidebar },
                                           onToggleSidebar: toggleSidebar)
                        } else {
                            ChatView(onOpenSidebar: { preferredColumn = .sidebar },
                                     onToggleSidebar: toggleSidebar)
                        }
                    }
                    #if os(iOS)
                    // Visibility-driven (not a conditional modifier) so it survives
                    // branch switches — a toolbar modifier inside a conditional
                    // branch can fail to apply. Hidden on iPhone (custom header);
                    // visible on iPad so the system hosts the window controls +
                    // sidebar toggle in a real bar.
                    .toolbar(Platform.isPad ? .visible : .hidden, for: .navigationBar)
                    #endif
                }
                #if os(iOS)
                .navigationSplitViewStyle(.balanced)
                #endif
            }
        }
        .environment(\.mauriceTheme, theme)
        .preferredColorScheme(MauriceTheme.colorSchemeOverride(for: session.palette))
        // Blocking connect disclosure (once per non-owned server host). Sits over
        // everything; "Cancel" disconnects.
        .overlay {
            if needsDisclosure, let host = session.serverHost {
                ConnectDisclosureOverlay(
                    onAccept: { ConnectDisclosure.acknowledge(host); disclosureAck.toggle() },
                    onCancel: { session.unpair() }
                )
            }
        }
        .sheet(isPresented: pickerBinding) {
            MauricePicker(onActivate: { preferredColumn = .detail })
        }
        #if os(iOS)
        .fullScreenCover(isPresented: creatorBinding) { creatorView }
        #else
        .sheet(isPresented: creatorBinding) { creatorView }
        #endif
        .onChange(of: session.hasActiveSession) {
            isLoading = true
        }
        // Switching to another logged-in household reloads its data via the
        // loader (onUserSwitch). A no-session household just shows the picker.
        .onChange(of: session.currentHouseholdId) {
            if session.hasActiveSession { isLoading = true }
        }
        .onChange(of: scenePhase) { chat.appActive = (scenePhase == .active) }
    }

    /// The toolbar's sidebar toggle. When collapsed (compact — a narrow/tiled
    /// window the split view shows as a stack), reveal the list via the compact
    /// column; when expanded (regular), show/hide the sidebar column.
    private func toggleSidebar() {
        #if os(iOS)
        if hSize == .compact {
            preferredColumn = (preferredColumn == .sidebar) ? .detail : .sidebar
            return
        }
        #endif
        columnVisibility = (columnVisibility == .detailOnly) ? .doubleColumn : .detailOnly
    }

    private var pickerBinding: Binding<Bool> {
        Binding(get: { studio.showPicker }, set: { studio.showPicker = $0 })
    }
    private var creatorBinding: Binding<Bool> {
        Binding(get: { studio.draft != nil }, set: { if !$0 { studio.closeCreator() } })
    }

    @ViewBuilder
    private var creatorView: some View {
        if let draft = studio.draft {
            PersonaCreator(draft: draft, isEdit: studio.draftIsEdit, session: session)
        }
    }
}

// MARK: - Connect disclosure (shown once per non-owned server host)

/// Per-host acknowledgment of the "before you connect" disclosure (local only).
enum ConnectDisclosure {
    private static func key(_ host: String) -> String { "maurice.connect_disclosure.\(host)" }
    static func acknowledged(_ host: String) -> Bool { UserDefaults.standard.bool(forKey: key(host)) }
    static func acknowledge(_ host: String) { UserDefaults.standard.set(true, forKey: key(host)) }
}

/// Blocking modal a non-owner must acknowledge before entering a server they
/// don't operate. "Cancel" disconnects. Copy is verbatim per the safety spec.
struct ConnectDisclosureOverlay: View {
    var onAccept: () -> Void
    var onCancel: () -> Void

    var body: some View {
        ZStack {
            Color.black.opacity(0.55).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 16) {
                Text("Before you connect").font(.title2).bold()
                Text("You're joining a Maurice server run by someone else.")
                VStack(alignment: .leading, spacing: 10) {
                    bullet("The operator of this server controls how Maurice behaves here — its personality and its instructions.")
                    bullet("Anything you post in a shared room is visible to other members of that room, and to the operator.")
                    bullet("Your private conversations stay private. Maurice keeps each member's personal data isolated, and the operator cannot read it.")
                    bullet("You can leave any room, block other members, and report content at any time.")
                }
                Text("If you weren't expecting to join this server, or someone you don't know asked you to install Maurice and connect here, don't connect.")
                    .bold()
                HStack(spacing: 12) {
                    Button("Cancel", role: .cancel, action: onCancel)
                        .buttonStyle(.bordered)
                    Spacer()
                    Button("I understand — Connect", action: onAccept)
                        .buttonStyle(.borderedProminent)
                }
                .padding(.top, 4)
            }
            .padding(28)
            .frame(maxWidth: 460)
            .background(RoundedRectangle(cornerRadius: 18).fill(.regularMaterial))
            .shadow(radius: 24)
            .padding(24)
        }
    }

    private func bullet(_ s: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text("•")
            Text(s)
        }
    }
}
