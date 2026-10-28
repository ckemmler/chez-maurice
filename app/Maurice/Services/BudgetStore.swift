import Foundation
import Observation

/// The household's budget, as GET /api/me/budget gives it: the same for every
/// member, a fraction left — never an amount, except to the admin, who pays
/// (`left_eur`). `limited == false` when nothing limits the household (the
/// ring is full, with ∞ in it).
struct HouseholdBudget: Decodable, Equatable {
    let limited: Bool
    /// "balance" (prepaid, a hosted household) or "monthly"; nil when unlimited.
    let kind: String?
    /// What is left, 0…1; nil when unlimited.
    let left: Double?
    /// When a monthly budget starts afresh (ISO 8601, UTC); nil otherwise.
    let resets_at: String?
    /// Changes when the ring is filled again — a new month, a top-up — so
    /// each alert threshold is told once per period. Nil from older servers.
    let period: String?
    /// What is left in euros: the admin's only; nil for a member.
    let left_eur: Double?

    var resetsAt: Date? {
        guard let resets_at else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: resets_at) ?? ISO8601DateFormatter().date(from: resets_at)
    }
}

/// The budget ring's state, and the alerts it raises: a toast once the
/// household's budget falls to 20 %, again at 10 % and at 5 % — each once per
/// member and period (a month, or until the next top-up), remembered on the
/// device. The ring and the toast both lead to Settings →
/// Budget, which ContentView presents when `showSettings` turns true.
@Observable @MainActor
final class BudgetStore {
    /// The fractions left at which the member is told, largest first.
    static let thresholds: [Double] = [0.20, 0.10, 0.05]

    private(set) var budget: HouseholdBudget?
    /// The threshold just crossed, in percent, while its toast is up.
    var alert: Int?
    /// Asks ContentView for Settings, opened on the Budget pane.
    var showSettings = false

    /// What the ring draws: the fraction left, or nil for "no budget" (full, ∞).
    var left: Double? { budget?.limited == true ? budget?.left : nil }

    func refresh(_ session: SessionStore) async {
        guard let server = session.serverURL, let token = session.tokenForActiveUser,
              let userId = session.activeUserId else {
            budget = nil
            return
        }
        // A server from before the budget has no route: stay as we were (∞).
        guard let b: HouseholdBudget = try? await APIClient(baseURL: server).get("/api/me/budget", token: token)
        else { return }
        budget = b
        raiseAlertIfDue(b, member: "\(server)|\(userId)")
    }

    func openSettings() {
        alert = nil
        showSettings = true
    }

    /// The deepest threshold the budget has fallen to, told once: a member who
    /// goes from 25 % to 8 % in one turn hears about 10 %, not 20 then 10.
    private func raiseAlertIfDue(_ b: HouseholdBudget, member: String) {
        guard b.limited, let left = b.left, let period = b.period ?? b.resets_at,
              let crossed = Self.thresholds.filter({ left <= $0 }).min() else { return }
        let key = "budget.alerted.\(member).\(period)"
        let told = UserDefaults.standard.object(forKey: key) as? Double ?? 1
        guard crossed < told else { return }
        UserDefaults.standard.set(crossed, forKey: key)
        alert = Int((crossed * 100).rounded())
    }
}
