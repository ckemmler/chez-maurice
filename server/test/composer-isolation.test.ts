import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { join } from "node:path";
import { setDefaultLibrary, removeLibrary, getDefaultLibrary } from "../src/services/calibreLibraries";
import { gardensRoot } from "../src/services/gardensRoot";

// B6 cross-cutting: every composer endpoint is account-scoped, and the encrypted
// flag is carried through resolution (loaded, not blocked, in the single-user
// path). Integration test against the running server on :3001.
//
// Run: bun test server/test/composer-isolation.test.ts  (server must be up)

const BASE = "https://localhost:3001/api/v1/composer";
const tls = { rejectUnauthorized: false } as any;
const DATA = process.env.MAURICE_DATA_DIR || join(process.env.HOME || "", ".maurice");
const PAOLA_LIB = "/tmp/paola-cc-isolation";
// Seeded by this suite (see beforeAll) rather than borrowed from the developer's
// own garden: gardens are gitignored, so a real slug leaves the test red on any
// fresh clone. Written where the running server reads — its gardensRoot().
const ENCRYPTED_NOTE = "composer-isolation-encrypted-fixture";
const ENCRYPTED_NOTE_PATH = join(gardensRoot(), "candide", "notes", "en", `${ENCRYPTED_NOTE}.md`);

let candideTok = "", paolaTok = "", candideId = "", paolaId = "", candideOnlyConv = "";

function tokenFor(db: Database, username: string): { id: string; tok: string } {
  const u = db.query(`SELECT id FROM users WHERE username = ?`).get(username) as { id: string };
  const t = db
    .query(`SELECT token_plain FROM api_tokens WHERE user_id = ? AND label = 'mcp-settings'`)
    .get(u.id) as { token_plain: string };
  return { id: u.id, tok: t.token_plain };
}

async function api(tok: string, method: string, p: string, body?: any) {
  const r = await fetch(BASE + p, {
    method,
    headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    tls,
  });
  return { status: r.status, json: await r.json().catch(() => null) } as { status: number; json: any };
}

beforeAll(() => {
  const db = new Database(join(DATA, "maurice.db"));
  const c = tokenFor(db, "candide");
  const p = tokenFor(db, "paola");
  candideId = c.id; candideTok = c.tok; paolaId = p.id; paolaTok = p.tok;
  // a conversation candide is in but paola is not
  candideOnlyConv = (db
    .query(
      `SELECT conversation_id FROM conversation_participants
       WHERE member_id = ? AND conversation_id NOT IN
         (SELECT conversation_id FROM conversation_participants WHERE member_id = ?)
       LIMIT 1`,
    )
    .get(candideId, paolaId) as { conversation_id: string }).conversation_id;
  db.close();

  // An encrypted note for candide, so the carry-through assertions don't depend
  // on whatever happens to be in the developer's garden.
  fs.mkdirSync(path.dirname(ENCRYPTED_NOTE_PATH), { recursive: true });
  fs.writeFileSync(
    ENCRYPTED_NOTE_PATH,
    [
      "---",
      "title: Encrypted fixture (composer-isolation)",
      "locale: en",
      "flags: [encrypted]",
      "---",
      "",
      "Body text that must ride through resolution with the encrypted flag intact.",
      "",
    ].join("\n"),
  );

  // Build paola a distinct fake library with a colliding book_id=18.
  fs.rmSync(PAOLA_LIB, { recursive: true, force: true });
  const chDir = join(PAOLA_LIB, "Paola/Secret_18/chapters");
  const sumDir = join(PAOLA_LIB, "Paola/Secret_18/chapter_summaries");
  fs.mkdirSync(chDir, { recursive: true });
  fs.mkdirSync(sumDir, { recursive: true });
  // body chapter must exceed the tiny-stub threshold (else classified front-matter)
  fs.writeFileSync(
    join(chDir, "0001-Secret Chapter.txt"),
    "Paola secret chapter full text. " + "lorem ipsum ".repeat(120),
  );
  fs.writeFileSync(join(sumDir, "0001-Secret Chapter.summary.txt"), "Paola secret summary only.");
  const meta = new Database(join(PAOLA_LIB, "metadata.db"));
  meta.exec(`
    CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, path TEXT, series_index REAL DEFAULT 1.0);
    CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);
    INSERT INTO books (id,title,path) VALUES (18,'Paola Private Book','Paola/Secret_18');
    INSERT INTO authors (id,name) VALUES (1,'Paola Author');
    INSERT INTO books_authors_link (book,author) VALUES (18,1);
  `);
  meta.close();
  setDefaultLibrary(paolaId, PAOLA_LIB, "Paola Test");
});

afterAll(() => {
  fs.rmSync(ENCRYPTED_NOTE_PATH, { force: true });
  const lib = getDefaultLibrary(paolaId);
  if (lib && lib.library_root === PAOLA_LIB) removeLibrary(paolaId, lib.id);
  fs.rmSync(PAOLA_LIB, { recursive: true, force: true });
  // drop any specs this suite created
  const db = new Database(join(DATA, "maurice.db"));
  db.run(`DELETE FROM composer_specs WHERE account_id IN (?, ?)`, [candideId, paolaId]);
  db.close();
});

describe("composer encrypted carry-through (single-user path)", () => {
  it("an encrypted note resolves (loaded, flagged), not blocked", async () => {
    const r = await api(candideTok, "GET", `/notes/${ENCRYPTED_NOTE}/resolve`);
    expect(r.status).toBe(200);
    expect(r.json.tree.encrypted).toBe(true); // the flag rides through B2
  });

  it("encrypted flag survives into the spec snapshot and the text payload", async () => {
    const put = await api(candideTok, "PUT", `/context/${candideOnlyConv}`, {
      items: [{ type: "note", id: ENCRYPTED_NOTE, recurse: false }],
    });
    expect(put.status).toBe(200);
    expect(put.json.spec.items[0].snapshot.encrypted).toBe(true);
    const res = await api(candideTok, "GET", `/context/${candideOnlyConv}/resolve`);
    expect(res.json.items[0].encrypted).toBe(true);
    expect(res.json.items[0].text.length).toBeGreaterThan(0); // loaded, not blocked
  });
});

describe("composer account isolation", () => {
  it("search: paola sees no candide notes/books", async () => {
    const r = await api(paolaTok, "GET", `/search?q=being`);
    expect(r.status).toBe(200);
    const books = r.json.results.filter((x: any) => x.type === "book");
    expect(books.find((b: any) => /being you/i.test(b.title))).toBeUndefined();
    // and a candide-only note slug must not surface for paola
    const r2 = await api(paolaTok, "GET", `/search?q=akita`);
    expect(r2.json.results.find((x: any) => x.id === ENCRYPTED_NOTE)).toBeUndefined();
  });

  it("note resolve: paola cannot resolve a candide-only note", async () => {
    const r = await api(paolaTok, "GET", `/notes/${ENCRYPTED_NOTE}/resolve`);
    expect(r.status).toBe(404);
  });

  it("books: same book_id=18 resolves to each account's own book", async () => {
    const cand = await api(candideTok, "GET", `/books/18/chapters`);
    const paola = await api(paolaTok, "GET", `/books/18/chapters`);
    expect(cand.json.title).not.toBe(paola.json.title);
    expect(paola.json.title).toBe("Paola Private Book");
    expect(/being you/i.test(cand.json.title)).toBe(true);
  });

  it("book resolution text never crosses libraries", async () => {
    const put = await api(paolaTok, "PUT", `/context/${await paolaConv()}`, {
      items: [{ type: "book", id: 18, representation: "summary", scope: { mode: "all" } }],
    });
    expect(put.status).toBe(200);
    const res = await api(paolaTok, "GET", `/context/${await paolaConv()}/resolve`);
    const text = res.json.items[0].text;
    expect(text).toContain("Paola secret summary");
    expect(/being you|consciousness/i.test(text)).toBe(false);
  });

  it("weigh: paola weighing a candide-only note finds nothing (no leak)", async () => {
    const r = await api(paolaTok, "POST", `/weigh`, {
      items: [{ type: "note", id: ENCRYPTED_NOTE, recurse: true }],
    });
    expect(r.status).toBe(200);
    expect(r.json.items[0].missing).toBe(true);
    expect(r.json.items[0].weight).toBe(0);
  });

  it("context: a non-participant is forbidden", async () => {
    const r = await api(paolaTok, "GET", `/context/${candideOnlyConv}`);
    expect(r.status).toBe(403);
  });
});

// paola's own conversation (for her book-resolution spec)
let _paolaConv = "";
async function paolaConv(): Promise<string> {
  if (_paolaConv) return _paolaConv;
  const db = new Database(join(DATA, "maurice.db"));
  _paolaConv = (db
    .query(`SELECT conversation_id FROM conversation_participants WHERE member_id = ? LIMIT 1`)
    .get(paolaId) as { conversation_id: string }).conversation_id;
  db.close();
  return _paolaConv;
}
