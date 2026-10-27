/**
 * What the admin did that reached into a member's account — told to the member.
 *
 * The admin of a household keeps two powers over the others (27 October 2026,
 * the owner's rule: a Maurice belongs to whoever opens it, and that is said,
 * not hidden):
 *
 *  - `device_by_code`: a code the admin made for a member (POST
 *    /api/users/:id/invite, or the console) brought a new device into an
 *    account that was already in use. It may be the member's own new phone —
 *    the line then costs them nothing — or someone else in their account.
 *    The first device of a new member comes in the same way and is not told:
 *    there is nothing of theirs in the account yet.
 *  - `household_export`: the whole household — every member's notes and
 *    conversations — left as one archive (scripts/export-household.ts, the
 *    console's /admin/export).
 *
 * The row is written before the session is handed out or the archive made,
 * and the app shows it until the member dismisses it (GET /api/me/events).
 * The push sent afterwards is a courtesy: it may be lost, the row may not.
 *
 * Every function takes the database handle: the export script runs as a
 * second process and must not import src/db.ts (it would run the migrations
 * beside the live server; see services/archive.ts).
 */

import type { Database } from "bun:sqlite";

export type AccountEventKind = "device_by_code" | "household_export";

export type AccountEvent = { id: number; kind: AccountEventKind; created_at: string; seen_at: string | null };

export function recordAccountEvent(db: Database, userId: string, kind: AccountEventKind): void {
  db.run(`INSERT INTO account_events (user_id, kind) VALUES (?, ?)`, [userId, kind]);
}

/** One `household_export` line for every member, in one transaction. */
export function recordHouseholdExport(db: Database): number {
  const ids = (db.query(`SELECT id FROM users`).all() as { id: string }[]).map((r) => r.id);
  db.transaction(() => {
    for (const id of ids) recordAccountEvent(db, id, "household_export");
  })();
  return ids.length;
}

/** Whether an account is in use: a PIN set, or a session already open. A code
 *  redeemed on such an account is told to its member. */
export function accountInUse(db: Database, userId: string): boolean {
  const pin = db.query(`SELECT 1 FROM users WHERE id = ? AND pin_hash IS NOT NULL`).get(userId);
  if (pin) return true;
  return !!db.query(`SELECT 1 FROM sessions WHERE user_id = ? LIMIT 1`).get(userId);
}

/** The member's events, newest first: the last 90 days, and any older one not yet dismissed. */
export function listAccountEvents(db: Database, userId: string): AccountEvent[] {
  return db
    .query(
      `SELECT id, kind, created_at, seen_at FROM account_events
        WHERE user_id = ? AND (seen_at IS NULL OR created_at >= datetime('now', '-90 days'))
        ORDER BY created_at DESC, id DESC LIMIT 50`,
    )
    .all(userId) as AccountEvent[];
}

export function markAccountEventsSeen(db: Database, userId: string): void {
  db.run(`UPDATE account_events SET seen_at = datetime('now') WHERE user_id = ? AND seen_at IS NULL`, [userId]);
}
