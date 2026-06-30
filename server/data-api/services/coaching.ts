/**
 * Coaching plans service — CRUD for autonomous coaching plans stored in akita.db.
 *
 * Plans are decoupled from garden notes and can exist independently.
 * Each plan has temporal activation (active_from / active_until) and
 * a metrics array describing what signals to track.
 */

import { Database } from "bun:sqlite";
import { getDbPath } from "../lib/config";

const DB_PATH = getDbPath("akita.db");

let db: Database;
function getDb(): Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.exec("PRAGMA journal_mode=WAL");
    ensureTable(db);
  }
  return db;
}

let dbWrite: Database;
function getWriteDb(): Database {
  if (!dbWrite) {
    dbWrite = new Database(DB_PATH);
    dbWrite.exec("PRAGMA journal_mode=WAL");
    ensureTable(dbWrite);
  }
  return dbWrite;
}

function ensureTable(d: Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS coaching_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      category TEXT,
      tags_json TEXT,
      active_from TEXT,
      active_until TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      metrics_json TEXT NOT NULL,
      note_slug TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

// ── Types ────────────────────────────────────────────────────────────

export interface MetricMatch {
  [field: string]: string | string[];
}

export interface CoachingMetric {
  pillar: string;
  signal_category: string;
  frequency?: string;
  duration_min?: number;
  match?: MetricMatch;
  enumerate?: boolean;
  max_per_day?: number;
}

export interface CoachingPlan {
  id: number;
  title: string;
  description: string | null;
  icon: string | null;
  category: string | null;
  tags: string[];
  active_from: string | null;
  active_until: string | null;
  archived: boolean;
  metrics: CoachingMetric[];
  note_slug: string | null;
  created_at: string;
  updated_at: string;
}

type Row = Record<string, unknown>;

function rowToPlan(r: Row): CoachingPlan {
  return {
    id: r.id as number,
    title: r.title as string,
    description: (r.description as string) ?? null,
    icon: (r.icon as string) ?? null,
    category: (r.category as string) ?? null,
    tags: r.tags_json ? JSON.parse(r.tags_json as string) : [],
    active_from: (r.active_from as string) ?? null,
    active_until: (r.active_until as string) ?? null,
    archived: (r.archived as number) === 1,
    metrics: JSON.parse(r.metrics_json as string),
    note_slug: (r.note_slug as string) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

// ── Queries ──────────────────────────────────────────────────────────

export function listPlans(memberId: string, opts?: {
  active_on?: string;
  category?: string;
  include_archived?: boolean;
}): CoachingPlan[] {
  const conditions: string[] = ["member_id = $memberId"];
  const params: Record<string, string | number> = { $memberId: memberId };

  if (!opts?.include_archived) {
    conditions.push("archived = 0");
  }

  if (opts?.category) {
    conditions.push("category = $category");
    params.$category = opts.category;
  }

  if (opts?.active_on) {
    conditions.push("(active_from IS NULL OR active_from <= $active_on)");
    conditions.push("(active_until IS NULL OR active_until >= $active_on)");
    params.$active_on = opts.active_on;
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `SELECT * FROM coaching_plans ${where} ORDER BY category, title`;

  const rows = getDb().prepare(query).all(params) as Row[];
  return rows.map(rowToPlan);
}

export function getPlan(memberId: string, id: number): CoachingPlan | null {
  const row = getDb()
    .prepare("SELECT * FROM coaching_plans WHERE id = $id AND member_id = $memberId")
    .get({ $id: id, $memberId: memberId }) as Row | null;
  return row ? rowToPlan(row) : null;
}

export interface CreatePlanInput {
  title: string;
  description?: string;
  icon?: string;
  category?: string;
  tags?: string[];
  active_from?: string;
  active_until?: string;
  metrics: CoachingMetric[];
  note_slug?: string;
}

export function createPlan(memberId: string, input: CreatePlanInput): CoachingPlan {
  const now = new Date().toISOString();
  const row = getWriteDb()
    .prepare(
      `INSERT INTO coaching_plans
         (member_id, title, description, icon, category, tags_json,
          active_from, active_until, metrics_json, note_slug,
          created_at, updated_at)
       VALUES
         ($memberId, $title, $description, $icon, $category, $tags_json,
          $active_from, $active_until, $metrics_json, $note_slug,
          $created_at, $updated_at)
       RETURNING *`,
    )
    .get({
      $memberId: memberId,
      $title: input.title,
      $description: input.description ?? null,
      $icon: input.icon ?? null,
      $category: input.category ?? null,
      $tags_json: input.tags ? JSON.stringify(input.tags) : null,
      $active_from: input.active_from ?? null,
      $active_until: input.active_until ?? null,
      $metrics_json: JSON.stringify(input.metrics),
      $note_slug: input.note_slug ?? null,
      $created_at: now,
      $updated_at: now,
    }) as Row;

  return rowToPlan(row);
}

export interface UpdatePlanInput {
  title?: string;
  description?: string | null;
  icon?: string | null;
  category?: string | null;
  tags?: string[];
  active_from?: string | null;
  active_until?: string | null;
  archived?: boolean;
  metrics?: CoachingMetric[];
  note_slug?: string | null;
}

export function updatePlan(memberId: string, id: number, input: UpdatePlanInput): CoachingPlan | null {
  const sets: string[] = ["updated_at = $updated_at"];
  const params: Record<string, string | number | null> = {
    $id: id,
    $memberId: memberId,
    $updated_at: new Date().toISOString(),
  };

  if (input.title !== undefined) {
    sets.push("title = $title");
    params.$title = input.title;
  }
  if (input.description !== undefined) {
    sets.push("description = $description");
    params.$description = input.description;
  }
  if (input.icon !== undefined) {
    sets.push("icon = $icon");
    params.$icon = input.icon;
  }
  if (input.category !== undefined) {
    sets.push("category = $category");
    params.$category = input.category;
  }
  if (input.tags !== undefined) {
    sets.push("tags_json = $tags_json");
    params.$tags_json = JSON.stringify(input.tags);
  }
  if (input.active_from !== undefined) {
    sets.push("active_from = $active_from");
    params.$active_from = input.active_from;
  }
  if (input.active_until !== undefined) {
    sets.push("active_until = $active_until");
    params.$active_until = input.active_until;
  }
  if (input.archived !== undefined) {
    sets.push("archived = $archived");
    params.$archived = input.archived ? 1 : 0;
  }
  if (input.metrics !== undefined) {
    sets.push("metrics_json = $metrics_json");
    params.$metrics_json = JSON.stringify(input.metrics);
  }
  if (input.note_slug !== undefined) {
    sets.push("note_slug = $note_slug");
    params.$note_slug = input.note_slug;
  }

  const query = `UPDATE coaching_plans SET ${sets.join(", ")} WHERE id = $id AND member_id = $memberId RETURNING *`;
  const row = getWriteDb().prepare(query).get(params) as Row | null;
  return row ? rowToPlan(row) : null;
}

export function deletePlan(memberId: string, id: number): boolean {
  const result = getWriteDb()
    .prepare("DELETE FROM coaching_plans WHERE id = $id AND member_id = $memberId")
    .run({ $id: id, $memberId: memberId });
  return result.changes > 0;
}
