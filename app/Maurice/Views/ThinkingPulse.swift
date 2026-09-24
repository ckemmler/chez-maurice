import SwiftUI

// MARK: - Thinking pulse

/// The one progress mark of a turn — the animation that used to be a wave of
/// three dots. Four candidates, picked in Settings so they can be tried in a
/// live conversation and the losers cut; the choice is a device preference.
struct ThinkingPulse: View {
    static let prefKey = "maurice.thinkingPulse"

    enum Style: String, CaseIterable, Identifiable {
        /// A dot breathing, with a ring that ripples out of it and fades.
        case halo
        /// Three dots circling, the tail ones fainter — a comet.
        case orbit
        /// A short stroke that draws itself and lifts, like a pen thinking.
        case stroke
        /// Maurice's hat, nodding.
        case hat

        static let defaultChoice: Style = .halo
        var id: String { rawValue }
        var label: String { L("settings.pulse.\(rawValue)") }
    }

    let style: Style
    var color: Color = .secondary
    var size: CGFloat = 16

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            ZStack {
                switch style {
                case .halo: halo(t)
                case .orbit: orbit(t)
                case .stroke: stroke(t)
                case .hat: hat(t)
                }
            }
            .frame(width: size * 1.5, height: size)
        }
    }

    private func halo(_ t: TimeInterval) -> some View {
        // A 1.6 s cycle: the ring leaves the dot at 0 and is gone by 1.
        let phase = (t / 1.6).truncatingRemainder(dividingBy: 1)
        let breath = 0.85 + 0.15 * sin(t * 2 * .pi / 1.6)
        return ZStack {
            Circle()
                .strokeBorder(color.opacity(0.7 * (1 - phase)), lineWidth: 1.2)
                .frame(width: size * (0.35 + 0.65 * phase), height: size * (0.35 + 0.65 * phase))
            Circle()
                .fill(color)
                .frame(width: size * 0.38 * breath, height: size * 0.38 * breath)
        }
    }

    private func orbit(_ t: TimeInterval) -> some View {
        let r = size * 0.36
        let angle = t * 2 * .pi / 1.4
        return ZStack {
            ForEach(0..<3, id: \.self) { i in
                let a = angle - Double(i) * 0.55
                let k = 1 - Double(i) * 0.3
                Circle()
                    .fill(color.opacity(k))
                    .frame(width: size * 0.22 * k + 1, height: size * 0.22 * k + 1)
                    .offset(x: cos(a) * r, y: sin(a) * r)
            }
        }
    }

    private func stroke(_ t: TimeInterval) -> some View {
        // Draws left to right over the first half of a 1.4 s cycle, then the
        // start catches up with the end over the second half.
        let phase = (t / 1.4).truncatingRemainder(dividingBy: 1)
        let head = min(1, phase * 2)
        let tail = max(0, phase * 2 - 1)
        return Capsule()
            .trim(from: tail, to: head)
            .stroke(color, style: StrokeStyle(lineWidth: size * 0.16, lineCap: .round))
            .frame(width: size * 1.4, height: size * 0.16)
    }

    private func hat(_ t: TimeInterval) -> some View {
        // A slow nod: a little tilt, a little bob, out of phase so it rolls.
        let w = t * 2 * .pi / 1.8
        return BoaterHat(size: size * 0.95, color: color)
            .rotationEffect(.degrees(sin(w) * 9), anchor: .bottom)
            .offset(y: sin(w + 1.2) * 1.2)
    }
}
