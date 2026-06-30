/**
 * Signals service — reads signals from akita.db (SQLite, readonly).
 */

import { Database } from "bun:sqlite";
import { getDbPath } from "../lib/config";

const DB_PATH = getDbPath("akita.db");

let db: Database;
function getDb(): Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.exec("PRAGMA journal_mode=WAL");
  }
  return db;
}

let dbWrite: Database;
function getWriteDb(): Database {
  if (!dbWrite) {
    dbWrite = new Database(DB_PATH);
    dbWrite.exec("PRAGMA journal_mode=WAL");
  }
  return dbWrite;
}

export interface Signal {
  id: number;
  category: string | null;
  details: string;
  source: string | null;
  commit_sha: string | null;
  timestamp: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

export function listSignals(memberId: string, opts: {
  category?: string;
  excludeCategories?: string[];
  since?: string;
  until?: string;
  before?: string;
  limit?: number;
}): Signal[] {
  const conditions: string[] = ["member_id = $memberId"];
  const params: Record<string, string | number> = { $memberId: memberId };

  if (opts.category) {
    conditions.push("category = $category");
    params.$category = opts.category;
  }
  if (opts.excludeCategories?.length) {
    const placeholders = opts.excludeCategories.map((_, i) => `$excl${i}`);
    conditions.push(`(category IS NULL OR category NOT IN (${placeholders.join(", ")}))`);
    opts.excludeCategories.forEach((c, i) => { params[`$excl${i}`] = c; });
  }
  if (opts.since) {
    conditions.push("datetime(timestamp) >= datetime($since)");
    params.$since = opts.since;
  }
  if (opts.until) {
    conditions.push("datetime(timestamp) <= datetime($until)");
    params.$until = opts.until;
  }
  if (opts.before) {
    conditions.push("datetime(timestamp) < datetime($before)");
    params.$before = opts.before;
  }

  const limit = opts.limit ?? 100;
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `SELECT * FROM signals ${where} ORDER BY datetime(timestamp) DESC LIMIT $limit`;
  params.$limit = limit;

  const rows = getDb().prepare(query).all(params) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as number,
    category: r.category as string | null,
    details: r.details as string,
    source: r.source as string | null,
    commit_sha: r.commit_sha as string | null,
    timestamp: r.timestamp as string,
    created_at: r.created_at as string,
    metadata: r.metadata_json ? JSON.parse(r.metadata_json as string) : null,
    tags: r.tags_json ? JSON.parse(r.tags_json as string) : [],
  }));
}

export function signalSummary(memberId: string, opts: {
  since?: string;
  until?: string;
  excludeCategories?: string[];
}): Array<{ category: string | null; count: number }> {
  const conditions: string[] = ["member_id = $memberId"];
  const params: Record<string, string> = { $memberId: memberId };

  if (opts.since) {
    conditions.push("timestamp >= $since");
    params.$since = opts.since;
  }
  if (opts.until) {
    conditions.push("timestamp <= $until");
    params.$until = opts.until;
  }
  if (opts.excludeCategories?.length) {
    const placeholders = opts.excludeCategories.map((_, i) => `$excl${i}`);
    conditions.push(`(category IS NULL OR category NOT IN (${placeholders.join(", ")}))`);
    opts.excludeCategories.forEach((c, i) => { params[`$excl${i}`] = c; });
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `SELECT category, COUNT(*) as count FROM signals ${where} GROUP BY category ORDER BY count DESC`;

  return getDb().prepare(query).all(params) as Array<{ category: string | null; count: number }>;
}

export function createSignal(memberId: string, fields: {
  category?: string;
  details: string;
  source?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  timestamp?: string;
}): Signal & { tags?: string[] } {
  const db = getWriteDb();
  const now = new Date().toISOString();
  const row = db
    .prepare(
      `INSERT INTO signals (member_id, category, details, source, timestamp, created_at, metadata_json, tags_json)
       VALUES ($memberId, $category, $details, $source, $timestamp, $created_at, $metadata_json, $tags_json)
       RETURNING *`,
    )
    .get({
      $memberId: memberId,
      $category: fields.category ?? null,
      $details: fields.details,
      $source: fields.source ?? "api",
      $timestamp: fields.timestamp ?? now,
      $created_at: now,
      $metadata_json: fields.metadata ? JSON.stringify(fields.metadata) : null,
      $tags_json: fields.tags ? JSON.stringify(fields.tags) : null,
    }) as Record<string, unknown>;

  return {
    id: row.id as number,
    category: row.category as string | null,
    details: row.details as string,
    source: row.source as string | null,
    commit_sha: row.commit_sha as string | null,
    timestamp: row.timestamp as string,
    created_at: row.created_at as string,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json as string) : null,
    tags: row.tags_json ? JSON.parse(row.tags_json as string) : [],
  };
}

export function deleteSignal(memberId: string, id: number): boolean {
  const result = getWriteDb().prepare("DELETE FROM signals WHERE id = $id AND member_id = $memberId AND source != 'git'").run({ $id: id, $memberId: memberId });
  return result.changes > 0;
}

export function updateSignal(
  memberId: string,
  id: number,
  fields: {
    details?: string;
    category?: string | null;
    tags?: string[];
    timestamp?: string;
    metadata?: Record<string, unknown>;
  },
): Signal | null {
  const db = getWriteDb();
  const sets: string[] = [];
  const params: Record<string, string | number | null> = { $id: id, $memberId: memberId };

  if (fields.details !== undefined) {
    sets.push("details = $details");
    params.$details = fields.details;
  }
  if (fields.category !== undefined) {
    sets.push("category = $category");
    params.$category = fields.category;
  }
  if (fields.tags !== undefined) {
    sets.push("tags_json = $tags_json");
    params.$tags_json = JSON.stringify(fields.tags);
  }
  if (fields.timestamp !== undefined) {
    sets.push("timestamp = $timestamp");
    params.$timestamp = fields.timestamp;
  }
  if (fields.metadata !== undefined) {
    sets.push("metadata_json = $metadata_json");
    params.$metadata_json = JSON.stringify(fields.metadata);
  }

  if (sets.length === 0) return null;

  const query = `UPDATE signals SET ${sets.join(", ")} WHERE id = $id AND member_id = $memberId AND source != 'git' RETURNING *`;
  const row = db.prepare(query).get(params) as Record<string, unknown> | null;
  if (!row) return null;

  return {
    id: row.id as number,
    category: row.category as string | null,
    details: row.details as string,
    source: row.source as string | null,
    commit_sha: row.commit_sha as string | null,
    timestamp: row.timestamp as string,
    created_at: row.created_at as string,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json as string) : null,
    tags: row.tags_json ? JSON.parse(row.tags_json as string) : [],
  } as Signal & { tags?: string[] };
}

export interface AggregatedSignal {
  details: string;
  uses: number;
  last_timestamp: string;
  last_id: number;
  tags: string[];
  today_count: number;
}

export function aggregateSignals(memberId: string, opts: {
  category: string;
  todayDate?: string;
}): AggregatedSignal[] {
  const today = opts.todayDate ?? new Date().toISOString().slice(0, 10);
  const query = `
    SELECT
      details,
      COUNT(*) as uses,
      COALESCE(MAX(datetime(timestamp)), MAX(timestamp)) as last_timestamp,
      (SELECT s2.id FROM signals s2 WHERE s2.member_id = $memberId AND s2.category = s.category AND s2.details = s.details ORDER BY datetime(s2.timestamp) DESC LIMIT 1) as last_id,
      (SELECT s3.tags_json FROM signals s3 WHERE s3.member_id = $memberId AND s3.category = s.category AND s3.details = s.details ORDER BY datetime(s3.timestamp) DESC LIMIT 1) as tags_json,
      SUM(CASE WHEN date(timestamp) = $today THEN 1 ELSE 0 END) as today_count
    FROM signals s
    WHERE member_id = $memberId AND category = $category
    GROUP BY details
    ORDER BY uses DESC
  `;

  const rows = getDb().prepare(query).all({
    $memberId: memberId,
    $category: opts.category,
    $today: today,
  }) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    details: r.details as string,
    uses: r.uses as number,
    last_timestamp: r.last_timestamp as string,
    last_id: r.last_id as number,
    tags: r.tags_json ? JSON.parse(r.tags_json as string) : [],
    today_count: r.today_count as number,
  }));
}
