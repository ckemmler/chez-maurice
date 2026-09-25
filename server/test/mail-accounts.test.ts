// A member's mail accounts (25 September 2026). What is held down here: the
// password is encrypted at rest and never comes back out of a member-facing
// route; a member reaches their own accounts and nobody else's; a password that
// does not open the mailbox is not kept; and the route the `email` tool reads
// passwords from answers only on loopback, and only with the gateway's key.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";

const db = (await import("../src/db")).default;
const svc = await import("../src/services/mailAccounts");
const routes = (await import("../src/routes/mailAccounts")).default;
const local = (await import("../src/routes/mailAccountsLocal")).default;
const { createSession } = await import("../src/services/auth");

const ANNA = "ma-anna";
const BEN = "ma-ben";
let annaAuth = "";
let benAuth = "";

/** What the mailbox says to a login. Tests set it; nothing here opens IMAP. */
let mailboxAccepts = (password: string) => password === "good-app-password";
let lastPassword = "";

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  for (const [id, name] of [[ANNA, "Anna"], [BEN, "Ben"]] as const) {
    db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'standard')`, [id, id, name]);
  }
  annaAuth = `Bearer ${createSession(ANNA).token}`;
  benAuth = `Bearer ${createSession(BEN).token}`;
  process.env.MAURICE_MCP_TOKEN = "gateway-key";
  // The checker reads the password the tool would read, through the same
  // function the loopback route uses — so the round trip is the real one,
  // minus IMAP.
  svc.setChecker(async (memberId, address) => {
    const acc = svc.accountsForTool(memberId).find((a) => a.address === address);
    lastPassword = String(acc?.password ?? "");
    return mailboxAccepts(lastPassword)
      ? { state: "ok", error: null }
      : { state: "error", error: "LoginError: [AUTHENTICATIONFAILED] Authentication Failed" };
  });
});

afterAll(() => svc.setChecker(null));

beforeEach(() => {
  db.run(`DELETE FROM mail_accounts`);
  mailboxAccepts = (password) => password === "good-app-password";
});

function req(auth: string, path: string, init: RequestInit = {}) {
  return routes.request(path, { ...init, headers: { Authorization: auth, "Content-Type": "application/json", ...(init.headers ?? {}) } });
}

const add = (auth: string, body: unknown) => req(auth, "/", { method: "POST", body: JSON.stringify(body) });

test("the password is sealed at rest, with a key only the owner can read", () => {
  const sealed = svc.encryptSecret("abcd efgh ijkl mnop");
  expect(sealed.startsWith("v1:")).toBe(true);
  expect(sealed).not.toContain("abcd");
  expect(svc.decryptSecret(sealed)).toBe("abcd efgh ijkl mnop");
  // Two seals of one password differ (a fresh IV each time).
  expect(svc.encryptSecret("same")).not.toBe(svc.encryptSecret("same"));
  const keyFile = svc.secretKeyPath();
  expect(existsSync(keyFile)).toBe(true);
  expect(statSync(keyFile).mode & 0o777).toBe(0o600);
  expect(Buffer.from(readFileSync(keyFile, "utf8").trim(), "base64").length).toBe(32);
});

test("a sealed password opened with another key fails, it does not decrypt to garbage", () => {
  const sealed = svc.encryptSecret("secret");
  process.env.MAURICE_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
  svc.resetKeyCache();
  try {
    expect(() => svc.decryptSecret(sealed)).toThrow();
  } finally {
    delete process.env.MAURICE_SECRET_KEY;
    svc.resetKeyCache();
  }
});

test("adding a mailbox that accepts the login keeps it, and never returns the password", async () => {
  // Gmail shows its app passwords in groups of four; the spaces are cosmetic.
  mailboxAccepts = (p) => p === "abcdefghijklmnop";
  const res = await add(annaAuth, { address: " Anna@Gmail.com ", password: "abcd efgh ijkl mnop" });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.address).toBe("anna@gmail.com");
  expect(body.state).toBe("ok");
  expect(JSON.stringify(body)).not.toContain("abcd");
  expect(lastPassword).toBe("abcdefghijklmnop");
  const row = db.query(`SELECT secret FROM mail_accounts WHERE member_id = ?`).get(ANNA) as { secret: string };
  expect(row.secret).not.toContain("abcd");
  const list = await (await req(annaAuth, "/")).json();
  expect(list.accounts).toHaveLength(1);
  expect(JSON.stringify(list)).not.toContain("password");
});

test("a password the mailbox refuses is not kept, and the reason comes back", async () => {
  const res = await add(annaAuth, { address: "anna@icloud.com", password: "wrong" });
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.detail).toContain("Authentication Failed");
  expect(svc.listMailAccounts(ANNA)).toHaveLength(0);
});

test("the same address twice is refused; a malformed one never reaches the mailbox", async () => {
  expect((await add(annaAuth, { address: "anna@gmail.com", password: "good-app-password" })).status).toBe(201);
  expect((await add(annaAuth, { address: "anna@gmail.com", password: "good-app-password" })).status).toBe(409);
  expect((await add(annaAuth, { address: "not an address", password: "x" })).status).toBe(400);
  expect((await add(annaAuth, { address: "a@b.org", password: "   " })).status).toBe(400);
  expect((await add(annaAuth, { address: "a@b.org", password: "x", security: "ssl" })).status).toBe(400);
});

test("a member reaches their own accounts and nobody else's", async () => {
  const created = await (await add(annaAuth, { address: "anna@gmail.com", password: "good-app-password" })).json();
  expect((await (await req(benAuth, "/")).json()).accounts).toHaveLength(0);
  expect((await req(benAuth, `/${created.id}`, { method: "DELETE" })).status).toBe(404);
  expect((await req(benAuth, `/${created.id}/check`, { method: "POST" })).status).toBe(404);
  expect((await req(benAuth, `/${created.id}/password`, { method: "PUT", body: JSON.stringify({ password: "x" }) })).status).toBe(404);
  expect(svc.listMailAccounts(ANNA)).toHaveLength(1);
  expect((await req(annaAuth, `/${created.id}`, { method: "DELETE" })).status).toBe(200);
  expect(svc.listMailAccounts(ANNA)).toHaveLength(0);
});

test("a new password that does not work leaves the old one in place", async () => {
  const created = await (await add(annaAuth, { address: "anna@gmail.com", password: "good-app-password" })).json();
  const bad = await req(annaAuth, `/${created.id}/password`, { method: "PUT", body: JSON.stringify({ password: "typo" }) });
  expect(bad.status).toBe(422);
  expect(svc.accountsForTool(ANNA)[0].password).toBe("good-app-password");
  expect(svc.getMailAccount(ANNA, created.id)!.state).toBe("ok");

  mailboxAccepts = (p) => p === "new-app-password";
  const good = await req(annaAuth, `/${created.id}/password`, { method: "PUT", body: JSON.stringify({ password: "new-app-password" }) });
  expect(good.status).toBe(200);
  expect(svc.accountsForTool(ANNA)[0].password).toBe("new-app-password");
});

test("a check records what the mailbox says now", async () => {
  const created = await (await add(annaAuth, { address: "anna@gmail.com", password: "good-app-password" })).json();
  mailboxAccepts = () => false; // the app password was revoked at Google
  const res = await req(annaAuth, `/${created.id}/check`, { method: "POST" });
  const body = await res.json();
  expect(body.state).toBe("error");
  expect(body.last_error).toContain("Authentication Failed");
});

// ── the tool's route ────────────────────────────────────────────────────

const LOCAL = { Host: "localhost", "X-Maurice-Tool-Token": "gateway-key" };

test("the tool's route hands over the password, on loopback, with the gateway's key", async () => {
  await add(annaAuth, { address: "anna@gmail.com", password: "good-app-password", provider: "gmail" });
  const res = await local.request(`/${ANNA}`, { headers: LOCAL });
  expect(res.status).toBe(200);
  const [acc] = (await res.json()).accounts;
  expect(acc).toMatchObject({ address: "anna@gmail.com", provider: "gmail", password: "good-app-password" });
  expect(acc.host).toBeUndefined(); // unset fields are left for the tool to guess
});

test("the tool's route refuses without the key, with a wrong one, or from afar", async () => {
  await add(annaAuth, { address: "anna@gmail.com", password: "good-app-password" });
  expect((await local.request(`/${ANNA}`, { headers: { Host: "localhost" } })).status).toBe(403);
  expect((await local.request(`/${ANNA}`, { headers: { ...LOCAL, "X-Maurice-Tool-Token": "gateway-kez" } })).status).toBe(403);
  expect((await local.request(`/${ANNA}`, { headers: { ...LOCAL, Host: "aline.chezmaurice.eu" } })).status).toBe(403);
  expect((await local.request(`/${ANNA}`, { headers: { ...LOCAL, "cf-ray": "8a2f-CDG" } })).status).toBe(403);
  // A member's session is not the gateway's key.
  expect((await local.request(`/${ANNA}`, { headers: { Host: "localhost", Authorization: annaAuth } })).status).toBe(403);
});

test("with no gateway key configured, the route is closed rather than open", async () => {
  const saved = process.env.MAURICE_MCP_TOKEN;
  delete process.env.MAURICE_MCP_TOKEN;
  try {
    expect((await local.request(`/${ANNA}`, { headers: { Host: "localhost", "X-Maurice-Tool-Token": "" } })).status).toBe(403);
  } finally {
    process.env.MAURICE_MCP_TOKEN = saved;
  }
});

test("deleting a member takes their accounts with them", async () => {
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES ('ma-gone', 'ma-gone', 'Gone', 'standard')`);
  svc.createMailAccount("ma-gone", { address: "gone@gmail.com", password: "x" });
  db.run(`DELETE FROM users WHERE id = 'ma-gone'`);
  expect(svc.listMailAccounts("ma-gone")).toHaveLength(0);
});
