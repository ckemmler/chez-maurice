/**
 * Signal resolvers — SQLite-backed metrics from the signals table.
 */

import { Database } from "bun:sqlite";
import { getDbPath } from "../lib/config";
import type { MetricResult } from "./healthResolvers";

const DB_PATH = getDbPath("akita.db");

let db: Database;
function getDb(): Database {
  if (!db) {
    db = new Database(DB_PATH, { readonly: true });
    db.exec("PRAGMA journal_mode=WAL");
  }
  return db;
}

// ── Duration parser ──────────────────────────────────────────────────

function parseDurationMin(s: string): number {
  if (!s) return 0;
  const lower = s.toLowerCase().trim();

  // "1h20min", "1h20m", "1h 20min"
  const hm = lower.match(/(\d+)\s*h\s*(\d+)\s*m/);
  if (hm) return parseInt(hm[1]) * 60 + parseInt(hm[2]);

  // "1h"
  const hOnly = lower.match(/^(\d+(?:\.\d+)?)\s*h$/);
  if (hOnly) return Math.round(parseFloat(hOnly[1]) * 60);

  // "45min" or "45m"
  const mOnly = lower.match(/^(\d+(?:\.\d+)?)\s*m(?:in)?$/);
  if (mOnly) return Math.round(parseFloat(mOnly[1]));

  // Plain number — assume minutes
  const n = parseFloat(lower);
  return isNaN(n) ? 0 : Math.round(n);
}

// ── Helper: query signals ────────────────────────────────────────────

interface SignalRow {
  id: number;
  details: string;
  timestamp: string;
  metadata_json: string | null;
}

function querySignals(
  memberId: string,
  category: string,
  startDate: string,
  endDate: string,
  extraWhere?: string,
  extraParams?: Record<string, string>,
): SignalRow[] {
  const params: Record<string, string> = {
    $memberId: memberId,
    $category: category,
    $start: startDate,
    $end: endDate + "T23:59:59",
    ...extraParams,
  };

  const where = [
    "member_id = $memberId",
    "category = $category",
    "timestamp >= $start",
    "timestamp <= $end",
    ...(extraWhere ? [extraWhere] : []),
  ].join(" AND ");

  const sql = `SELECT id, details, timestamp, metadata_json FROM signals WHERE ${where} ORDER BY timestamp ASC`;
  return getDb().prepare(sql).all(params) as SignalRow[];
}

// ── Zone 2 Cardio Minutes ────────────────────────────────────────────

export function resolveZone2CardioMin(
  memberId: string,
  startDate: string,
  endDate: string,
): MetricResult {
  const rows = querySignals(
    memberId,
    "sports",
    startDate,
    endDate,
    "(LOWER(details) LIKE '%zone 2%' OR LOWER(details) LIKE '%zone2%' OR LOWER(json_extract(metadata_json, '$.intensity')) LIKE '%zone 2%')",
  );

  let totalMin = 0;
  for (const row of rows) {
    const meta = row.metadata_json ? JSON.parse(row.metadata_json) : {};
    if (meta.duration) {
      totalMin += parseDurationMin(String(meta.duration));
    } else {
      // Try to extract duration from details text
      const match = row.details.match(/(\d+\s*(?:h\s*\d+\s*)?m(?:in)?|\d+\s*h)/i);
      if (match) totalMin += parseDurationMin(match[0]);
    }
  }

  return { type: "scalar", value: totalMin, unit: "min" };
}

// ── Resistance Sessions ──────────────────────────────────────────────

export function resolveResistanceSession(
  memberId: string,
  startDate: string,
  endDate: string,
): MetricResult {
  const rows = querySignals(
    memberId,
    "sports",
    startDate,
    endDate,
    "(LOWER(details) LIKE '%strength%' OR LOWER(details) LIKE '%resistance%' OR LOWER(details) LIKE '%musculation%' OR LOWER(details) LIKE '%weight%lifting%')",
  );
  return { type: "count", value: rows.length };
}

// ── Vigorous Cardio Sessions ─────────────────────────────────────────

export function resolveVigorousCardioSession(
  memberId: string,
  startDate: string,
  endDate: string,
): MetricResult {
  const rows = querySignals(
    memberId,
    "sports",
    startDate,
    endDate,
    "(LOWER(details) LIKE '%vigorous%' OR LOWER(details) LIKE '%intense%' OR LOWER(details) LIKE '%hiit%' OR LOWER(json_extract(metadata_json, '$.intensity')) LIKE '%vigorous%')",
  );
  return { type: "count", value: rows.length };
}

// ── Breathing Session Count (heatmap) ────────────────────────────────

export function resolveBreathingSessionCount(
  memberId: string,
  startDate: string,
  endDate: string,
  sessionTypeFilter?: string,
): MetricResult {
  let extraWhere: string | undefined;
  const extraParams: Record<string, string> = {};

  if (sessionTypeFilter) {
    extraWhere = "LOWER(details) LIKE $sessionType";
    extraParams.$sessionType = `%${sessionTypeFilter.toLowerCase()}%`;
  }

  const rows = querySignals(memberId, "breathing", startDate, endDate, extraWhere, extraParams);

  // Build daily counts
  const dailyCounts = new Map<string, number>();
  for (const row of rows) {
    const day = row.timestamp.slice(0, 10);
    dailyCounts.set(day, (dailyCounts.get(day) ?? 0) + 1);
  }

  // Build array of { date, count } sorted
  const entries = Array.from(dailyCounts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));

  return { type: "heatmap", entries };
}

// ── Waist Circumference ──────────────────────────────────────────────

export function resolveWaistCm(
  memberId: string,
  startDate: string,
  endDate: string,
): MetricResult {
  const rows = querySignals(
    memberId,
    "measurement",
    startDate,
    endDate,
    "(LOWER(details) LIKE '%waist%' OR json_extract(metadata_json, '$.metric') = 'waist_circumference')",
  );

  if (rows.length === 0) return { type: "scalar", value: null, unit: "cm" };

  // Most recent
  const last = rows[rows.length - 1];
  const meta = last.metadata_json ? JSON.parse(last.metadata_json) : {};
  const value = meta.value ?? meta.waist ?? null;

  return { type: "scalar", value: value !== null ? Number(value) : null, unit: "cm" };
}

// ── Control Pause / BOLT ─────────────────────────────────────────────

export function resolveControlPause(
  memberId: string,
  startDate: string,
  endDate: string,
): MetricResult {
  const rows = querySignals(
    memberId,
    "measurement",
    startDate,
    endDate,
    "(json_extract(metadata_json, '$.metric') IN ('CP', 'BOLT', 'control_pause') OR LOWER(details) LIKE '%control pause%' OR LOWER(details) LIKE '%bolt%score%')",
  );

  if (rows.length === 0) return { type: "scalar", value: null, unit: "s" };

  const last = rows[rows.length - 1];
  const meta = last.metadata_json ? JSON.parse(last.metadata_json) : {};
  const value = meta.value ?? null;

  return { type: "scalar", value: value !== null ? Number(value) : null, unit: "s" };
}

// ── Meal Signals ─────────────────────────────────────────────────────

function inferMealType(timestamp: string): string {
  const hour = new Date(timestamp).getHours();
  if (hour < 10) return "breakfast";
  if (hour < 14) return "lunch";
  if (hour < 17) return "snack";
  return "dinner";
}

export function resolveMealSignals(
  memberId: string,
  startDate: string,
  endDate: string,
): MetricResult {
  const rows = querySignals(memberId, "eating", startDate, endDate);

  const entries = rows.map((row) => {
    const meta = row.metadata_json ? JSON.parse(row.metadata_json) : {};
    return {
      time: row.timestamp,
      meal_type: meta.meal_type ?? inferMealType(row.timestamp),
      description: row.details,
    };
  });

  return { type: "meals", entries };
}

// ── Protein (estimated from meal metadata) ──────────────────────────

export function resolveProteinG(
  memberId: string,
  startDate: string,
  endDate: string,
): MetricResult {
  const rows = querySignals(memberId, "eating", startDate, endDate);

  let total = 0;
  let hasData = false;
  for (const row of rows) {
    const meta = row.metadata_json ? JSON.parse(row.metadata_json) : {};
    if (meta.protein_g != null) {
      total += Number(meta.protein_g);
      hasData = true;
    }
  }

  return { type: "scalar", value: hasData ? total : null, unit: "g" };
}

// ── Calories (estimated from meal metadata) ─────────────────────────

export function resolveCalories(
  memberId: string,
  startDate: string,
  endDate: string,
): MetricResult {
  const rows = querySignals(memberId, "eating", startDate, endDate);

  let total = 0;
  let hasData = false;
  for (const row of rows) {
    const meta = row.metadata_json ? JSON.parse(row.metadata_json) : {};
    if (meta.calories != null) {
      total += Number(meta.calories);
      hasData = true;
    }
  }

  return { type: "scalar", value: hasData ? total : null, unit: "kcal" };
}
