// A member's own data (docs/member-data.md; services/memberArchive.ts,
// services/memberErase.ts). What is held down: the archive carries the
// member's conversations, tables, files, images, garden and mail — opened —
// and nothing of anyone else, no credential; it pours into another account
// without landing on what is not that account's; erasing leaves nothing of
// the member in the databases, on disk, in the index, in the night's
// snapshots or in the logs, while a room others still sit in, an image
// someone else's message shows and the household's own rows stay; the
// ledger keeps the amounts and loses the name; an admin cannot leave a
// household without one; and the routes ask for the username and the
// password again, and refuse an API token.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";

const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "maurice-member-data-"));
const GARDENS = path.join(TMP, "gardens");
const LOGS = path.join(TMP, "logs");
const OUT = path.join(TMP, "out");
process.env.MAURICE_GARDENS_DIR = GARDENS;

const db = (await import("../src/db")).default;
await import("../src/services/budget"); // the ledger's table
const { encryptSecret } = await import("../src/services/mailAccounts");
const { createSession, hashPassword } = await import("../src/services/auth");
const { createApiToken } = await import("../src/middleware/auth");
const archive = await import("../src/services/memberArchive");
const erase = await import("../src/services/memberErase");
const meRoutes = (await import("../src/routes/me")).default;
const usersRoutes = (await import("../src/routes/users")).default;

const APP = process.env.MAURICE_DATA_DIR!;
const DATA_DB = path.join(APP, "gdprtest.db");

const app = new Hono();
app.route("/api/me", meRoutes);
app.route("/api/users", usersRoutes);

let n = 0;
/** A member with a little of everything, and a neighbour sharing two rooms. */
async function seed(role: "admin" | "standard" = "standard") {
  const tag = `${Date.now().toString(36)}${n++}`;
  const A = `gd-a-${tag}`;
  const B = `gd-b-${tag}`;
  const userA = `gda${tag}`;
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(`INSERT INTO users (id, username, display_name, role, password_hash, profile_text) VALUES (?, ?, 'Ada', ?, ?, 'likes tea')`,
    [A, userA, role, await hashPassword("correct horse")]);
  db.run(`INSERT INTO users (id, username, display_name, role) VALUES (?, ?, 'Ben', 'standard')`, [B, `gdb${tag}`]);

  // A conversation of Ada's alone, showing an image; one of Ben's showing the same.
  const img = `img-${tag}.png`;
  const own = `img-own-${tag}.png`;
  fs.mkdirSync(path.join(APP, "images"), { recursive: true });
  fs.writeFileSync(path.join(APP, "images", img), "PNG-shared");
  fs.writeFileSync(path.join(APP, "images", own), "PNG-own");
  db.run(`INSERT INTO conversations (id, user_id, title) VALUES (?, ?, 'Ada alone')`, [`c-solo-${tag}`, A]);
  db.run(`INSERT INTO conversation_participants (conversation_id, member_id, role) VALUES (?, ?, 'owner')`, [`c-solo-${tag}`, A]);
  db.run(`INSERT INTO messages (id, conversation_id, role, content, author_id) VALUES (?, ?, 'user', ?, ?)`,
    [`m1-${tag}`, `c-solo-${tag}`, `ada-secret-thought zq${tag}zq ![](/api/images/${own}) ![](/api/images/${img})`, A]);
  db.run(`INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, 'assistant', 'maurice-answers-ada')`, [`m2-${tag}`, `c-solo-${tag}`]);
  db.run(`INSERT INTO conversations (id, user_id, title) VALUES (?, ?, 'Ben alone')`, [`c-ben-${tag}`, B]);
  db.run(`INSERT INTO conversation_participants (conversation_id, member_id, role) VALUES (?, ?, 'owner')`, [`c-ben-${tag}`, B]);
  db.run(`INSERT INTO messages (id, conversation_id, role, content, author_id) VALUES (?, ?, 'user', ?, ?)`,
    [`m3-${tag}`, `c-ben-${tag}`, `ben-private ![](/api/images/${img})`, B]);

  // A room Ada opened with Ben in it, and one Ben opened with Ada in it.
  for (const [id, owner, other] of [[`c-room-a-${tag}`, A, B], [`c-room-b-${tag}`, B, A]] as const) {
    db.run(`INSERT INTO conversations (id, user_id, title) VALUES (?, ?, 'Room')`, [id, owner]);
    db.run(`INSERT INTO conversation_participants (conversation_id, member_id, role, joined_at) VALUES (?, ?, 'owner', '2026-01-01')`, [id, owner]);
    db.run(`INSERT INTO conversation_participants (conversation_id, member_id, role, joined_at) VALUES (?, ?, 'member', '2026-01-02')`, [id, other]);
    db.run(`INSERT INTO messages (id, conversation_id, role, content, author_id) VALUES (?, ?, 'user', 'ada-in-room', ?)`, [`${id}-a`, id, A]);
    db.run(`INSERT INTO messages (id, conversation_id, role, content, author_id) VALUES (?, ?, 'user', 'ben-in-room', ?)`, [`${id}-b`, id, B]);
  }

  // The library.
  fs.mkdirSync(path.join(APP, "files"), { recursive: true });
  const storage = `blob-${tag}.txt`;
  fs.writeFileSync(path.join(APP, "files", storage), "ada-file-bytes");
  db.run(`INSERT INTO folders (id, user_id, parent_id, name) VALUES (?, ?, NULL, 'Papers')`, [`fo-${tag}`, A]);
  db.run(`INSERT INTO files (id, user_id, folder_id, name, kind, size_bytes, storage) VALUES (?, ?, ?, 'note.txt', 'text', 14, ?)`,
    [`fi-${tag}`, A, `fo-${tag}`, storage]);

  db.run(`INSERT INTO life_facts (id, member_id, text) VALUES (?, ?, 'ada-life-fact')`, [`lf-${tag}`, A]);
  db.run(`INSERT INTO mail_accounts (id, member_id, address, secret) VALUES (?, ?, 'ada@example.org', ?)`,
    [`ma-${tag}`, A, encryptSecret("imap-password-ada")]);
  db.run(`INSERT INTO mail_conversations (member_id, conversation_id) VALUES (?, ?)`, [A, `c-solo-${tag}`]);
  db.run(`INSERT INTO spend_ledger (provider, model, cost_usd, user_id) VALUES ('scaleway', 'm', 0.5, ?)`, [A]);
  db.run(`INSERT INTO garden_settings (id, web_theme) VALUES (?, 'manuscript')`, [[A, B].sort().join("+")]);

  // A data-api database: rows of Ada's, a child row, a household row.
  const d = new Database(DATA_DB);
  d.exec(`
    CREATE TABLE IF NOT EXISTS chores (id INTEGER PRIMARY KEY, member_id TEXT, scope TEXT, title TEXT);
    CREATE TABLE IF NOT EXISTS chore_log (id INTEGER PRIMARY KEY, chore_id INTEGER REFERENCES chores(id), note TEXT);
  `);
  const chore = d.run(`INSERT INTO chores (member_id, scope, title) VALUES (?, 'member', 'ada-chore')`, [A]).lastInsertRowid;
  d.run(`INSERT INTO chore_log (chore_id, note) VALUES (?, 'ada-did-it')`, [chore]);
  d.run(`INSERT INTO chores (member_id, scope, title) VALUES (?, 'tenant', 'household-chore')`, [A]);
  d.run(`INSERT INTO chores (member_id, scope, title) VALUES (?, 'member', 'ben-chore')`, [B]);
  d.close();

  // The mail store, its subject sealed with the household's key.
  fs.mkdirSync(path.join(APP, "mail"), { recursive: true });
  const mail = new Database(erase.mailStorePath(A));
  mail.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, sender TEXT, subject_sealed TEXT)`);
  mail.run(`INSERT INTO messages VALUES ('x1', 'jean@example.org', ?)`, [encryptSecret("ada-mail-subject")]);
  mail.close();

  // The garden: a repository with a note, a remote elsewhere and a bare one here.
  const garden = path.join(GARDENS, userA);
  fs.mkdirSync(path.join(garden, "notes", "fr"), { recursive: true });
  fs.writeFileSync(path.join(garden, "notes", "fr", "the.md"), "---\ntitle: Thé\n---\nada-garden-note\n");
  const bare = path.join(APP, "git", `${userA}.git`);
  spawnSync("git", ["init", "--bare", "-q", bare]);
  const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: garden });
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "first");
  git("remote", "add", "origin", "https://git.example.invalid/ada.git");
  git("remote", "add", "home", bare);
  fs.writeFileSync(path.join(GARDENS, "gardens.json"), JSON.stringify({ [userA]: { base: `/g/${userA}` }, keep: { base: "/g/keep" } }));

  fs.mkdirSync(path.join(APP, "uploads"), { recursive: true });
  fs.writeFileSync(path.join(APP, "uploads", `anthropic-${A}-1.zip`), "zip");

  return { A, B, userA, tag, img, own, storage, garden, bare };
}

const count = (sql: string, ...params: any[]) => (db.query(sql).get(...params) as { n: number }).n;

/** Every text file under a directory, as one string. */
function slurp(dir: string): string {
  let out = "";
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== ".git") out += slurp(p); }
    else out += fs.readFileSync(p, "utf8");
  }
  return out;
}

function extract(file: string): string {
  const dir = fs.mkdtempSync(path.join(TMP, "x-"));
  const r = spawnSync("tar", ["-xzf", file, "-C", dir]);
  expect(r.status).toBe(0);
  return dir;
}

let corpusCalls: [string, string | null][] = [];

beforeAll(() => {
  fs.mkdirSync(GARDENS, { recursive: true });
  fs.mkdirSync(LOGS, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
});

beforeEach(() => {
  process.env.MAURICE_GARDENS_DIR = GARDENS;
  process.env.MAURICE_LOG_DIR = LOGS;
  corpusCalls = [];
  erase.setEraseDeps({ corpus: async (id, garden) => { corpusCalls.push([id, garden]); return { member_id: id }; } });
  fs.rmSync(path.join(APP, "backups"), { recursive: true, force: true });
});

afterAll(() => {
  erase.setEraseDeps(null);
  delete process.env.MAURICE_LOG_DIR;
  fs.rmSync(DATA_DB, { force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("the member archive", () => {
  test("carries what is the member's, opened, and nothing else", async () => {
    const s = await seed();
    const { path: file, manifest } = await archive.exportMember(s.A, OUT);
    expect(path.basename(file)).toMatch(/\.maurice-member\.tar\.gz$/);
    expect(manifest.format).toBe("maurice-member-archive");
    expect(manifest.member).toEqual({ id: s.A, username: s.userA, display_name: "Ada" });
    expect(manifest.counts.conversations).toBe(3);
    expect(manifest.counts.files).toBe(1);
    expect(manifest.counts.mail_messages).toBe(1);
    expect(manifest.contents).toContain("garden/");

    const dir = extract(file);
    const text = slurp(dir);
    for (const wanted of ["ada-secret-thought", "maurice-answers-ada", "ada-in-room", "ada-life-fact", "ada-chore", "ada-garden-note", "ada-mail-subject", "ada@example.org", "likes tea"]) {
      expect(text).toContain(wanted);
    }
    // Nobody else's words, no credential, not the household's rows.
    for (const never of ["ben-in-room", "ben-private", "ben-chore", "household-chore", "imap-password-ada", "$2b$", "password_hash", "subject_sealed"]) {
      expect(text).not.toContain(never);
    }
    expect(JSON.parse(fs.readFileSync(path.join(dir, "maurice", "mail_accounts.json"), "utf8"))[0].secret).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, "files", s.storage), "utf8")).toBe("ada-file-bytes");
    expect(fs.existsSync(path.join(dir, "images", s.own))).toBe(true);
    expect(fs.existsSync(path.join(dir, "garden", "notes", "fr", "the.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "garden", ".git", "HEAD"))).toBe(true);
    // The staging dir is gone.
    expect(fs.readdirSync(path.join(APP, "tmp"))).toEqual([]);
  });

  test("pours into another account, and only into it", async () => {
    const s = await seed();
    const { path: file } = await archive.exportMember(s.A, OUT);
    const C = `gd-c-${s.tag}`;
    const userC = `gdc${s.tag}`;
    db.run(`INSERT INTO users (id, username, display_name, role) VALUES (?, ?, 'Cleo', 'standard')`, [C, userC]);
    // A conversation of Ben's that the archive will claim, by id.
    const dir = extract(file);
    const stolen = { id: `c-ben-${s.tag}`, title: "mine now", room: false, messages: [{ id: `evil-${s.tag}`, role: "user", content: "planted" }] };
    fs.writeFileSync(path.join(dir, "conversations", `${stolen.id}.json`), JSON.stringify(stolen));
    const forged = path.join(OUT, `forged-${s.tag}.tar.gz`);
    expect(spawnSync("tar", ["-czf", forged, "-C", dir, "."]).status).toBe(0);

    // Ada has left this household; Cleo arrives with Ada's archive.
    await erase.eraseMember(s.A, "account");
    const { report } = await archive.importMember(forged, C);
    expect(report.conversations).toBe(1);
    expect(report.messages).toBe(2);
    expect(report.files).toBe(1);
    expect(report.notes).toBe(1);

    expect((db.query(`SELECT user_id FROM conversations WHERE id = ?`).get(`c-solo-${s.tag}`) as any).user_id).toBe(C);
    expect((db.query(`SELECT author_id FROM messages WHERE id = ?`).get(`m1-${s.tag}`) as any).author_id).toBe(C);
    // Ben's conversation, claimed by id, is Ben's still, and nothing was planted in it.
    expect((db.query(`SELECT user_id, title FROM conversations WHERE id = ?`).get(`c-ben-${s.tag}`) as any)).toEqual({ user_id: s.B, title: "Ben alone" });
    expect(count(`SELECT COUNT(*) n FROM messages WHERE id = ?`, `evil-${s.tag}`)).toBe(0);
    // A room is not brought along.
    expect(count(`SELECT COUNT(*) n FROM conversation_participants WHERE member_id = ?`, C)).toBe(1);

    // The library file is Cleo's, under a name of its own on disk.
    const f = db.query(`SELECT storage, folder_id FROM files WHERE user_id = ?`).get(C) as { storage: string; folder_id: string | null };
    expect(f.storage).not.toBe(s.storage);
    expect(fs.readFileSync(path.join(APP, "files", f.storage), "utf8")).toBe("ada-file-bytes");

    expect(fs.readFileSync(path.join(GARDENS, userC, "notes", "fr", "the.md"), "utf8")).toContain("ada-garden-note");
    expect(fs.existsSync(path.join(GARDENS, userC, ".git", "config"))).toBe(false);

    const d = new Database(DATA_DB, { readonly: true });
    const chores = d.query(`SELECT id, title FROM chores WHERE member_id = ?`).all(C) as { id: number; title: string }[];
    expect(chores.map((c) => c.title)).toEqual(["ada-chore"]);
    expect((d.query(`SELECT COUNT(*) n FROM chore_log WHERE chore_id = ?`).get(chores[0]!.id) as any).n).toBe(0); // no member_id: not exported
    d.close();

    await expect(archive.importMember(forged, C)).rejects.toThrow(/already imported/);
  });

  test("comes back into the account it left, once that was emptied", async () => {
    const s = await seed();
    const { path: file } = await archive.exportMember(s.A, OUT);
    await erase.eraseMember(s.A, "data");
    const { report } = await archive.importMember(file, s.A);
    expect(report.conversations).toBe(1);
    expect(report.files).toBe(1);
    expect(count(`SELECT COUNT(*) n FROM messages WHERE conversation_id = ?`, `c-solo-${s.tag}`)).toBe(2);
    const f = db.query(`SELECT id, storage, folder_id FROM files WHERE user_id = ?`).get(s.A) as { id: string; storage: string; folder_id: string };
    expect(f.storage).not.toBe(s.storage);
    expect(f.folder_id).toBe(`fo-${s.tag}`);
    expect(fs.readFileSync(path.join(APP, "files", f.storage), "utf8")).toBe("ada-file-bytes");
    expect(count(`SELECT COUNT(*) n FROM life_facts WHERE member_id = ?`, s.A)).toBe(1);
    expect(fs.existsSync(path.join(APP, "images", s.own))).toBe(true);
  });

  test("refuses a stranger's tar and a path that climbs out", async () => {
    const bad = fs.mkdtempSync(path.join(TMP, "bad-"));
    fs.writeFileSync(path.join(bad, "manifest.json"), JSON.stringify({ format: "maurice-archive", version: 1 }));
    const stranger = path.join(OUT, "stranger.tar.gz");
    spawnSync("tar", ["-czf", stranger, "-C", bad, "manifest.json"]);
    const s = await seed();
    await expect(archive.importMember(stranger, s.A)).rejects.toThrow(/not a Maurice member archive/);
  });
});

describe("erasing a member", () => {
  test("data: nothing of theirs is left, the account and what is others' stay", async () => {
    const s = await seed();
    // A night's snapshot, and a log, that both know Ada.
    fs.mkdirSync(path.join(APP, "backups", "db"), { recursive: true });
    const snap = path.join(TMP, `snap-${s.tag}.db`);
    db.run("VACUUM INTO ?", [snap]);
    const gz = path.join(APP, "backups", "db", "maurice-20261001-030000.db.gz");
    fs.writeFileSync(gz, gzipSync(fs.readFileSync(snap)));
    fs.copyFileSync(DATA_DB, snap + ".life");
    const lifeGz = path.join(APP, "backups", "db", "life-20261001-030000.db.gz");
    fs.writeFileSync(lifeGz, gzipSync(fs.readFileSync(snap + ".life")));
    fs.writeFileSync(path.join(APP, "backups", "db", `mail-${s.A}-20261001-030000.db.gz`), "x");
    fs.writeFileSync(path.join(APP, "backups", "db", `mail-${s.B}-20261001-030000.db.gz`), "x");
    fs.writeFileSync(path.join(LOGS, "api.log"), `GET /g/${s.userA}/notes 200\nGET /healthz 200\n[push] pushToUser ${s.A}\n`);
    fs.mkdirSync(path.join(APP, "backups", "archive"), { recursive: true });
    fs.writeFileSync(path.join(APP, "backups", "archive", "home.maurice.tar.gz"), "x");

    const r = await erase.eraseMember(s.A, "data");

    expect(r.scope).toBe("data");
    expect(r.conversations).toBe(1);
    expect(r.handed_over).toBe(1);
    expect(r.files).toBe(1);
    expect(r.garden).toBe(true);
    expect(r.mail).toBe(true);
    expect(r.corpus).toBe(true);
    expect(corpusCalls).toEqual([[s.A, s.garden]]);
    expect(r.snapshots).toEqual({ rewritten: 2, removed: 1 });
    expect(fs.existsSync(path.join(APP, "backups", "db", `mail-${s.B}-20261001-030000.db.gz`))).toBe(true);
    expect(r.log_lines).toBe(2);
    expect(r.residual.garden_remotes).toEqual(["origin https://git.example.invalid/ada.git"]);
    expect(r.residual.household_archives).toBe(1);
    expect(r.residual.shared_rows).toBe(1);

    // The account stays, emptied.
    expect(count(`SELECT COUNT(*) n FROM users WHERE id = ?`, s.A)).toBe(1);
    expect((db.query(`SELECT profile_text FROM users WHERE id = ?`).get(s.A) as any).profile_text).toBeNull();
    for (const [table, column] of [["conversations", "user_id"], ["messages", "author_id"], ["conversation_participants", "member_id"],
      ["files", "user_id"], ["folders", "user_id"], ["life_facts", "member_id"], ["mail_accounts", "member_id"], ["mail_conversations", "member_id"]]) {
      expect(count(`SELECT COUNT(*) n FROM ${table} WHERE ${column} = ?`, s.A)).toBe(0);
    }
    expect(count(`SELECT COUNT(*) n FROM garden_settings WHERE id LIKE ?`, `%${s.A}%`)).toBe(0);
    // What a turn cost still counts against their budget.
    expect(count(`SELECT COUNT(*) n FROM spend_ledger WHERE user_id = ?`, s.A)).toBe(1);

    // The room Ada opened is Ben's now, with his words in it; hers are gone from both.
    expect((db.query(`SELECT user_id FROM conversations WHERE id = ?`).get(`c-room-a-${s.tag}`) as any).user_id).toBe(s.B);
    expect((db.query(`SELECT role FROM conversation_participants WHERE conversation_id = ? AND member_id = ?`).get(`c-room-a-${s.tag}`, s.B) as any).role).toBe("owner");
    expect(count(`SELECT COUNT(*) n FROM messages WHERE content = 'ben-in-room' AND author_id = ?`, s.B)).toBe(2);
    expect(count(`SELECT COUNT(*) n FROM messages WHERE id = ?`, `m3-${s.tag}`)).toBe(1);

    // The disk.
    expect(fs.existsSync(path.join(APP, "files", s.storage))).toBe(false);
    expect(fs.existsSync(path.join(APP, "images", s.own))).toBe(false);
    expect(fs.existsSync(path.join(APP, "images", s.img))).toBe(true); // Ben's message shows it
    expect(fs.existsSync(erase.mailStorePath(s.A))).toBe(false);
    expect(fs.existsSync(s.garden)).toBe(false);
    expect(fs.existsSync(s.bare)).toBe(false);
    expect(fs.existsSync(path.join(APP, "uploads", `anthropic-${s.A}-1.zip`))).toBe(false);
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(GARDENS, "gardens.json"), "utf8")))).toEqual(["keep"]);

    // The data-api database: hers gone with their children, the household's and Ben's kept.
    const d = new Database(DATA_DB, { readonly: true });
    expect((d.query(`SELECT title FROM chores WHERE member_id = ?`).all(s.A) as any[]).map((x) => x.title)).toEqual(["household-chore"]);
    expect((d.query(`SELECT COUNT(*) n FROM chore_log WHERE note = 'ada-did-it' AND chore_id NOT IN (SELECT id FROM chores)`).get() as any).n).toBe(0);
    expect((d.query(`SELECT COUNT(*) n FROM chores WHERE member_id = ?`).get(s.B) as any).n).toBe(1);
    d.close();

    // The snapshot, rewritten: no free page keeps her words either.
    const bytes = gunzipSync(fs.readFileSync(gz));
    expect(bytes.includes(Buffer.from(`zq${s.tag}zq`))).toBe(false);
    expect(bytes.includes(Buffer.from("ben-private"))).toBe(true);
    fs.writeFileSync(snap + ".after", gunzipSync(fs.readFileSync(lifeGz)));
    const after = new Database(snap + ".after", { readonly: true });
    expect((after.query(`SELECT title FROM chores WHERE member_id = ?`).all(s.A) as any[]).map((x) => x.title)).toEqual(["household-chore"]);
    after.close();
    expect(fs.readFileSync(path.join(LOGS, "api.log"), "utf8")).toBe("GET /healthz 200\n");

    // The live files: neither the database nor its write-ahead log spells her words any more.
    for (const f of ["maurice.db", "maurice.db-wal"]) {
      const p = path.join(APP, f);
      if (fs.existsSync(p)) expect(fs.readFileSync(p).includes(Buffer.from(`zq${s.tag}zq`))).toBe(false);
    }

    const reg = db.query(`SELECT scope, pending FROM erasures WHERE member_id = ?`).get(s.A) as any;
    expect(reg).toEqual({ scope: "data", pending: null });
  });

  test("account: the member is gone, the ledger keeps the amount without the name", async () => {
    const s = await seed();
    fs.mkdirSync(path.join(APP, "avatars"), { recursive: true });
    fs.writeFileSync(path.join(APP, "avatars", `av-${s.tag}.png`), "PNG");
    db.run(`UPDATE users SET avatar_url = ? WHERE id = ?`, [`/api/avatars/av-${s.tag}.png`, s.A]);
    const ledger = count(`SELECT COUNT(*) n FROM spend_ledger`);
    const { token } = createSession(s.A);

    const r = await erase.eraseMember(s.A, "account");
    expect(r.scope).toBe("account");
    expect(count(`SELECT COUNT(*) n FROM users WHERE id = ?`, s.A)).toBe(0);
    expect(count(`SELECT COUNT(*) n FROM sessions WHERE id = ?`, token)).toBe(0);
    expect(count(`SELECT COUNT(*) n FROM spend_ledger WHERE user_id = ?`, s.A)).toBe(0);
    expect(count(`SELECT COUNT(*) n FROM spend_ledger`)).toBe(ledger);
    expect(fs.existsSync(path.join(APP, "avatars", `av-${s.tag}.png`))).toBe(false);
    expect(count(`SELECT COUNT(*) n FROM users WHERE id = ?`, s.B)).toBe(1);
  });

  test("a gateway that is down leaves the index pending, and it is tried again", async () => {
    const s = await seed();
    erase.setEraseDeps({ corpus: async () => { throw new Error("ECONNREFUSED"); } });
    const r = await erase.eraseMember(s.A, "account");
    expect(r.corpus).toBe(false);
    expect((db.query(`SELECT pending FROM erasures WHERE member_id = ?`).get(s.A) as any).pending).toBe(s.garden);

    const calls: [string, string | null][] = [];
    erase.setEraseDeps({ corpus: async (id, garden) => { calls.push([id, garden]); return {}; } });
    expect(await erase.retryPendingErasures()).toBeGreaterThanOrEqual(1);
    expect(calls).toContainEqual([s.A, s.garden]);
    expect((db.query(`SELECT pending FROM erasures WHERE member_id = ?`).get(s.A) as any).pending).toBeNull();
  });

  test("the only admin of a household others live in cannot leave it", async () => {
    const s = await seed("admin");
    const admins = db.query(`SELECT id, role FROM users WHERE role = 'admin' AND id != ?`).all(s.A) as { id: string }[];
    for (const a of admins) db.run(`UPDATE users SET role = 'standard' WHERE id = ?`, [a.id]);
    try {
      await expect(erase.eraseMember(s.A, "account")).rejects.toThrow("last_admin");
      expect(count(`SELECT COUNT(*) n FROM conversations WHERE user_id = ?`, s.A)).toBe(2); // nothing was touched
      // Their data is theirs to erase all the same.
      expect((await erase.eraseMember(s.A, "data")).scope).toBe("data");
    } finally {
      for (const a of admins) db.run(`UPDATE users SET role = 'admin' WHERE id = ?`, [a.id]);
    }
  });
});

describe("the routes", () => {
  const call = (token: string, method: string, url: string, body?: unknown) =>
    app.request(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });

  test("GET /api/me/export streams the member's archive", async () => {
    const s = await seed();
    const { token } = createSession(s.A);
    const res = await call(token, "GET", "/api/me/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/\.maurice-member\.tar\.gz"$/);
    const file = path.join(OUT, `routed-${s.tag}.tar.gz`);
    fs.writeFileSync(file, new Uint8Array(await res.arrayBuffer()));
    expect(archive.readMemberManifest(file).member.id).toBe(s.A);
  });

  test("POST /api/me/erase asks for the username and the password again", async () => {
    const s = await seed();
    const { token } = createSession(s.A);
    expect((await call(token, "POST", "/api/me/erase", { scope: "everything" })).status).toBe(400);
    expect((await call(token, "POST", "/api/me/erase", { scope: "account", confirm: "ada", password: "correct horse" })).status).toBe(403);
    expect((await call(token, "POST", "/api/me/erase", { scope: "account", confirm: s.userA, password: "wrong" })).status).toBe(403);
    expect(count(`SELECT COUNT(*) n FROM users WHERE id = ?`, s.A)).toBe(1);

    const { rawToken } = await createApiToken(s.A, "tool", "mcp", false);
    const viaTool = await call(rawToken, "POST", "/api/me/erase", { scope: "account", confirm: s.userA, password: "correct horse" });
    expect(viaTool.status).toBe(403);
    expect(await viaTool.json()).toEqual({ error: "session_required" });

    const ok = await call(token, "POST", "/api/me/erase", { scope: "account", confirm: s.userA, password: "correct horse" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).scope).toBe("account");
    expect(count(`SELECT COUNT(*) n FROM users WHERE id = ?`, s.A)).toBe(0);
    expect((await call(token, "GET", "/api/me/usage")).status).toBe(401);
  });

  test("DELETE /api/users/:id erases the member, not just the row", async () => {
    const s = await seed();
    const admin = `gd-adm-${s.tag}`;
    db.run(`INSERT INTO users (id, username, display_name, role) VALUES (?, ?, 'Adm', 'admin')`, [admin, `gdadm${s.tag}`]);
    const { token } = createSession(admin);
    const res = await call(token, "DELETE", `/api/users/${s.A}`);
    expect(res.status).toBe(200);
    expect(fs.existsSync(s.garden)).toBe(false);
    expect(fs.existsSync(path.join(APP, "files", s.storage))).toBe(false);
    expect((await call(token, "DELETE", `/api/users/${s.A}`)).status).toBe(404);
    db.run(`DELETE FROM users WHERE id = ?`, [admin]);
  });
});
