import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { getDbPath } from "../lib/config";

const DB_PATH = getDbPath("recommendations.db");

export interface ArticleRecommendation {
  id: number;
  url: string;
  title: string;
  summary: string | null;
  og_image: string | null;
  og_title: string | null;
  og_description: string | null;
  og_site_name: string | null;
  track_id: string;
  plan_id: string;
  media_type: string;
  recommended_at: string;
}

export interface BookRecommendation {
  id: number;
  title: string;
  author: string | null;
  summary: string | null;
  track_id: string;
  plan_id: string;
  calibre_book_id: number | null;
  cover_url: string | null;
  pub_year: number | null;
  page_count: number | null;
  publisher: string | null;
  isbn: string | null;
  recommended_at: string;
}

function getDb(readonly = true): Database | null {
  if (!existsSync(DB_PATH)) return null;
  if (readonly) return new Database(DB_PATH, { readonly: true });
  return new Database(DB_PATH);
}

/** Check whether a column exists in a table. */
function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.length === 0) return true; // table doesn't exist yet — skip migration
  return rows.some((r) => r.name === column);
}

/** Run once at startup: add media_type column if missing. */
function migrateMediaType(): void {
  if (!existsSync(DB_PATH)) return;
  const db = new Database(DB_PATH);
  try {
    if (!hasColumn(db, "article_recommendations", "media_type")) {
      db.query("ALTER TABLE article_recommendations ADD COLUMN media_type TEXT NOT NULL DEFAULT 'article'").run();
    }
  } finally {
    db.close();
  }
}
migrateMediaType();

export function getArticleRecommendations(memberId: string, opts?: {
  trackId?: string;
  month?: string;
  mediaType?: string;
  sortOrder?: "asc" | "desc";
  limit?: number;
}): ArticleRecommendation[] {
  const db = getDb();
  if (!db) return [];
  try {
    const limit = opts?.limit ?? 100;
    const sort = opts?.sortOrder === "asc" ? "ASC" : "DESC";
    const conditions: string[] = ["member_id = ?"];
    const params: (string | number)[] = [memberId];

    if (opts?.trackId) {
      conditions.push("track_id = ?");
      params.push(opts.trackId);
    }
    if (opts?.month) {
      conditions.push("strftime('%Y-%m', recommended_at) = ?");
      params.push(opts.month);
    }
    if (opts?.mediaType) {
      conditions.push("media_type = ?");
      params.push(opts.mediaType);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;
    params.push(limit);

    return db
      .query(
        `SELECT * FROM article_recommendations ${where} ORDER BY recommended_at ${sort} LIMIT ?`,
      )
      .all(...params) as ArticleRecommendation[];
  } finally {
    db.close();
  }
}

export function getDistinctMediaTypes(memberId: string): string[] {
  const db = getDb();
  if (!db) return [];
  try {
    const rows = db
      .query("SELECT DISTINCT media_type FROM article_recommendations WHERE member_id = ? ORDER BY media_type")
      .all(memberId) as Array<{ media_type: string }>;
    return rows.map((r) => r.media_type);
  } finally {
    db.close();
  }
}

export function getBookRecommendations(memberId: string, opts?: {
  trackId?: string;
  month?: string;
  sortOrder?: "asc" | "desc";
  limit?: number;
}): BookRecommendation[] {
  const db = getDb();
  if (!db) return [];
  try {
    const limit = opts?.limit ?? 100;
    const sort = opts?.sortOrder === "asc" ? "ASC" : "DESC";
    const conditions: string[] = ["member_id = ?"];
    const params: (string | number)[] = [memberId];

    if (opts?.trackId) {
      conditions.push("track_id = ?");
      params.push(opts.trackId);
    }
    if (opts?.month) {
      conditions.push("strftime('%Y-%m', recommended_at) = ?");
      params.push(opts.month);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;
    params.push(limit);

    return db
      .query(
        `SELECT * FROM book_recommendations ${where} ORDER BY recommended_at ${sort} LIMIT ?`,
      )
      .all(...params) as BookRecommendation[];
  } finally {
    db.close();
  }
}

export function getBookCounts(memberId: string): Array<{
  title: string;
  author: string | null;
  total_count: number;
  calibre_book_id: number | null;
  tracks: string;
}> {
  const db = getDb();
  if (!db) return [];
  try {
    return db
      .query(
        `SELECT title, author, COUNT(*) as total_count, calibre_book_id,
                GROUP_CONCAT(DISTINCT track_id) as tracks,
                MAX(cover_url) as cover_url,
                MAX(pub_year) as pub_year,
                MAX(page_count) as page_count,
                MAX(publisher) as publisher
         FROM book_recommendations
         WHERE member_id = ?
         GROUP BY title, author
         ORDER BY total_count DESC`,
      )
      .all(memberId) as Array<{
      title: string;
      author: string | null;
      total_count: number;
      calibre_book_id: number | null;
      tracks: string;
      cover_url: string | null;
      pub_year: number | null;
      page_count: number | null;
      publisher: string | null;
    }>;
  } finally {
    db.close();
  }
}

export function getArticlesByPlanId(memberId: string, planId: string): ArticleRecommendation[] {
  const db = getDb();
  if (!db) return [];
  try {
    return db
      .query("SELECT * FROM article_recommendations WHERE plan_id = ? AND member_id = ? ORDER BY id")
      .all(planId, memberId) as ArticleRecommendation[];
  } finally {
    db.close();
  }
}

export function getBooksByPlanId(memberId: string, planId: string): BookRecommendation[] {
  const db = getDb();
  if (!db) return [];
  try {
    return db
      .query("SELECT * FROM book_recommendations WHERE plan_id = ? AND member_id = ? ORDER BY id")
      .all(planId, memberId) as BookRecommendation[];
  } finally {
    db.close();
  }
}

export function deleteRecommendationsByPlanId(memberId: string, planId: string): void {
  const db = getDb(false);
  if (!db) return;
  try {
    db.query("DELETE FROM article_recommendations WHERE plan_id = ? AND member_id = ?").run(planId, memberId);
    db.query("DELETE FROM book_recommendations WHERE plan_id = ? AND member_id = ?").run(planId, memberId);
  } finally {
    db.close();
  }
}

export function deleteRecommendationsByTrackId(memberId: string, trackId: string): number {
  const db = getDb(false);
  if (!db) return 0;
  try {
    const arts = db.query("DELETE FROM article_recommendations WHERE track_id = ? AND member_id = ? RETURNING id").all(trackId, memberId).length;
    const books = db.query("DELETE FROM book_recommendations WHERE track_id = ? AND member_id = ? RETURNING id").all(trackId, memberId).length;
    return arts + books;
  } finally {
    db.close();
  }
}

export function getDistinctTrackIds(memberId: string, table: "article" | "book"): string[] {
  const db = getDb();
  if (!db) return [];
  try {
    const tableName = table === "article" ? "article_recommendations" : "book_recommendations";
    const rows = db
      .query(`SELECT DISTINCT track_id FROM ${tableName} WHERE member_id = ? ORDER BY track_id`)
      .all(memberId) as Array<{ track_id: string }>;
    return rows.map((r) => r.track_id);
  } finally {
    db.close();
  }
}
