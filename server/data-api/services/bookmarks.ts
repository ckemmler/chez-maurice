import { Database } from "bun:sqlite";
import { getDbPath } from "../lib/config";

let db: Database;
function getDb(): Database {
  if (!db) {
    // Resolved on first use, never at import: under `bun test` every suite
    // shares one process, so a path bound at module load is whichever suite
    // imported this file first — and a suite that sets MAURICE_DATA_DIR for
    // its own fixture silently gets the real database instead.
    db = new Database(getDbPath("akita.db"));
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
    migrateProgressKey(db);
  }
  return db;
}


/**
 * The table predates members: akita created it with `book_id INTEGER PRIMARY
 * KEY`, one row per book for one reader, and `member_id` was later bolted on
 * with ALTER — which cannot change a primary key. The CREATE above declares
 * the right key, but IF NOT EXISTS meant it never applied to a live database.
 *
 * Two consequences, both silent: two members could never both track the same
 * book, and `updateReadingProgress`'s `ON CONFLICT(member_id, book_id)` threw
 * "does not match any PRIMARY KEY or UNIQUE constraint" on every call — so no
 * reading position has ever reached the server from Carnet's reader.
 *
 * Rebuild the table with the composite key. Guarded on the actual key, so it
 * runs once and is a no-op on a database created by the CREATE above.
 */
function migrateProgressKey(db: Database): void {
  try {
    const cols = db.query("PRAGMA table_info(reading_progress)").all() as Array<{ name: string; pk: number }>;
    if (!cols.length) return;
    const keyed = cols.filter((c) => c.pk > 0).map((c) => c.name).sort();
    if (keyed.length === 2 && keyed[0] === "book_id" && keyed[1] === "member_id") return;

    db.exec("BEGIN");
    db.exec(`
      CREATE TABLE reading_progress_migrated (
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
    // The old key was book_id alone, so no two rows can collide on the new one.
    db.exec(`
      INSERT INTO reading_progress_migrated
        (member_id, book_id, chapter_index, chapter_slug, view, enabled, position, updated_at)
      SELECT COALESCE(member_id, ''), book_id, chapter_index, chapter_slug,
             COALESCE(view, 'summary'), COALESCE(enabled, 0), COALESCE(position, 0),
             COALESCE(updated_at, datetime('now'))
      FROM reading_progress
    `);
    db.exec("DROP TABLE reading_progress");
    db.exec("ALTER TABLE reading_progress_migrated RENAME TO reading_progress");
    db.exec("COMMIT");
    console.log("[bookmarks] reading_progress rekeyed on (member_id, book_id)");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    console.error("[bookmarks] reading_progress migration failed, left as it was:", e);
  }
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
  // Position is an opaque per-view offset (top character index for full text,
  // paragraph index for summaries) — a non-negative number, not a 0–1 fraction.
  const pos = Number.isFinite(position) && position >= 0 ? position : 0;
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
