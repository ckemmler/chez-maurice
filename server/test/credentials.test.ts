/**
 * What a PIN and the administrator password must not be (services/credentials.ts),
 * and the administrator changing their own password (POST /api/auth/password).
 */
import { beforeEach, expect, test } from "bun:test";

const { default: db } = await import("../src/db");
const { createSession, hashPassword, verifyPassword } = await import("../src/services/auth");
const { passwordProblem, pinProblem } = await import("../src/services/credentials");
const auth = (await import("../src/routes/auth")).default;

const ADMIN = "cred-admin";
const KID = "cred-kid";
db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, 'credadmin', 'Admin', 'admin')`, [ADMIN]);
db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, 'credkid', 'Kid', 'standard')`, [KID]);

const OLD = "un vieux mot de passe";
beforeEach(async () => {
  db.run(`UPDATE users SET password_hash = ? WHERE id = ?`, [await hashPassword(OLD), ADMIN]);
  db.run(`DELETE FROM sessions WHERE user_id IN (?, ?)`, [ADMIN, KID]);
});

function post(path: string, token: string, body: unknown, ip = "10.9.0.1") {
  return auth.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

test("the PINs everybody tries first are refused; others pass", () => {
  for (const weak of ["1111", "0000", "1234", "4321", "9876", "123456", "654321", "1212", "121212", "123123", "2580", "1004", "6969"]) {
    expect(pinProblem(weak)).toBe("weak");
  }
  for (const bad of ["", "12", "1234567", "12a4"]) expect(pinProblem(bad)).toBe("format");
  for (const ok of ["2739", "8051", "47120", "905314"]) expect(pinProblem(ok)).toBeNull();
});

test("a password: twelve characters, not the username, not a pattern", () => {
  expect(passwordProblem("court")).toBe("short");
  expect(passwordProblem("claire-claire-2026", "claire")).toBe("name");
  expect(passwordProblem("aaaaaaaaaaaaaaa")).toBe("weak");
  expect(passwordProblem("abababababab")).toBe("weak");
  expect(passwordProblem("Password1234")).toBe("weak");
  expect(passwordProblem("1234567890123")).toBe("weak");
  expect(passwordProblem("nhoTd51E8SU2P2lLuxw1")).toBeNull();          // what the tower makes
  expect(passwordProblem("la tasse bleue du matin")).toBeNull();
});

test("set-pin refuses a weak PIN and says why", async () => {
  const token = createSession(KID).token;
  const r = await post("/set-pin", token, { pin: "1111" });
  expect(r.status).toBe(400);
  expect((await r.json()).code).toBe("pin_weak");
  expect((await post("/set-pin", token, { pin: "2739" })).status).toBe(200);
});

test("the admin changes their password: the current one first, a strong new one, the other devices signed out", async () => {
  const here = createSession(ADMIN).token;
  const other = createSession(ADMIN).token;
  let r = await post("/password", here, { current_password: "faux", new_password: "la tasse bleue du matin" });
  expect(r.status).toBe(401);
  expect((await r.json()).code).toBe("password_wrong");
  r = await post("/password", here, { current_password: OLD, new_password: "trop court" });
  expect((await r.json()).code).toBe("password_short");
  r = await post("/password", here, { current_password: OLD, new_password: "credadmin et la mer" });
  expect((await r.json()).code).toBe("password_name");
  r = await post("/password", here, { current_password: OLD, new_password: "la tasse bleue du matin" });
  expect(r.status).toBe(200);
  const row = db.query(`SELECT password_hash FROM users WHERE id = ?`).get(ADMIN) as { password_hash: string };
  expect(await verifyPassword("la tasse bleue du matin", row.password_hash)).toBe(true);
  const sessions = (db.query(`SELECT id FROM sessions WHERE user_id = ?`).all(ADMIN) as { id: string }[]).map((s) => s.id);
  expect(sessions).toEqual([here]);
  expect(sessions).not.toContain(other);
});

test("a member has no password to change", async () => {
  const r = await post("/password", createSession(KID).token, { current_password: "x", new_password: "la tasse bleue du matin" });
  expect(r.status).toBe(403);
});

test("guessing the current password is braked like a login", async () => {
  const token = createSession(ADMIN).token;
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await post("/password", token, { current_password: `faux${i}`, new_password: "x" }, "10.9.9.9")).status;
  expect(last).toBe(429);
});
