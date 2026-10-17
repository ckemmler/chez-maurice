// The night's export into the garden (services/gardenExport.ts). What is held
// down: highlights, reading positions and archived entries land under
// _maurice/ as text, linked to the garden's entries; nothing of another
// member is ever written, in life.db or in a shared room; conversations only
// when the member asked, and gone again when they stop asking; a second night
// with nothing new rewrites nothing and commits nothing; a commit is signed
// `Maurice (export)`, holds only _maurice/ and the .gitignore, and leaves alone
// what another writer has staged; no database enters the history; and the
// snapshot of life.db stays whole while another process writes into it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";

const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "maurice-garden-export-"));
const GARDENS = path.join(TMP, "gardens");
const LIFE = path.join(TMP, "life.db");
fs.mkdirSync(GARDENS, { recursive: true });
process.env.MAURICE_GARDENS_DIR = GARDENS;

const db = (await import("../src/db")).default;
const { createSession } = await import("../src/services/auth");
const ex = await import("../src/services/gardenExport");
const meRoutes = (await import("../src/routes/me")).default;

const A = "ge-ada", B = "ge-ben";
const ADA = path.join(GARDENS, "geada");
const BEN = path.join(GARDENS, "geben");

const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
const deps = { book: async (id: number) => (id === 7 ? { title: "Being You", authors: ["Anil Seth"] } : null) };
const commits = (root: string) => git(root, "rev-list", "--count", "HEAD").stdout.trim();
/** Every file of a member's export, concatenated. */
const everything = (root: string) => {
  const dir = path.join(root, "_maurice");
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile())
    .map((f) => fs.readFileSync(f, "utf8")).join("\n");
};

function lifeDb(): Database {
  const d = new Database(LIFE);
  d.exec("PRAGMA journal_mode=WAL");
  d.exec(`
    CREATE TABLE IF NOT EXISTS highlights (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id TEXT NOT NULL DEFAULT '',
      book_id INTEGER NOT NULL, chapter_slug TEXT NOT NULL, quote TEXT NOT NULL, note TEXT, color TEXT NOT NULL DEFAULT 'yellow',
      start_offset INTEGER, end_offset INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), view TEXT NOT NULL DEFAULT 'full');
    CREATE TABLE IF NOT EXISTS article_highlights (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id TEXT NOT NULL DEFAULT '',
      locale TEXT NOT NULL, slug TEXT NOT NULL, quote TEXT NOT NULL, note TEXT, color TEXT NOT NULL DEFAULT 'yellow',
      start_offset INTEGER, end_offset INTEGER, view TEXT NOT NULL DEFAULT 'full', created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS reading_progress (member_id TEXT NOT NULL DEFAULT '', book_id INTEGER NOT NULL,
      chapter_index INTEGER NOT NULL, chapter_slug TEXT NOT NULL, view TEXT NOT NULL DEFAULT 'summary',
      enabled INTEGER NOT NULL DEFAULT 0, position REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (member_id, book_id));
    CREATE TABLE IF NOT EXISTS shelf_archive (member_id TEXT NOT NULL, entry_id TEXT NOT NULL,
      archived_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (member_id, entry_id));
  `);
  return d;
}

function garden(root: string) {
  fs.mkdirSync(path.join(root, "books", "fr"), { recursive: true });
  fs.mkdirSync(path.join(root, "articles", "fr"), { recursive: true });
  git(root, "init", "-q", "--initial-branch=main");
  git(root, "config", "user.name", "t");
  git(root, "config", "user.email", "t@t");
}

/** Export one member from a fresh snapshot, as the night does. */
async function run(memberId: string) {
  const snap = ex.snapshot(LIFE)!;
  try { return (await ex.exportMemberGarden(memberId, snap.db, deps))!; } finally { snap.done(); }
}

beforeAll(() => {
  process.env.MAURICE_GARDENS_DIR = GARDENS;
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(`INSERT INTO users (id, username, display_name, role) VALUES (?, 'geada', 'Ada', 'standard')`, [A]);
  db.run(`INSERT INTO users (id, username, display_name, role) VALUES (?, 'geben', 'Ben', 'standard')`, [B]);

  garden(ADA);
  fs.writeFileSync(path.join(ADA, "books", "fr", "being-you.md"), "---\ntitle: Being You\n---\n\nLa carte.\n");
  fs.writeFileSync(path.join(ADA, "books", "fr", "being-you-fiche.md"), "---\ntitle: Being You\nmeta:\n  calibre_id: 7\n---\n\nLa fiche.\n");
  fs.writeFileSync(path.join(ADA, "articles", "fr", "burkina.md"), "---\ntitle: Burkina Faso\n---\n\nL'article.\n");
  git(ADA, "add", "-A");
  git(ADA, "commit", "-qm", "the garden");
  garden(BEN);
  fs.writeFileSync(path.join(BEN, "notes.md"), "ben\n");
  git(BEN, "add", "-A");
  git(BEN, "commit", "-qm", "ben's garden");

  const life = lifeDb();
  const hl = life.prepare(`INSERT INTO highlights (member_id, book_id, chapter_slug, quote, note, start_offset, created_at, view) VALUES (?, ?, ?, ?, ?, ?, '2026-09-20 10:00:00', ?)`);
  hl.run(A, 7, "chapter-10", "A later chapter.", null, 5, "full");
  hl.run(A, 7, "chapter-2", "Perception is controlled hallucination.", "The core idea.", 40, "full");
  hl.run(A, 7, "chapter-2", "An earlier passage.\nOn two lines.", null, 10, "summary");
  hl.run(B, 7, "chapter-2", "ben-secret-quote", "ben-secret-note", 1, "full");
  life.run(`INSERT INTO article_highlights (member_id, locale, slug, quote, created_at) VALUES (?, 'fr', 'burkina', 'Un passage de l’article.', '2026-09-21 09:00:00')`, [A]);
  life.run(`INSERT INTO article_highlights (member_id, locale, slug, quote) VALUES (?, 'fr', 'burkina', 'ben-article-quote')`, [B]);
  life.run(`INSERT INTO reading_progress (member_id, book_id, chapter_index, chapter_slug, position, updated_at) VALUES (?, 7, 2, 'chapter-2', 0.5, '2026-09-22 08:00:00')`, [A]);
  life.run(`INSERT INTO reading_progress (member_id, book_id, chapter_index, chapter_slug, position) VALUES (?, 99, 1, 'ben-chapter', 0.1)`, [B]);
  life.run(`INSERT INTO shelf_archive (member_id, entry_id, archived_at) VALUES (?, 'articles/fr/zebra', '2026-09-01 00:00:00'), (?, 'articles/fr/aardvark', '2026-09-02 00:00:00')`, [A, A]);
  life.run(`INSERT INTO shelf_archive (member_id, entry_id) VALUES (?, 'articles/fr/ben-archived')`, [B]);
  life.close();

  // A conversation of Ada's, a room Ada sits in with Ben, a conversation of Ben's.
  db.run(`INSERT INTO conversations (id, user_id, title, created_at) VALUES ('ge-c-ada', ?, 'Sur la conscience', '2026-10-01 12:00:00')`, [A]);
  db.run(`INSERT INTO messages (id, conversation_id, role, content, author_id, created_at) VALUES ('ge-m1', 'ge-c-ada', 'user', 'ada-question', ?, '2026-10-01 12:00:00')`, [A]);
  db.run(`INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('ge-m2', 'ge-c-ada', 'assistant', 'maurice-answer', '2026-10-01 12:00:05')`);
  db.run(`INSERT INTO conversations (id, user_id, title, created_at) VALUES ('ge-c-room', ?, 'Salon', '2026-10-02 12:00:00')`, [B]);
  db.run(`INSERT INTO conversation_participants (conversation_id, member_id, role) VALUES ('ge-c-room', ?, 'owner'), ('ge-c-room', ?, 'member')`, [B, A]);
  db.run(`INSERT INTO messages (id, conversation_id, role, content, author_id, created_at) VALUES ('ge-m3', 'ge-c-room', 'user', 'ada-in-room', ?, '2026-10-02 12:00:00')`, [A]);
  db.run(`INSERT INTO messages (id, conversation_id, role, content, author_id, created_at) VALUES ('ge-m4', 'ge-c-room', 'user', 'ben-in-room', ?, '2026-10-02 12:01:00')`, [B]);
  db.run(`INSERT INTO conversations (id, user_id, title) VALUES ('ge-c-ben', ?, 'Ben seul')`, [B]);
  db.run(`INSERT INTO messages (id, conversation_id, role, content, author_id) VALUES ('ge-m5', 'ge-c-ben', 'user', 'ben-private', ?)`, [B]);
});

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe("the export", () => {
  test("writes highlights, reading and archives as text, linked to the garden's entries", async () => {
    const r = await run(A);
    expect(r.committed).toBe(true);
    const book = fs.readFileSync(path.join(ADA, "_maurice", "highlights", "books", "being-you.md"), "utf8");
    expect(book).toContain("[[books/fr/being-you-fiche|Being You]]");
    expect(book).toContain('authors: ["Anil Seth"]');
    // Chapters in their natural order, passages by offset, quotes as quotes.
    expect(book.indexOf("## chapter-2")).toBeLessThan(book.indexOf("## chapter-10"));
    expect(book.indexOf("An earlier passage.")).toBeLessThan(book.indexOf("Perception is controlled"));
    expect(book).toContain("> An earlier passage.\n> On two lines.");
    expect(book).toContain("The core idea.");
    expect(book).toContain("*2026-09-20 · yellow · summary*");

    const article = fs.readFileSync(path.join(ADA, "_maurice", "highlights", "articles", "burkina.md"), "utf8");
    expect(article).toContain("[[articles/fr/burkina|Burkina Faso]]");

    const progress = fs.readFileSync(path.join(ADA, "_maurice", "reading", "progress.jsonl"), "utf8");
    expect(progress).toBe(
      `{"book_id":7,"title":"Being You","chapter_index":2,"chapter_slug":"chapter-2","view":"summary","enabled":false,"position":0.5,"updated_at":"2026-09-22T08:00:00Z"}\n`,
    );
    const archived = fs.readFileSync(path.join(ADA, "_maurice", "reading", "archived.jsonl"), "utf8").trim().split("\n");
    expect(archived.map((l) => JSON.parse(l).entry_id)).toEqual(["articles/fr/aardvark", "articles/fr/zebra"]);

    expect(fs.existsSync(path.join(ADA, "_maurice", "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(ADA, "_maurice", "conversations"))).toBe(false);
  });

  test("never writes anything of another member", async () => {
    const all = everything(ADA);
    for (const s of ["ben-secret", "ben-article-quote", "ben-chapter", "ben-archived", "ben-in-room", "ben-private"]) {
      expect(all).not.toContain(s);
    }
    const r = await run(B);
    expect(r.committed).toBe(true);
    const bens = everything(BEN);
    expect(bens).toContain("ben-secret-quote");
    expect(bens).not.toContain("Perception is controlled");
  });

  test("a commit is signed, holds only the export, and the history holds no database", () => {
    expect(git(ADA, "log", "-1", "--format=%an <%ae>").stdout.trim()).toBe(ex.EXPORT_AUTHOR);
    expect(git(ADA, "log", "-1", "--format=%s").stdout.trim()).toMatch(/^Daily export: /);
    const files = git(ADA, "show", "--name-only", "--format=", "HEAD").stdout.trim().split("\n");
    expect(files.every((f) => f.startsWith("_maurice/") || f === ".gitignore")).toBe(true);
    expect(fs.readFileSync(path.join(ADA, ".gitignore"), "utf8")).toContain("*.db");
    expect(git(ADA, "ls-files").stdout.split("\n").some((f) => /\.(db|sqlite3?)(-wal|-shm)?$/.test(f))).toBe(false);
    expect(git(ADA, "status", "--porcelain").stdout.trim()).toBe("");
  });

  test("a night with nothing new rewrites nothing and commits nothing", async () => {
    const before = commits(ADA);
    const stat = fs.statSync(path.join(ADA, "_maurice", "highlights", "books", "being-you.md")).mtimeMs;
    const r = await run(A);
    expect(r).toMatchObject({ written: 0, removed: 0, committed: false });
    expect(commits(ADA)).toBe(before);
    expect(fs.statSync(path.join(ADA, "_maurice", "highlights", "books", "being-you.md")).mtimeMs).toBe(stat);
  });

  test("a change is one commit of one file, and leaves another writer's staged work alone", async () => {
    // The garden tool has staged a note for its own commit when the night comes.
    fs.mkdirSync(path.join(ADA, "notes", "fr"), { recursive: true });
    fs.writeFileSync(path.join(ADA, "notes", "fr", "staged.md"), "staged by someone else\n");
    git(ADA, "add", "notes/fr/staged.md");

    const life = new Database(LIFE);
    life.run(`INSERT INTO highlights (member_id, book_id, chapter_slug, quote, start_offset) VALUES (?, 7, 'chapter-10', 'A new mark.', 99)`, [A]);
    life.close();
    const before = Number(commits(ADA));
    const r = await run(A);
    expect(r).toMatchObject({ written: 1, removed: 0, committed: true });
    expect(Number(commits(ADA))).toBe(before + 1);
    expect(git(ADA, "show", "--name-only", "--format=", "HEAD").stdout.trim()).toBe("_maurice/highlights/books/being-you.md");
    expect(git(ADA, "diff", "--cached", "--name-only").stdout.trim()).toBe("notes/fr/staged.md");
    git(ADA, "commit", "-qm", "the other writer's commit");
  });

  test("conversations only when asked, a room with only the member's words, gone when no longer asked", async () => {
    ex.setExportsConversations(A, true);
    await run(A);
    const dir = path.join(ADA, "_maurice", "conversations");
    const names = fs.readdirSync(dir).sort();
    expect(names).toEqual(["2026-10-01-sur-la-conscience-ge-c-ada.md", "2026-10-02-salon-ge-c-roo.md"]);
    const solo = fs.readFileSync(path.join(dir, names[0]!), "utf8");
    expect(solo).toContain("**Ada** · 2026-10-01T12:00:00Z\n\nada-question");
    expect(solo).toContain("**Maurice** · 2026-10-01T12:00:05Z\n\nmaurice-answer");
    const room = fs.readFileSync(path.join(dir, names[1]!), "utf8");
    expect(room).toContain("ada-in-room");
    expect(room).not.toContain("ben-in-room");
    expect(room).toContain("room: true");
    expect(everything(ADA)).not.toContain("ben-private");

    ex.setExportsConversations(A, false);
    const r = await run(A);
    expect(r.committed).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    expect(git(ADA, "ls-files", "_maurice/conversations").stdout.trim()).toBe("");
  });

  test("every member with a garden, from one snapshot", async () => {
    const results = await ex.exportAllGardens(deps, LIFE);
    const mine = results.filter((r) => r.member === "geada" || r.member === "geben");
    expect(mine.map((r) => r.member).sort()).toEqual(["geada", "geben"]);
    expect(mine.every((r) => !r.committed)).toBe(true);
    expect(fs.readdirSync(path.join(process.env.MAURICE_DATA_DIR!, "tmp")).filter((f) => f.startsWith("garden-export-"))).toEqual([]);
  });
});

describe("the snapshot", () => {
  test("stays whole while another process writes into life.db", async () => {
    // A writer in its own process, committing batches of ten rows as fast as it can.
    const script = `
      import { Database } from "bun:sqlite";
      const d = new Database(${JSON.stringify(LIFE)});
      d.exec("PRAGMA busy_timeout = 5000");
      const ins = d.prepare("INSERT INTO highlights (member_id, book_id, chapter_slug, quote) VALUES ('ge-writer', 1, 'c', 'x')");
      const batch = d.transaction(() => { for (let i = 0; i < 10; i++) ins.run(); });
      const until = Date.now() + 1500;
      while (Date.now() < until) batch();
      d.close();
    `;
    const writer = Bun.spawn(["bun", "-e", script], { stdout: "ignore", stderr: "pipe" });
    await Bun.sleep(150);
    const counts: number[] = [];
    for (let i = 0; i < 8; i++) {
      const snap = ex.snapshot(LIFE)!;
      try {
        expect((snap.db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
        const n = (snap.db.query("SELECT COUNT(*) AS n FROM highlights WHERE member_id = 'ge-writer'").get() as { n: number }).n;
        // Never half a transaction.
        expect(n % 10).toBe(0);
        counts.push(n);
        // The copy holds no WAL of its own: the live file's sidecars are not part of it.
        expect((snap.db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).not.toBe("wal");
      } finally {
        snap.done();
      }
      await Bun.sleep(100);
    }
    expect(await writer.exited).toBe(0);
    expect(counts.some((n) => n > 0)).toBe(true);
    for (let i = 1; i < counts.length; i++) expect(counts[i]!).toBeGreaterThanOrEqual(counts[i - 1]!);
  });
});

describe("the night", () => {
  test("is due once per local day from the set time", () => {
    const at = { hour: 3, minute: 30 };
    const d = (s: string) => new Date(s);
    expect(ex.exportDue(d("2026-10-17T03:29:00"), null, at)).toBe(false);
    expect(ex.exportDue(d("2026-10-17T03:30:00"), null, at)).toBe(true);
    expect(ex.exportDue(d("2026-10-17T09:00:00"), d("2026-10-17T03:31:00").toISOString(), at)).toBe(false);
    expect(ex.exportDue(d("2026-10-18T03:45:00"), d("2026-10-17T03:31:00").toISOString(), at)).toBe(true);
  });

  test("its time comes from MAURICE_GARDEN_EXPORT_AT", () => {
    expect(ex.exportTime({})).toEqual({ hour: 3, minute: 30 });
    expect(ex.exportTime({ MAURICE_GARDEN_EXPORT_AT: "05:15" })).toEqual({ hour: 5, minute: 15 });
    expect(ex.exportTime({ MAURICE_GARDEN_EXPORT_AT: "off" })).toBeNull();
  });

  test("the member turns their conversations on and off", async () => {
    const app = new Hono();
    app.route("/api/me", meRoutes);
    const { token } = createSession(B);
    const put = (body: unknown) => app.request("/api/me/git/export", {
      method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    expect(await (await put({ conversations: true })).json()).toEqual({ export_conversations: true });
    expect(ex.exportsConversations(B)).toBe(true);
    expect((await put({ conversations: "yes" })).status).toBe(400);
    expect(await (await put({ conversations: false })).json()).toEqual({ export_conversations: false });
  });
});
