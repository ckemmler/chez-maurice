import SwiftUI

/// The question asked before anything a member writes reaches an AI provider
/// (App Review 5.1.2(i)): which providers, where, what is sent, and that
/// Maurice is an AI whose answers can be wrong. Shown after sign-in, for every
/// role, until the member answers — and again when a provider appears that
/// their yes does not cover. Settings → My data → AI providers changes it.
struct AIConsentView: View {
    @Environment(SessionStore.self) private var session
    @Environment(AIConsentStore.self) private var consent
    @Environment(\.mauriceTheme) private var theme
    @State private var busy = false

    private var accent: Color { session.activeDeviceUser?.color ?? .blue }

    var body: some View {
        ZStack {
            theme.bg.ignoresSafeArea()
            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        header
                        AIProviderList(providers: consent.providers, highlighted: Set(consent.newProviders.map(\.id)))
                        AIDataList()
                        notes
                    }
                    .frame(maxWidth: 560, alignment: .leading)
                    .padding(.horizontal, 24)
                    .padding(.top, 32)
                    .padding(.bottom, 16)
                    .frame(maxWidth: .infinity)
                }
                actions
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            BoaterHat(size: 34, color: theme.ink)
            Text(L("ai.consent.title"))
                .font(.wordmark(26))
                .foregroundStyle(theme.ink)
            if !consent.newProviders.isEmpty, consent.record?.status == "accepted" {
                Text(L("ai.consent.new_provider"))
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(accent.legible(onDark: theme.isDark))
            }
            Text(L("ai.consent.intro"))
                .font(.system(size: 15))
                .foregroundStyle(theme.inkSoft)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var notes: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(L("ai.consent.accuracy"), systemImage: "exclamationmark.bubble")
                .font(.system(size: 13.5, weight: .medium))
                .foregroundStyle(theme.ink)
            Text(L("ai.consent.local"))
                .font(.system(size: 12.5)).foregroundStyle(theme.inkMute)
            Text(L("ai.consent.footer"))
                .font(.system(size: 12.5)).foregroundStyle(theme.inkMute)
            Link(L("ai.consent.privacy"), destination: SafetyLinks.privacy)
                .font(.system(size: 12.5, weight: .medium))
                .tint(accent.legible(onDark: theme.isDark))
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private var actions: some View {
        VStack(spacing: 10) {
            Button {
                decide(true)
            } label: {
                Text(L("ai.consent.accept"))
                    .font(.system(size: 15, weight: .semibold))
                    .frame(maxWidth: 400)
                    .padding(.vertical, 10)
            }
            .glassProminentButton()
            .tint(accent)
            Button {
                decide(false)
            } label: {
                Text(L("ai.consent.decline"))
                    .font(.system(size: 15, weight: .medium))
                    .frame(maxWidth: 400)
                    .padding(.vertical, 10)
            }
            .glassBorderedButton()
        }
        .disabled(busy)
        .padding(.horizontal, 24)
        .padding(.top, 12)
        .padding(.bottom, 20)
        .background(theme.bg)
    }

    private func decide(_ accept: Bool) {
        busy = true
        Task {
            await consent.decide(accept: accept, session: session)
            busy = false
        }
    }
}

/// The providers, each with where it processes. Shared by the consent screen
/// and Settings → My data.
struct AIProviderList: View {
    @Environment(\.mauriceTheme) private var theme
    let providers: [AIProvider]
    var highlighted: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L("ai.consent.providers.header").uppercased())
                .font(.system(size: 11, weight: .semibold)).tracking(0.8)
                .foregroundStyle(theme.inkMute)
            if providers.isEmpty {
                Text(L("ai.consent.providers.none"))
                    .font(.system(size: 14)).foregroundStyle(theme.inkSoft)
            }
            ForEach(providers) { p in
                HStack(spacing: 10) {
                    Image(systemName: "server.rack")
                        .font(.system(size: 13))
                        .foregroundStyle(theme.inkSoft)
                        .frame(width: 22)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(p.name).font(.system(size: 14.5, weight: .semibold)).foregroundStyle(theme.ink)
                        if let place = p.place {
                            Text(place).font(.system(size: 12.5)).foregroundStyle(theme.inkMute)
                        }
                    }
                    Spacer(minLength: 0)
                    if highlighted.contains(p.id) {
                        Text(L("ai.consent.new")).font(.system(size: 11, weight: .semibold))
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background(Capsule().fill(theme.codeBg))
                            .foregroundStyle(theme.ink)
                    }
                }
                .padding(.vertical, 8).padding(.horizontal, 12)
                .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(theme.surface))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(theme.rule, lineWidth: 0.5))
            }
        }
    }
}

/// What goes to the providers.
struct AIDataList: View {
    @Environment(\.mauriceTheme) private var theme

    private let rows: [(String, String)] = [
        ("text.bubble", "ai.consent.data.messages"),
        ("paperclip", "ai.consent.data.attachments"),
        ("books.vertical", "ai.consent.data.context"),
        ("envelope", "ai.consent.data.mail"),
        ("square.and.arrow.down", "ai.consent.data.imports"),
        ("moon.stars", "ai.consent.data.night"),
        ("mic", "ai.consent.data.dictation"),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L("ai.consent.data.header").uppercased())
                .font(.system(size: 11, weight: .semibold)).tracking(0.8)
                .foregroundStyle(theme.inkMute)
            ForEach(rows, id: \.1) { icon, key in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Image(systemName: icon)
                        .font(.system(size: 12.5))
                        .foregroundStyle(theme.inkSoft)
                        .frame(width: 22)
                    Text(L(key))
                        .font(.system(size: 14))
                        .foregroundStyle(theme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

/// Above the composer while the member's answer is no: nothing is sent, and
/// the way back is one tap away.
struct AIDeclinedBanner: View {
    @Environment(\.mauriceTheme) private var theme
    let accent: Color
    let onReview: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "hand.raised")
                .font(.system(size: 14))
                .foregroundStyle(theme.inkSoft)
            VStack(alignment: .leading, spacing: 6) {
                Text(L("ai.consent.declined.banner"))
                    .font(.system(size: 13))
                    .foregroundStyle(theme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Button(L("ai.consent.declined.review"), action: onReview)
                    .font(.system(size: 13, weight: .semibold))
                    .buttonStyle(.plain)
                    .foregroundStyle(accent.legible(onDark: theme.isDark))
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(theme.surface))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(theme.rule, lineWidth: 0.5))
    }
}

/// The persona editor's question, when a model is chosen whose provider the
/// member has not accepted yet.
struct AIProviderAskSheet: View {
    @Environment(SessionStore.self) private var session
    @Environment(AIConsentStore.self) private var consent
    @Environment(\.mauriceTheme) private var theme
    @Environment(\.dismiss) private var dismiss
    let provider: AIProvider
    /// Called with true once the provider is accepted, false on cancel.
    let onDone: (Bool) -> Void
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L("ai.consent.ask.title"))
                .font(.system(size: 19, weight: .semibold))
                .foregroundStyle(theme.ink)
            AIProviderList(providers: [provider])
            Text(L("ai.consent.ask.text", provider.name))
                .font(.system(size: 14))
                .foregroundStyle(theme.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
            Text(L("ai.consent.accuracy"))
                .font(.system(size: 12.5)).foregroundStyle(theme.inkMute)
            HStack(spacing: 10) {
                Button(L("ai.consent.ask.cancel")) {
                    onDone(false); dismiss()
                }
                .glassBorderedButton()
                Spacer()
                Button(L("ai.consent.accept")) {
                    busy = true
                    Task {
                        await consent.accept(provider, session: session)
                        busy = false
                        onDone(consent.covers(provider.id))
                        dismiss()
                    }
                }
                .glassProminentButton()
                .disabled(busy)
            }
        }
        .padding(24)
        .frame(minWidth: 320, idealWidth: 440)
        .background(theme.bg)
        .presentationDetents([.medium, .large])
    }
}
