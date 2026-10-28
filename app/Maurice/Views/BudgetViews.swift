import SwiftUI

/// The member's budget as a ring: full when nothing is spent, shrinking as the
/// share runs down; full with ∞ in the middle when the household holds no
/// budget. `left` is the fraction left (0…1), nil for "no budget". Warm below
/// 20 %, red below 5 % — the same thresholds the toasts speak at.
struct BudgetRing: View {
    @Environment(\.mauriceTheme) private var theme
    let left: Double?
    let accent: Color
    var size: CGFloat = 22
    /// The percentage in the middle — for the large ring of the Budget pane.
    var showsPercent = false

    private var lineWidth: CGFloat { max(2.5, size * (showsPercent ? 0.08 : 0.14)) }

    private var tint: Color {
        guard let left else { return accent.legible(onDark: theme.isDark) }
        if left <= 0.05 { return .red }
        if left <= 0.20 { return .orange }
        return accent.legible(onDark: theme.isDark)
    }

    var body: some View {
        ZStack {
            Circle().stroke(theme.rule, lineWidth: lineWidth)
            Circle()
                .trim(from: 0, to: CGFloat(min(1, max(0, left ?? 1))))
                .stroke(tint, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.easeInOut(duration: 0.5), value: left)
            if left == nil {
                Image(systemName: "infinity")
                    .font(.system(size: size * (showsPercent ? 0.3 : 0.38), weight: .semibold))
                    .foregroundStyle(theme.inkSoft)
            } else if showsPercent, let left {
                Text("\(Int((left * 100).rounded())) %")
                    .font(.system(size: size * 0.2, weight: .medium, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(theme.ink)
            }
        }
        .padding(lineWidth / 2)
        .frame(width: size, height: size)
    }
}

/// The toast raised when the share falls to 20, 10 or 5 %. A tap opens
/// Settings → Budget; it goes away on its own.
struct BudgetToast: View {
    @Environment(SessionStore.self) private var session
    @Environment(BudgetStore.self) private var budget
    @Environment(\.mauriceTheme) private var theme
    let percent: Int

    var body: some View {
        Button { budget.openSettings() } label: {
            HStack(spacing: 10) {
                BudgetRing(left: Double(percent) / 100, accent: session.activeDeviceUser?.color ?? .blue, size: 20)
                Text(session.localized("budget.toast.title", percent))
                    .font(.system(size: 13, weight: .medium)).foregroundStyle(theme.ink)
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold)).foregroundStyle(theme.inkMute)
            }
            .padding(.leading, 12).padding(.trailing, 16).padding(.vertical, 9)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .glassControl(theme, in: Capsule())
        .shadow(color: .black.opacity(0.12), radius: 10, y: 3)
        // Up for a while, then gone: the ring still says it, in the sidebar.
        .task(id: percent) {
            try? await Task.sleep(for: .seconds(8))
            if budget.alert == percent { budget.alert = nil }
        }
    }
}
