import { Database } from "bun:sqlite";
import { getDbPath } from "../lib/config";

const DB_PATH = getDbPath("akita.db");

let db: Database;
function getDb(): Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS bookmarks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id TEXT NOT NULL DEFAULT '',
        book_id INTEGER NOT NULL,
        chapter_slug TEXT NOT NULL,
        view TEXT NOT NULL DEFAULT 'full',
        note TEXT,
        scope TEXT NOT NULL DEFAULT 'tenant',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(member_id, book_id, chapter_slug, view)
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS reading_progress (
        member_id TEXT NOT NULL DEFAULT '',
        book_id INTEGER NOT NULL,
        chapter_index INTEGER NOT NULL,
        chapter_slug TEXT NOT NULL,
        view TEXT NOT NULL DEFAULT 'summary',
        enabled INTEGER NOT NULL DEFAULT 0,
        position REAL NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (member_id, book_id)
      )
    `);
    // Migrations for existing tables
    try { db.exec("ALTER TABLE bookmarks ADD COLUMN member_id TEXT NOT NULL DEFAULT ''"); } catch {}
    try { db.exec("ALTER TABLE bookmarks ADD COLUMN scope TEXT NOT NULL DEFAULT 'tenant'"); } catch {}
    try { db.exec("ALTER TABLE reading_progress ADD COLUMN member_id TEXT NOT NULL DEFAULT ''"); } catch {}
    // Fractional scroll position (0–1) within the current chapter+view.
    try { db.exec("ALTER TABLE reading_progress ADD COLUMN position REAL NOT NULL DEFAULT 0"); } catch {}
  }
  return db;
}

export interface Bookmark {
  id: number;
  book_id: number;
  chapter_slug: string;
  view: string;
  note: string | null;
  created_at: string;
}

export function listBookmarks(memberId: string, bookId: number): Bookmark[] {
  return getDb()
    .query(
      "SELECT * FROM bookmarks WHERE member_id = ? AND book_id = ? ORDER BY created_at DESC",
    )
    .all(memberId, bookId) as Bookmark[];
}

export function toggleBookmark(
  memberId: string,
  bookId: number,
  chapterSlug: string,
  view: string,
  note?: string,
): { bookmarked: boolean; bookmark?: Bookmark } {
  const db = getDb();
  const existing = db
    .query("SELECT * FROM bookmarks WHERE member_id = ? AND book_id = ? AND chapter_slug = ? AND view = ?")
    .get(memberId, bookId, chapterSlug, view) as Bookmark | null;

  if (existing) {
    db.query("DELETE FROM bookmarks WHERE id = ? AND member_id = ?").run(existing.id, memberId);
    return { bookmarked: false };
  }

  const result = db
    .query(
      "INSERT INTO bookmarks (member_id, book_id, chapter_slug, view, note) VALUES (?, ?, ?, ?, ?) RETURNING *",
    )
    .get(memberId, bookId, chapterSlug, view, note ?? null) as Bookmark;

  return { bookmarked: true, bookmark: result };
}

export function updateBookmarkNote(memberId: string, id: number, note: string | null): Bookmark | null {
  const db = getDb();
  return db
    .query("UPDATE bookmarks SET note = ? WHERE id = ? AND member_id = ? RETURNING *")
    .get(note, id, memberId) as Bookmark | null;
}

export function deleteBookmark(memberId: string, id: number): boolean {
  const db = getDb();
  const result = db.query("DELETE FROM bookmarks WHERE id = ? AND member_id = ? RETURNING id").get(id, memberId);
  return result !== null;
}

// --- Reading Progress ---

export interface ReadingProgress {
  book_id: number;
  chapter_index: number;
  chapter_slug: string;
  view: string;
  enabled: number;
  position: number;
  updated_at: string;
}

export function getReadingProgress(memberId: string, bookId: number): ReadingProgress | null {
  return getDb()
    .query("SELECT * FROM reading_progress WHERE member_id = ? AND book_id = ?")
    .get(memberId, bookId) as ReadingProgress | null;
}

/**
 * Record the reader's last position — last-write-wins, per member, so it syncs
 * across a member's devices. Upserts unconditionally (tracking is on by default);
 * stores the exact chapter, view and fractional scroll `position` (0–1) they left
 * off at, rather than only advancing to the furthest chapter.
 */
export function updateReadingProgress(
  memberId: string,
  bookId: number,
  chapterIndex: number,
  chapterSlug: string,
  view: string,
  position: number = 0,
): ReadingProgress {
  const pos = Number.isFinite(position) ? Math.min(1, Math.max(0, position)) : 0;
  return getDb()
    .query(
      `INSERT INTO reading_progress (member_id, book_id, chapter_index, chapter_slug, view, enabled, position, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, datetime('now'))
       ON CONFLICT(member_id, book_id) DO UPDATE SET
         chapter_index = excluded.chapter_index,
         chapter_slug  = excluded.chapter_slug,
         view          = excluded.view,
         position      = excluded.position,
         updated_at    = datetime('now')
       RETURNING *`,
    )
    .get(memberId, bookId, chapterIndex, chapterSlug, view, pos) as ReadingProgress;
}

export function toggleReadingTracking(memberId: string, bookId: number): ReadingProgress {
  const db = getDb();
  const existing = db
    .query("SELECT * FROM reading_progress WHERE member_id = ? AND book_id = ?")
    .get(memberId, bookId) as ReadingProgress | null;

  if (existing) {
    return db
      .query(
        `UPDATE reading_progress SET enabled = ?, updated_at = datetime('now')
         WHERE member_id = ? AND book_id = ? RETURNING *`,
      )
      .get(existing.enabled ? 0 : 1, memberId, bookId) as ReadingProgress;
  }

  return db
    .query(
      `INSERT INTO reading_progress (member_id, book_id, chapter_index, chapter_slug, view, enabled)
       VALUES (?, ?, -1, '', 'summary', 1) RETURNING *`,
    )
    .get(memberId, bookId) as ReadingProgress;
}
