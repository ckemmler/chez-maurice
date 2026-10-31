/**
 * The admin's reach into a member's account, told to the member
 * (services/accountEvents.ts), and the whole-household archive behind a
 * single-use link (services/householdExportLinks.ts, scripts/export-household.ts).
 */
import { beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MEMBER } from "./_member";

const { default: db } = await import("../src/db");
const { createSession, createInviteCode } = await import("../src/services/auth");
const events = await import("../src/services/accountEvents");
const links = await import("../src/services/householdExportLinks");
const { pushPendingAccountEvents } = await import("../src/services/accountEventsPush");
const auth = (await import("../src/routes/auth")).default;
const me = (await import("../src/routes/me")).default;
const admin = (await import("../src/routes/admin")).default;

const KID = "events-kid";
db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, 'evkid', 'Kid', 'standard')`, [KID]);

function enroll(code: string, ip: string) {
  return auth.request("/enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ code }),
  });
}

beforeEach(() => {
  db.run(`DELETE FROM account_events`);
  db.run(`DELETE FROM sessions WHERE user_id = ?`, [KID]);
  db.run(`UPDATE users SET pin_hash = NULL WHERE id = ?`, [KID]);
  db.run(`DELETE FROM household_exports`);
});

test("a member's first device comes in untold; the next one is told", async () => {
  const { code } = createInviteCode(KID);
  expect((await enroll(code, "10.1.0.1")).status).toBe(200);
  expect(events.listAccountEvents(db, KID)).toEqual([]);

  // The account is in use now (a session); the same code again is told.
  expect((await enroll(code, "10.1.0.2")).status).toBe(200);
  const listed = events.listAccountEvents(db, KID);
  expect(listed.map((e) => e.kind)).toEqual(["device_by_code"]);
  expect(listed[0]!.seen_at).toBeNull();
});

test("a PIN alone makes the account in use", () => {
  expect(events.accountInUse(db, KID)).toBe(false);
  db.run(`UPDATE users SET pin_hash = 'x' WHERE id = ?`, [KID]);
  expect(events.accountInUse(db, KID)).toBe(true);
});

test("the member reads their events and dismisses them; nobody else's", async () => {
  events.recordAccountEvent(db, KID, "device_by_code");
  events.recordAccountEvent(db, MEMBER.id, "household_export");
  const token = createSession(KID).token;
  const h = { Authorization: `Bearer ${token}` };

  const res = await me.request("/events", { headers: h });
  const body = await res.json();
  expect(body.events.map((e: any) => e.kind)).toEqual(["device_by_code"]);

  expect((await me.request("/events/seen", { method: "POST", headers: h })).status).toBe(200);
  const after = await (await me.request("/events", { headers: h })).json();
  expect(after.events[0].seen_at).not.toBeNull();
  // The admin's own line is untouched.
  expect(events.listAccountEvents(db, MEMBER.id)[0]!.seen_at).toBeNull();
});

test("an export tells every member", () => {
  const n = events.recordHouseholdExport(db);
  const users = (db.query(`SELECT COUNT(*) n FROM users`).get() as any).n;
  expect(n).toBe(users);
  expect(events.listAccountEvents(db, KID).map((e) => e.kind)).toEqual(["household_export"]);
});

test("the push goes once, and not for stale news", async () => {
  // In the member's own language — set, so another suite's admin locale does not decide.
  db.run(`INSERT INTO user_preferences (user_id, locale) VALUES (?, 'en') ON CONFLICT(user_id) DO UPDATE SET locale = 'en'`, [KID]);
  events.recordAccountEvent(db, KID, "household_export");
  db.run(`INSERT INTO account_events (user_id, kind, created_at) VALUES (?, 'device_by_code', datetime('now', '-3 days'))`, [KID]);
  const sent: any[] = [];
  const send = async (id: string, p: any) => { sent.push([id, p.title]); };
  expect(await pushPendingAccountEvents(send as any)).toBe(1);
  expect(sent).toEqual([[KID, "The household was exported"]]);
  expect(await pushPendingAccountEvents(send as any)).toBe(0);
});

test("the app's admin session no longer carries the household away", async () => {
  const token = createSession(MEMBER.id).token;
  const res = await admin.request("/export", { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(404);
});

test("a link opens once, and not after its time", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hx-"));
  const file = path.join(dir, "a.maurice.tar.gz");
  fs.writeFileSync(file, "tar");
  const { token, expires_at } = links.createExportLink(db, { path: file, filename: "a.maurice.tar.gz", bytes: 3 }, 3600_000);
  expect(new Date(expires_at).getTime()).toBeGreaterThan(Date.now());
  expect((db.query(`SELECT token_hash FROM household_exports`).get() as any).token_hash).not.toBe(token);

  expect(links.takeExport(db, "wrong")).toBeNull();
  // Looking at it (a mail scanner's GET) does not use it up.
  expect(links.peekExport(db, token)?.path).toBe(file);
  expect(links.peekExport(db, token)?.path).toBe(file);
  expect(links.takeExport(db, token)?.path).toBe(file);
  expect(links.takeExport(db, token)).toBeNull();
  expect(links.peekExport(db, token)).toBeNull();

  const late = path.join(dir, "b.maurice.tar.gz");
  fs.writeFileSync(late, "tar");
  const { token: t2 } = links.createExportLink(db, { path: late, filename: "b", bytes: 3 }, 3600_000);
  db.run(`UPDATE household_exports SET expires_at = '2000-01-01T00:00:00.000Z'`);
  expect(links.takeExport(db, t2)).toBeNull();
  expect(fs.existsSync(late)).toBe(false);
});

test("a new export replaces the one waiting; the sweep spares an export in progress", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hx-"));
  const first = path.join(dir, "1.tar.gz");
  const second = path.join(dir, "2.tar.gz");
  fs.writeFileSync(first, "1");
  fs.writeFileSync(second, "2");
  links.createExportLink(db, { path: first, filename: "1", bytes: 1 }, 3600_000);
  links.createExportLink(db, { path: second, filename: "2", bytes: 1 }, 3600_000);
  expect(fs.existsSync(first)).toBe(false);
  expect((db.query(`SELECT COUNT(*) n FROM household_exports`).get() as any).n).toBe(1);

  const staging = path.join(dir, "maurice-archive-x");
  fs.mkdirSync(staging);
  const orphan = path.join(dir, "old.tar.gz");
  fs.writeFileSync(orphan, "o");
  const old = new Date(Date.now() - 4 * 3600_000);
  fs.utimesSync(orphan, old, old);

  links.sweepExports(db, dir);
  expect(fs.existsSync(second)).toBe(true);   // waiting, named by a row
  expect(fs.existsSync(staging)).toBe(true);  // fresh: an export being written
  expect(fs.existsSync(orphan)).toBe(false);  // nobody's, and old
});

test("the admin password is under the login brake", async () => {
  const login = () => auth.request("/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "10.9.9.9" },
    body: JSON.stringify({ username: MEMBER.username ?? "nobody", password: "wrong-password" }),
  });
  let last = 0;
  for (let i = 0; i < 11; i++) last = (await login()).status;
  expect(last).toBe(429);
});
