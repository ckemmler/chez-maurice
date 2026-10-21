// Push fan-out to a user's devices: APNs for the Apple apps, Web Push for the
// Android app (UnifiedPush endpoints, payloads encrypted to the device's keys),
// pruning what either side reports as gone. The offline complement to the live
// per-user socket: we only push when the user has no socket connected.

import db from "../db";
import { isApplePlatform, sendApns } from "./apns";
import { isPushEndpoint, sendWebPush } from "./webpush";

/** A Web Push subscription's keys, as the browser API and UnifiedPush give them (base64url). */
export interface PushKeys { p256dh: string; auth: string }

export function registerDeviceToken(userId: string, token: string, platform: string, householdTag?: string, keys?: PushKeys): void {
  db.run(
    `INSERT INTO device_tokens (token, user_id, platform, household_tag, p256dh, auth) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform,
       household_tag = excluded.household_tag, p256dh = excluded.p256dh, auth = excluded.auth, updated_at = datetime('now')`,
    [token, userId, platform, householdTag ?? null, keys?.p256dh ?? null, keys?.auth ?? null],
  );
}

export function removeDeviceToken(token: string): void {
  db.run(`DELETE FROM device_tokens WHERE token = ?`, [token]);
}

/** Send an alert push to every device registered to `userId`: Apple tokens to
 *  APNs, Web Push subscriptions to their endpoint. Fire-and-forget from request
 *  handlers; prunes what is reported gone. A non-Apple token without keys is
 *  skipped and kept: nothing delivers it. */
export async function pushToUser(
  userId: string,
  payload: { title: string; body: string; conversationId?: string },
  send: typeof sendApns = sendApns,
  sendWeb: typeof sendWebPush = sendWebPush,
): Promise<void> {
  const rows = db.query(`SELECT token, household_tag, platform, p256dh, auth FROM device_tokens WHERE user_id = ?`)
    .all(userId) as { token: string; household_tag: string | null; platform: string | null; p256dh: string | null; auth: string | null }[];
  console.log(`[push] pushToUser ${userId}: ${rows.length} token(s)`);
  for (const { token, household_tag, platform, p256dh, auth } of rows) {
    const short = token.startsWith("http") ? new URL(token).host : token.slice(0, 10) + "…";
    if (p256dh && auth && isPushEndpoint(token)) {
      try {
        const r = await sendWeb(token, p256dh, auth, { ...payload, householdTag: household_tag ?? undefined });
        console.log(`[push]   webpush=${short} tag=${household_tag} platform=${platform} → status=${r.status}`);
        if (r.status === 404 || r.status === 410) db.run(`DELETE FROM device_tokens WHERE token = ?`, [token]);
      } catch (e) {
        console.log(`[push]   webpush=${short} send threw: ${e}`);
      }
      continue;
    }
    if (!isApplePlatform(platform)) {
      console.log(`[push]   token=${short} platform=${platform} → skipped (no channel)`);
      continue;
    }
    try {
      const r = await send(token, { ...payload, householdTag: household_tag ?? undefined, platform: platform ?? undefined });
      console.log(`[push]   token=${short} tag=${household_tag} platform=${platform} → status=${r.status} reason=${r.reason ?? "ok"}`);
      if (r.reason === "BadDeviceToken" || r.reason === "Unregistered" || r.status === 410) {
        db.run(`DELETE FROM device_tokens WHERE token = ?`, [token]);
      }
    } catch (e) {
      console.log(`[push]   token=${short} send threw: ${e}`);
      // transient APNs error — leave the token, try again next time
    }
  }
}
