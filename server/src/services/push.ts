// Push fan-out to a user's devices. Token storage + sendApns, with pruning of
// tokens Apple reports as dead. Used as the offline complement to the live
// per-user socket: we only push when the user has no socket connected.

import db from "../db";
import { sendApns } from "./apns";

export function registerDeviceToken(userId: string, token: string, platform: string, householdTag?: string): void {
  db.run(
    `INSERT INTO device_tokens (token, user_id, platform, household_tag) VALUES (?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform,
       household_tag = excluded.household_tag, updated_at = datetime('now')`,
    [token, userId, platform, householdTag ?? null],
  );
}

export function removeDeviceToken(token: string): void {
  db.run(`DELETE FROM device_tokens WHERE token = ?`, [token]);
}

/** Send an alert push to every device registered to `userId`. Fire-and-forget
 *  from request handlers; prunes tokens Apple says are gone. */
export async function pushToUser(
  userId: string,
  payload: { title: string; body: string; conversationId?: string },
): Promise<void> {
  const rows = db.query(`SELECT token, household_tag FROM device_tokens WHERE user_id = ?`)
    .all(userId) as { token: string; household_tag: string | null }[];
  console.log(`[push] pushToUser ${userId}: ${rows.length} token(s)`);
  for (const { token, household_tag } of rows) {
    try {
      const r = await sendApns(token, { ...payload, householdTag: household_tag ?? undefined });
      console.log(`[push]   token=${token.slice(0, 10)}… tag=${household_tag} → status=${r.status} reason=${r.reason ?? "ok"}`);
      if (r.reason === "BadDeviceToken" || r.reason === "Unregistered" || r.status === 410) {
        db.run(`DELETE FROM device_tokens WHERE token = ?`, [token]);
      }
    } catch (e) {
      console.log(`[push]   token=${token.slice(0, 10)}… send threw: ${e}`);
      // transient APNs error — leave the token, try again next time
    }
  }
}
