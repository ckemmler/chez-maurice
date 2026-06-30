/**
 * Health resolvers — SQLite-backed metrics (HRV, sleep).
 */

import { getSleepData, getHRVData } from "./health";

export interface MetricResult {
  type: string;
  [key: string]: unknown;
}

// ── HRV RMSSD ────────────────────────────────────────────────────────

export async function resolveHrvRmssd(
  memberId: string,
  startDate: string,
  endDate: string,
): Promise<MetricResult> {
  const raw = await getHRVData(memberId, startDate, endDate);

  // Group by local date (Europe/Brussels) and compute daily average.
  // Apple Health shows daily average HRV, not max.
  const TZ = "Europe/Brussels";
  const byDate = new Map<string, { sum: number; count: number }>();
  for (const doc of raw) {
    const utc = doc.date instanceof Date ? doc.date : new Date(String(doc.date));
    const localDate = utc.toLocaleDateString("sv-SE", { timeZone: TZ }); // sv-SE gives YYYY-MM-DD
    // Skip readings whose Brussels-local date falls outside the requested range.
    // The UTC-based query boundaries mean readings near midnight can leak
    // into an adjacent local date.
    if (localDate < startDate || localDate > endDate) continue;
    const qty = Number(doc.qty);
    if (!isNaN(qty)) {
      const entry = byDate.get(localDate) ?? { sum: 0, count: 0 };
      entry.sum += qty;
      entry.count += 1;
      byDate.set(localDate, entry);
    }
  }

  const points = Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, { sum, count }]) => ({ date, value: Math.round(sum / count) }));

  return { type: "series", points };
}

// ── Sleep Stages ─────────────────────────────────────────────────────

export async function resolveSleepStages(
  memberId: string,
  startDate: string,
  endDate: string,
): Promise<MetricResult> {
  const empty: MetricResult = {
    type: "sleep_stages",
    core_h: 0, rem_h: 0, deep_h: 0, awake_h: 0, total_h: 0,
  };

  // Health Auto Export stores each night's sleep at 22:00 UTC (= midnight
  // Europe/Brussels in CEST). The document at (D)T22:00Z represents the
  // sleep session ending on the morning of D+1 in Brussels.
  //
  // For "last_night" the caller passes startDate=yesterday, endDate=today.
  // endDate is the dashboard date (the morning we woke up). The target
  // document is at (endDate - 1 day)T22:00Z, i.e. startDate at 22:00Z.
  // We query a tight 24h window around that target to find it.
  const targetDate = startDate; // the evening the sleep started (Brussels)
  const queryStart = new Date(`${targetDate}T20:00:00.000Z`); // a bit before 22:00
  const queryEnd = new Date(`${targetDate}T23:59:59.999Z`);

  const raw = await getSleepData(
    memberId,
    queryStart.toISOString().slice(0, 10),
    queryEnd.toISOString().slice(0, 10),
  );

  // Find the document with actual stage data (core/deep/rem > 0).
  const h = (v: unknown) => Math.round(Number(v) * 100) / 100;
  let doc = null;
  for (const d of raw) {
    if (Number(d.core) > 0 || Number(d.deep) > 0 || Number(d.rem) > 0) {
      doc = d;
      break;
    }
  }

  if (!doc) return empty;

  const core_h = h(doc.core);
  const rem_h = h(doc.rem);
  const deep_h = h(doc.deep);
  const awake_h = h(doc.awake);
  const total_h = doc.in_bed
    ? h(doc.in_bed)
    : Math.round((core_h + rem_h + deep_h + awake_h) * 100) / 100;

  return { type: "sleep_stages", core_h, rem_h, deep_h, awake_h, total_h };
}

// ── Sleep Duration ───────────────────────────────────────────────────

export async function resolveSleepDuration(
  memberId: string,
  startDate: string,
  endDate: string,
): Promise<MetricResult> {
  const stages = await resolveSleepStages(memberId, startDate, endDate);
  return { type: "scalar", value: stages.total_h, unit: "h" };
}
