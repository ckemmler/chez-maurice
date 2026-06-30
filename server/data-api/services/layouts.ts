/**
 * Layouts service — read-only access to dashboard layout specs stored in akita.db.
 *
 * Layouts are authored by Claude via MCP tools and rendered by Carnet (iOS).
 * This service provides REST-friendly wrappers around the layouts table.
 */

import { Database } from "bun:sqlite";
import { getDbPath } from "../lib/config";

const DB_PATH = getDbPath("akita.db");

let db: Database;
function getDb(): Database {
  if (!db) {
    db = new Database(DB_PATH, { readonly: true });
    db.exec("PRAGMA journal_mode=WAL");
  }
  return db;
}

// ── Types ────────────────────────────────────────────────────────────

export interface LayoutSummary {
  id: string;
  version: number;
  title: string;
  cadence: string;
  active_from: string | null;
  active_until: string | null;
  updated_at: string;
}

export interface Layout extends LayoutSummary {
  spec: Record<string, unknown>;
  created_at: string;
}

type Row = Record<string, unknown>;

function rowToSummary(r: Row): LayoutSummary {
  return {
    id: r.id as string,
    version: r.version as number,
    title: r.title as string,
    cadence: r.cadence as string,
    active_from: (r.active_from as string) ?? null,
    active_until: (r.active_until as string) ?? null,
    updated_at: r.updated_at as string,
  };
}

function rowToLayout(r: Row): Layout {
  return {
    ...rowToSummary(r),
    spec: JSON.parse(r.spec as string),
    created_at: r.created_at as string,
  };
}

// ── Queries ──────────────────────────────────────────────────────────

export function listLayouts(memberId: string, opts?: {
  cadence?: string;
  active_only?: boolean;
}): LayoutSummary[] {
  const conditions: string[] = ["member_id = $memberId"];
  const params: Record<string, string> = { $memberId: memberId };

  if (opts?.cadence) {
    conditions.push("cadence = $cadence");
    params.$cadence = opts.cadence;
  }

  if (opts?.active_only) {
    const today = new Date().toISOString().slice(0, 10);
    conditions.push("(active_until IS NULL OR active_until >= $today)");
    params.$today = today;
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `SELECT id, version, title, cadence, active_from, active_until, updated_at FROM layouts ${where} ORDER BY updated_at DESC`;

  const rows = getDb().prepare(query).all(params) as Row[];
  return rows.map(rowToSummary);
}

export function getLayout(memberId: string, id: string): Layout | null {
  const row = getDb()
    .prepare("SELECT * FROM layouts WHERE id = $id AND member_id = $memberId")
    .get({ $id: id, $memberId: memberId }) as Row | null;
  return row ? rowToLayout(row) : null;
}
