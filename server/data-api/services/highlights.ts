import { Database } from "bun:sqlite";
import { getDbPath } from "../lib/config";

// Passage-level highlights on book chapters — a highlighted quote, an optional
// note, a colour, and the character range within the chapter's plain text so the
// reader can re-anchor it. Per-member, stored in akita.db alongside bookmarks.

const DB_PATH = getDbPath("akita.db");

let db: Database;
function getDb(): Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS highlights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id TEXT NOT NULL DEFAULT '',
        book_id INTEGER NOT NULL,
        chapter_slug TEXT NOT NULL,
        quote TEXT NOT NULL,
        note TEXT,
        color TEXT NOT NULL DEFAULT 'yellow',
        start_offset INTEGER,
        end_offset INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_highlights_member_book ON highlights(member_id, book_id)`);
  }
  return db;
}

export interface Highlight {
  id: number;
  book_id: number;
  chapter_slug: string;
  quote: string;
  note: string | null;
  color: string;
  start_offset: number | null;
  end_offset: number | null;
  created_at: string;
}

/** All of a member's highlights for a book, newest first. */
export function listHighlights(memberId: string, bookId: number): Highlight[] {
  return getDb()
    .query("SELECT * FROM highlights WHERE member_id = ? AND book_id = ? ORDER BY created_at DESC")
    .all(memberId, bookId) as Highlight[];
}

export interface NewHighlight {
  chapterSlug: string;
  quote: string;
  note?: string | null;
  color?: string;
  startOffset?: number | null;
  endOffset?: number | null;
}

export function createHighlight(memberId: string, bookId: number, h: NewHighlight): Highlight {
  return getDb()
    .query(
      `INSERT INTO highlights (member_id, book_id, chapter_slug, quote, note, color, start_offset, end_offset)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      memberId,
      bookId,
      h.chapterSlug,
      h.quote,
      h.note ?? null,
      h.color || "yellow",
      h.startOffset ?? null,
      h.endOffset ?? null,
    ) as Highlight;
}

/** Update the note and/or colour of a highlight. Only the given fields change. */
export function updateHighlight(
  memberId: string,
  id: number,
  fields: { note?: string | null; color?: string },
): Highlight | null {
  const db = getDb();
  const existing = db
    .query("SELECT * FROM highlights WHERE id = ? AND member_id = ?")
    .get(id, memberId) as Highlight | null;
  if (!existing) return null;

  const note = fields.note === undefined ? existing.note : fields.note;
  const color = fields.color ?? existing.color;
  return db
    .query("UPDATE highlights SET note = ?, color = ? WHERE id = ? AND member_id = ? RETURNING *")
    .get(note, color, id, memberId) as Highlight;
}

export function deleteHighlight(memberId: string, id: number): boolean {
  const result = getDb()
    .query("DELETE FROM highlights WHERE id = ? AND member_id = ? RETURNING id")
    .get(id, memberId);
  return result !== null;
}
