import SwiftUI

/// A fact Maurice has just written down about you, waiting on your word.
///
/// The card is the notice. Maurice does not get to quietly learn things about
/// you: when he writes one down (`remember_fact`, `server/src/services/lifeFacts.ts`)
/// it arrives here, in the reply itself, and it reaches no prompt until you
/// have kept it. Two buttons, no menu, no drawer — the decision is small and
/// it should cost one tap.
struct LifeFactCard: View {
    @Environment(\.mauriceTheme) private var theme
    @Environment(SessionStore.self) private var session
    let data: JSONValue

    /// Undecided, kept, thrown away. Held here rather than re-fetched: the
    /// card is a moment in a transcript, and a transcript does not refresh.
    @State private var decision: String?
    @State private var working = false
    @State private var failed = false

    private var id: String { data.string("id") }
    private var text: String { data.string("text") }
    private var accent: Color { session.activeDeviceUser?.color ?? .blue }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "sparkles").font(.system(size: 11))
                Text(L("fact.heading")).font(.system(size: 12, weight: .medium))
            }
            .foregroundStyle(theme.inkSoft)

            Text(text)
                .font(.system(size: 14))
                .foregroundStyle(theme.ink)
                .fixedSize(horizontal: false, vertical: true)

            switch decision {
            case "kept": settled(L("fact.kept"), "checkmark.circle.fill")
            case "dismissed": settled(L("fact.dismissed"), "xmark.circle")
            default: buttons
            }

            if failed {
                Text(L("fact.failed")).font(.system(size: 11)).foregroundStyle(.red)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(theme.inkMute.opacity(0.06)))
    }

    private func settled(_ label: String, _ symbol: String) -> some View {
        HStack(spacing: 5) {
            Image(systemName: symbol).font(.system(size: 11))
            Text(label).font(.system(size: 12))
        }
        .foregroundStyle(theme.inkMute)
    }

    @ViewBuilder
    private var buttons: some View {
        HStack(spacing: 10) {
            Button { decide(keep: true) } label: {
                Text(L("fact.keep")).font(.system(size: 13, weight: .medium))
            }
            .buttonStyle(.borderedProminent)
            .tint(accent)
            Button { decide(keep: false) } label: {
                Text(L("fact.dismiss")).font(.system(size: 13))
            }
            .buttonStyle(.bordered)
            .tint(theme.inkMute)
            if working { ProgressView().controlSize(.small) }
        }
        .disabled(working)
        .padding(.top, 2)
    }

    private func decide(keep: Bool) {
        guard !id.isEmpty, let base = session.serverURL, let token = session.tokenForActiveUser else { return }
        working = true
        failed = false
        Task {
            struct Decided: Decodable { let state: String }
            let api = APIClient(baseURL: base)
            do {
                let r: Decided = try await api.post("/api/life-facts/\(id)/\(keep ? "keep" : "dismiss")", body: [String: String](), token: token)
                await MainActor.run {
                    decision = r.state
                    working = false
                }
            } catch {
                await MainActor.run {
                    failed = true
                    working = false
                }
            }
        }
    }
}
