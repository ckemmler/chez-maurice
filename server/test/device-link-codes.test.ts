/**
 * A member adding a device of their own (POST /api/me/device-code): a code
 * shown as a QR on a device they are signed in on, redeemed by the new one at
 * /api/auth/enroll. Single use, ten minutes, no admin involved; not for a
 * guest, nor for a connected tool's API token.
 */
import { beforeEach, expect, test } from "bun:test";
import { MEMBER } from "./_member";

const { default: db } = await import("../src/db");
const { createSession, createDeviceLinkCode, deviceLinkCodeState, freshInviteCode } = await import("../src/services/auth");
const { createApiToken } = await import("../src/middleware/auth");
const auth = (await import("../src/routes/auth")).default;
const me = (await import("../src/routes/me")).default;

const STANDARD = "devlink-standard";
const GUEST = "devlink-guest";
db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role, pin_hash) VALUES (?, 'devlinkstd', 'Std', 'standard', 'x')`, [STANDARD]);
db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, 'devlinkguest', 'Guest', 'guest')`, [GUEST]);

function enroll(code: string, ip = "10.1.0.1") {
  return auth.request("/enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ code }),
  });
}

function deviceCode(token: string) {
  return me.request("/device-code", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
}

beforeEach(() => {
  db.run(`DELETE FROM device_link_codes`);
  db.run(`DELETE FROM account_events WHERE user_id = ?`, [STANDARD]);
});

test("a member's own code signs their new device in once, with no PIN to set", async () => {
  const res = await deviceCode(createSession(STANDARD).token);
  expect(res.status).toBe(201);
  const { code, expires_at } = await res.json();
  const minutes = (new Date(expires_at).getTime() - Date.now()) / 60000;
  expect(minutes).toBeGreaterThan(9);
  expect(minutes).toBeLessThanOrEqual(10);

  const first = await enroll(code.toLowerCase());
  expect(first.status).toBe(200);
  const body = await first.json();
  expect(body.user_id).toBe(STANDARD);
  expect(body.needs_pin).toBe(false);
  expect(typeof body.token).toBe("string");
  // They made it themselves: nothing to tell them.
  expect(db.query(`SELECT 1 FROM account_events WHERE user_id = ?`).get(STANDARD)).toBeNull();

  expect((await enroll(code, "10.1.0.2")).status).toBe(401);
});

test("an expired code is refused, and a new one withdraws the old", async () => {
  const stale = createDeviceLinkCode(STANDARD, -1).code;
  expect((await enroll(stale, "10.1.0.3")).status).toBe(401);
  const older = createDeviceLinkCode(STANDARD).code;
  const newer = createDeviceLinkCode(STANDARD).code;
  expect((await enroll(older, "10.1.0.3")).status).toBe(401);
  expect((await enroll(newer, "10.1.0.3")).status).toBe(200);
});

test("not for a guest, nor with an API token", async () => {
  expect((await deviceCode(createSession(GUEST).token)).status).toBe(403);
  const { rawToken } = await createApiToken(MEMBER.id, "tool");
  expect((await deviceCode(rawToken)).status).toBe(403);
});

test("a fresh code is free in every invitation table", () => {
  const { code } = createDeviceLinkCode(STANDARD);
  expect(freshInviteCode()).not.toBe(code);
});

test("the sheet showing the code learns when it has been used", async () => {
  const token = createSession(STANDARD).token;
  const state = async (code: string) =>
    (await (await me.request(`/device-code/${code}`, { headers: { Authorization: `Bearer ${token}` } })).json()).state;
  const { code } = createDeviceLinkCode(STANDARD);
  expect(await state(code)).toBe("pending");
  expect((await enroll(code, "10.1.0.4")).status).toBe(200);
  expect(await state(code.toLowerCase())).toBe("used");
  expect(deviceLinkCodeState(STANDARD, createDeviceLinkCode(STANDARD, -1).code)).toBe("expired");
  expect(deviceLinkCodeState(GUEST, createDeviceLinkCode(STANDARD).code)).toBe("expired");
});
