/**
 * The Android app registers a Web Push subscription (UnifiedPush): the
 * endpoint URL as token, and the keys its payloads are encrypted to. An Apple
 * app's bare token goes on working as before.
 */
import { expect, test } from "bun:test";
import { MEMBER } from "./_member";

const { default: db } = await import("../src/db");
const { createSession } = await import("../src/services/auth");
const users = (await import("../src/routes/users")).default;

const token = createSession(MEMBER.id).token;

function register(body: Record<string, unknown>) {
  return users.request("/me/device-token", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const row = (t: string) => db.query(`SELECT platform, household_tag, p256dh, auth FROM device_tokens WHERE token = ?`).get(t) as
  { platform: string; household_tag: string; p256dh: string | null; auth: string | null } | null;

test("a subscription is stored with its keys", async () => {
  const endpoint = "https://ntfy.sh/upRegister?up=1";
  const res = await register({ token: endpoint, platform: "android", household_tag: "h7", keys: { p256dh: "BCVx", auth: "BTBZ" } });
  expect(res.status).toBe(200);
  expect(row(endpoint)).toEqual({ platform: "android", household_tag: "h7", p256dh: "BCVx", auth: "BTBZ" });
});

test("keys need an https endpoint, and both halves", async () => {
  expect((await register({ token: "not-a-url", platform: "android", keys: { p256dh: "a", auth: "b" } })).status).toBe(400);
  expect((await register({ token: "https://ntfy.sh/upX", platform: "android", keys: { p256dh: "a" } })).status).toBe(400);
});

test("an Apple token needs no keys", async () => {
  expect((await register({ token: "abcdef0123", platform: "ios", household_tag: "h7" })).status).toBe(200);
  expect(row("abcdef0123")).toEqual({ platform: "ios", household_tag: "h7", p256dh: null, auth: null });
});
