/**
 * Inviting *someone* (services/invites.ts): an admin makes an open invitation,
 * the newcomer redeems it with the name they chose and becomes a member. The
 * code is single use — the second phone to scan it is refused — and the first
 * call without a name only asks who is joining, leaving the code unused. The
 * member-bound device codes keep working beside them, and the admin routes the
 * app's Members screen uses are admin-only.
 */
import { beforeEach, expect, test } from "bun:test";
import { MEMBER } from "./_member";

const { default: db } = await import("../src/db");
const { createSession } = await import("../src/services/auth");
const invites = await import("../src/services/invites");
const auth = (await import("../src/routes/auth")).default;
const users = (await import("../src/routes/users")).default;

const STANDARD = "invites-standard";
db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, 'invstd', 'Std', 'standard')`, [STANDARD]);

const adminToken = createSession(MEMBER.id).token;
const standardToken = createSession(STANDARD).token;

function enroll(body: Record<string, unknown>, ip = "10.0.0.1") {
  return auth.request("/enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

function asAdmin(path: string, method = "GET", token = adminToken) {
  return users.request(path, { method, headers: { Authorization: `Bearer ${token}` } });
}

beforeEach(() => {
  db.run(`DELETE FROM household_invites`);
  db.run(`DELETE FROM users WHERE username LIKE 'aline%' OR username LIKE 'zoe%'`);
});

test("a newcomer names themselves and becomes a member", async () => {
  const { code } = invites.createOpenInvite(MEMBER.id);

  const ask = await enroll({ code });
  expect(ask.status).toBe(200);
  const asked = await ask.json();
  expect(asked.needs_profile).toBe(true);
  expect(asked.token).toBeUndefined();
  expect(invites.isOpenInvite(code)).toBe(true); // asking does not use the code

  const res = await enroll({ code: code.toLowerCase(), display_name: "Aline", avatar_color: "#aa3355" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.needs_pin).toBe(true);
  expect(body.role).toBe("standard");
  expect(typeof body.token).toBe("string");

  const user = db.query(`SELECT username, display_name, role, avatar_color FROM users WHERE id = ?`).get(body.user_id) as any;
  expect(user).toEqual({ username: "aline", display_name: "Aline", role: "standard", avatar_color: "#aa3355" });
  const row = db.query(`SELECT used_by FROM household_invites WHERE code = ?`).get(code) as any;
  expect(row.used_by).toBe(body.user_id);
});

test("an invitation lets one person in", async () => {
  const { code } = invites.createOpenInvite(MEMBER.id);
  expect((await enroll({ code, display_name: "Aline" }, "10.0.0.2")).status).toBe(200);
  const second = await enroll({ code, display_name: "Zoé" }, "10.0.0.2");
  expect(second.status).toBe(401);
  expect(db.query(`SELECT 1 FROM users WHERE username = 'zoe'`).get()).toBeNull();
});

test("an expired invitation is refused", async () => {
  const { code } = invites.createOpenInvite(MEMBER.id, -1);
  expect(invites.isOpenInvite(code)).toBe(false);
  expect((await enroll({ code, display_name: "Aline" }, "10.0.0.3")).status).toBe(401);
});

test("the handle folds accents and is numbered when taken", () => {
  db.run(`INSERT INTO users (id, username, display_name) VALUES ('inv-zoe', 'zoe', 'Zoé')`);
  expect(invites.usernameFor("Zoé")).toBe("zoe2");
  expect(invites.usernameFor("Aline Dupont")).toBe("alinedupont");
  expect(invites.usernameFor("!!!")).toBe("membre");
  db.run(`DELETE FROM users WHERE id = 'inv-zoe'`);
});

test("a member's device code still signs in that member", async () => {
  const created = await asAdmin(`/${STANDARD}/invite`, "POST");
  expect(created.status).toBe(201);
  const { code } = await created.json();
  const res = await enroll({ code }, "10.0.0.4");
  const body = await res.json();
  expect(body.user_id).toBe(STANDARD);
  expect(body.needs_profile).toBeUndefined();
});

test("the admin lists and withdraws open invitations", async () => {
  const made = await asAdmin("/invites", "POST");
  expect(made.status).toBe(201);
  const { code } = await made.json();
  const listed = await (await asAdmin("/invites")).json();
  expect(listed.invites.map((i: any) => i.code)).toContain(code);
  expect((await asAdmin(`/invites/${code}`, "DELETE")).status).toBe(200);
  expect(invites.isOpenInvite(code)).toBe(false);
  expect((await asAdmin(`/invites/${code}`, "DELETE")).status).toBe(404);
});

test("only an admin hands out invitations", async () => {
  expect((await asAdmin("/invites", "POST", standardToken)).status).toBe(403);
  expect((await asAdmin(`/${MEMBER.id}/invite`, "POST", standardToken)).status).toBe(403);
});
