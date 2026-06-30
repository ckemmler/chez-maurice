/**
 * Metrics orchestrator — resolves all widget data bindings in one shot.
 */

import type { MetricResult } from "./healthResolvers";
import {
  resolveHrvRmssd,
  resolveSleepStages,
  resolveSleepDuration,
} from "./healthResolvers";
import {
  resolveZone2CardioMin,
  resolveResistanceSession,
  resolveVigorousCardioSession,
  resolveBreathingSessionCount,
  resolveWaistCm,
  resolveControlPause,
  resolveMealSignals,
  resolveProteinG,
  resolveCalories,
} from "./signalResolvers";

// ── Types ────────────────────────────────────────────────────────────

export interface WidgetDataBinding {
  metric: string;
  period: string;
  aggregation?: string;
  field?: string;
  filter?: Record<string, string>;
  label?: string;
  goal_per_day?: number;
}

export interface MetricPayload {
  [key: string]: MetricResult;
}

// ── Cache ────────────────────────────────────────────────────────────

const cache = new Map<string, { payload: MetricPayload; resolvedAt: string }>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ── Period resolution ────────────────────────────────────────────────

function resolvePeriod(
  period: string,
  date: Date,
): { startDate: string; endDate: string } {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const endDate = fmt(date);

  switch (period) {
    case "today":
      return { startDate: endDate, endDate };

    case "last_night": {
      const yesterday = new Date(date);
      yesterday.setDate(yesterday.getDate() - 1);
      return { startDate: fmt(yesterday), endDate };
    }

    case "last_7d": {
      const start = new Date(date);
      start.setDate(start.getDate() - 6);
      return { startDate: fmt(start), endDate };
    }

    case "last_30d": {
      const start = new Date(date);
      start.setDate(start.getDate() - 29);
      return { startDate: fmt(start), endDate };
    }

    case "this_week": {
      // Sunday-based week (Sun–Sat)
      const dayOfWeek = date.getDay(); // 0=Sun..6=Sat
      const sunday = new Date(date);
      sunday.setDate(sunday.getDate() - dayOfWeek);
      return { startDate: fmt(sunday), endDate };
    }

    case "latest": {
      // Wide lookback — 90 days
      const start = new Date(date);
      start.setDate(start.getDate() - 90);
      return { startDate: fmt(start), endDate };
    }

    default: {
      // Fallback: 7 days
      const start = new Date(date);
      start.setDate(start.getDate() - 6);
      return { startDate: fmt(start), endDate };
    }
  }
}

// ── Binding key ──────────────────────────────────────────────────────

function bindingKey(binding: WidgetDataBinding): string {
  const filterVal = binding.filter
    ? Object.values(binding.filter)[0]
    : undefined;
  return filterVal ? `${binding.metric}.${filterVal}` : binding.metric;
}

// ── Resolver dispatch ────────────────────────────────────────────────

const HEALTH_METRICS = new Set(["hrv_rmssd", "sleep_stages", "sleep_duration_h"]);

async function resolveOne(
  memberId: string,
  binding: WidgetDataBinding,
  startDate: string,
  endDate: string,
): Promise<MetricResult> {
  const m = binding.metric;

  // Health (SQLite)
  switch (m) {
    case "hrv_rmssd":
      return resolveHrvRmssd(memberId, startDate, endDate);
    case "sleep_stages":
      return resolveSleepStages(memberId, startDate, endDate);
    case "sleep_duration_h":
      return resolveSleepDuration(memberId, startDate, endDate);
  }

  // Signal (SQLite)
  switch (m) {
    case "zone2_cardio_min":
      return resolveZone2CardioMin(memberId, startDate, endDate);
    case "resistance_session":
      return resolveResistanceSession(memberId, startDate, endDate);
    case "vigorous_cardio_session":
      return resolveVigorousCardioSession(memberId, startDate, endDate);
    case "breathing_session_count":
      return resolveBreathingSessionCount(
        memberId,
        startDate,
        endDate,
        binding.filter?.session_type,
      );
    case "waist_cm":
      return resolveWaistCm(memberId, startDate, endDate);
    case "control_pause_s":
      return resolveControlPause(memberId, startDate, endDate);
    case "meal_signals":
      return resolveMealSignals(memberId, startDate, endDate);
    case "protein_g":
      return resolveProteinG(memberId, startDate, endDate);
    case "calories":
      return resolveCalories(memberId, startDate, endDate);
  }

  // Unknown metric — return null scalar
  return { type: "scalar", value: null, unit: null };
}

// ── Public API ───────────────────────────────────────────────────────

export async function resolveMetrics(
  memberId: string,
  bindings: WidgetDataBinding[],
  date: Date,
  opts?: { layoutId?: string; refresh?: boolean },
): Promise<{ payload: MetricPayload; resolvedAt: string }> {
  const dateStr = date.toISOString().slice(0, 10);
  const cacheKey = opts?.layoutId ? `${memberId}:${opts.layoutId}:${dateStr}` : undefined;

  // Check cache
  if (cacheKey && !opts?.refresh) {
    const cached = cache.get(cacheKey);
    if (cached) {
      const age = Date.now() - new Date(cached.resolvedAt).getTime();
      if (age < CACHE_TTL_MS) return cached;
    }
  }

  // Deduplicate bindings by key
  const seen = new Map<string, WidgetDataBinding>();
  for (const b of bindings) {
    const key = bindingKey(b);
    if (!seen.has(key)) seen.set(key, b);
  }

  // Resolve all in parallel
  const entries = Array.from(seen.entries());
  const results = await Promise.all(
    entries.map(async ([key, binding]) => {
      const { startDate, endDate } = resolvePeriod(binding.period, date);
      const result = await resolveOne(memberId, binding, startDate, endDate);
      return [key, result] as const;
    }),
  );

  const payload: MetricPayload = {};
  for (const [key, result] of results) {
    payload[key] = result;
  }

  const resolvedAt = new Date().toISOString();
  const entry = { payload, resolvedAt };

  // Store in cache
  if (cacheKey) {
    cache.set(cacheKey, entry);
  }

  return entry;
}
