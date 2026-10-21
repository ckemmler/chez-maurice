/**
 * Only Apple tokens go to APNs (21 October 2026). The server sent every row of
 * device_tokens there; an Android token came back BadDeviceToken and was
 * pruned. Tokens of other platforms are now skipped and kept for whatever
 * channel delivers them.
 */
import { beforeAll, expect, test } from "bun:test";

const db = (await import("../src/db")).default;
const { pushToUser, registerDeviceToken } = await import("../src/services/push");
const { isApplePlatform } = await import("../src/services/apns");

const MEMBER = "push-platforms-member";

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name) VALUES (?, 'pushplatforms', 'Push')`, [MEMBER]);
});

const tokens = () =>
  (db.query(`SELECT token FROM device_tokens WHERE user_id = ? ORDER BY token`).all(MEMBER) as { token: string }[]).map((r) => r.token);

test("Apple platforms are the iOS, macOS and Carnet apps, and rows without one", () => {
  for (const p of ["ios", "macos", "carnet-ios", null, undefined, ""]) expect(isApplePlatform(p)).toBe(true);
  for (const p of ["android", "carnet-android", "fcm", "web"]) expect(isApplePlatform(p)).toBe(false);
});

test("an Android token is neither sent to APNs nor pruned", async () => {
  registerDeviceToken(MEMBER, "tok-ios", "ios");
  registerDeviceToken(MEMBER, "tok-mac", "macos");
  registerDeviceToken(MEMBER, "tok-carnet", "carnet-ios");
  registerDeviceToken(MEMBER, "tok-android", "android");
  registerDeviceToken(MEMBER, "tok-carnet-android", "carnet-android");

  const sent: string[] = [];
  // APNs refuses every token it is given, as it would an Android one.
  await pushToUser(MEMBER, { title: "t", body: "b" }, async (token) => {
    sent.push(token);
    return { ok: false, status: 400, reason: "BadDeviceToken" };
  });

  expect(sent.sort()).toEqual(["tok-carnet", "tok-ios", "tok-mac"]);
  // The Apple tokens Apple refused are pruned; the others stay.
  expect(tokens()).toEqual(["tok-android", "tok-carnet-android"]);
});

test("an Android device with Web Push keys is reached through its endpoint, and pruned when gone", async () => {
  const live = "https://ntfy.sh/upLive?up=1";
  const gone = "https://ntfy.sh/upGone?up=1";
  registerDeviceToken(MEMBER, live, "android", "h1", { p256dh: "BCVx", auth: "BTBZ" });
  registerDeviceToken(MEMBER, gone, "android", "h1", { p256dh: "BCVx", auth: "BTBZ" });

  const web: { endpoint: string; payload: Record<string, unknown> }[] = [];
  await pushToUser(
    MEMBER,
    { title: "Candide", body: "On part à 8 h ?", conversationId: "c9" },
    async () => ({ ok: true, status: 200 }),
    async (endpoint, _p256dh, _auth, payload) => {
      web.push({ endpoint, payload });
      return { ok: endpoint === live, status: endpoint === live ? 201 : 410 };
    },
  );

  expect(web.map((w) => w.endpoint).sort()).toEqual([gone, live]);
  expect(web[0].payload).toMatchObject({ title: "Candide", body: "On part à 8 h ?", conversationId: "c9", householdTag: "h1" });
  expect(tokens()).toContain(live);
  expect(tokens()).not.toContain(gone);
});
