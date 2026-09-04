import { Database } from "bun:sqlite";
import { getDbPath } from "../lib/config";
import { asHighlightView, type HighlightView } from "./highlights";

// Passage-level highlights on saved articles — the article twin of
// highlights.ts. A separate table rather than a generalised one because the
// anchor is structurally different: a book highlight hangs off a Calibre
// integer id + chapter slug, an article highlight off the fiche's locale+slug.
// Making `book_id` nullable and adding a subject discriminator would leave
// every existing reader-side query wondering which kind it holds; two small
// tables keep both unambiguous. Per-member, stored in akita.db alongside the
// book highlights.
//
// An article has two texts, like a chapter: the captured full text and the
// frontmatter summary. `view` says which one the offsets index.

const DB_PATH = getDbPath("akita.db");

let db: Database;
function getDb(): Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS article_highlights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id TEXT NOT NULL DEFAULT '',
        locale TEXT NOT NULL,
        slug TEXT NOT NULL,
        quote TEXT NOT NULL,
        note TEXT,
        color TEXT NOT NULL DEFAULT 'yellow',
        start_offset INTEGER,
        end_offset INTEGER,
        view TEXT NOT NULL DEFAULT 'full',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_article_highlights_member_article
       ON article_highlights(member_id, locale, slug)`,
    );
  }
  return db;
}

export interface ArticleHighlight {
  id: number;
  locale: string;
  slug: string;
  quote: string;
  note: string | null;
  color: string;
  start_offset: number | null;
  end_offset: number | null;
  view: HighlightView;
  created_at: string;
}

/** A member's highlights on one article, newest first. */
export function listArticleHighlights(
  memberId: string,
  locale: string,
  slug: string,
): ArticleHighlight[] {
  return getDb()
    .query(
      `SELECT id, locale, slug, quote, note, color, start_offset, end_offset, view, created_at
       FROM article_highlights WHERE member_id = ? AND locale = ? AND slug = ?
       ORDER BY created_at DESC`,
    )
    .all(memberId, locale, slug) as ArticleHighlight[];
}

/** How many highlights each of a member's articles carries — for list badges. */
export function countArticleHighlights(memberId: string): Map<string, number> {
  const rows = getDb()
    .query(
      `SELECT locale, slug, COUNT(*) AS n FROM article_highlights
       WHERE member_id = ? GROUP BY locale, slug`,
    )
    .all(memberId) as { locale: string; slug: string; n: number }[];
  return new Map(rows.map((r) => [`${r.locale}/${r.slug}`, r.n]));
}

export interface NewArticleHighlight {
  quote: string;
  note?: string | null;
  color?: string;
  startOffset?: number | null;
  endOffset?: number | null;
  view?: HighlightView;
}

export function createArticleHighlight(
  memberId: string,
  locale: string,
  slug: string,
  h: NewArticleHighlight,
): ArticleHighlight {
  return getDb()
    .query(
      `INSERT INTO article_highlights (member_id, locale, slug, quote, note, color, start_offset, end_offset, view)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id, locale, slug, quote, note, color, start_offset, end_offset, view, created_at`,
    )
    .get(
      memberId,
      locale,
      slug,
      h.quote,
      h.note ?? null,
      h.color || "yellow",
      h.startOffset ?? null,
      h.endOffset ?? null,
      asHighlightView(h.view),
    ) as ArticleHighlight;
}

/** Update the note and/or colour of a highlight. Only the given fields change. */
export function updateArticleHighlight(
  memberId: string,
  id: number,
  fields: { note?: string | null; color?: string },
): ArticleHighlight | null {
  const db = getDb();
  const existing = db
    .query("SELECT * FROM article_highlights WHERE id = ? AND member_id = ?")
    .get(id, memberId) as ArticleHighlight | null;
  if (!existing) return null;

  const note = fields.note === undefined ? existing.note : fields.note;
  const color = fields.color ?? existing.color;
  return db
    .query(
      `UPDATE article_highlights SET note = ?, color = ? WHERE id = ? AND member_id = ?
       RETURNING id, locale, slug, quote, note, color, start_offset, end_offset, view, created_at`,
    )
    .get(note, color, id, memberId) as ArticleHighlight;
}

export function deleteArticleHighlight(memberId: string, id: number): boolean {
  const result = getDb()
    .query("DELETE FROM article_highlights WHERE id = ? AND member_id = ? RETURNING id")
    .get(id, memberId);
  return result !== null;
}
