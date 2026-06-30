/**
 * Health service — SQLite-backed health data (replaces MongoDB).
 *
 * Six tables: health_sleep, health_hrv, health_mindful_minutes,
 * health_workouts, health_hourly_energy, health_respiratory_rate.
 */

import { Database } from "bun:sqlite";
import { getDbPath } from "../lib/config";
import type {
  SleepDataPayload,
  MindfulMinutesDataPayload,
  WorkoutsDataPayload,
  HourlyActiveEnergyDataPayload,
  HRVDataPayload,
  RespiratoryRateDataPayload,
} from "../types/health";

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
    initTables(dbWrite);
  }
  return dbWrite;
}

// ── Table creation ────────────────────────────────────────────────────

function initTables(d: Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS health_sleep (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id TEXT NOT NULL,
      date TEXT NOT NULL,
      source TEXT,
      awake REAL,
      rem REAL,
      deep REAL,
      core REAL,
      asleep REAL,
      in_bed REAL,
      UNIQUE(member_id, date, source)
    );
    CREATE INDEX IF NOT EXISTS idx_health_sleep_date ON health_sleep(member_id, date);

    CREATE TABLE IF NOT EXISTS health_hrv (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id TEXT NOT NULL,
      date TEXT NOT NULL,
      qty REAL NOT NULL,
      source TEXT,
      UNIQUE(member_id, date, source)
    );
    CREATE INDEX IF NOT EXISTS idx_health_hrv_date ON health_hrv(member_id, date);

    CREATE TABLE IF NOT EXISTS health_mindful_minutes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id TEXT NOT NULL,
      date TEXT NOT NULL,
      qty REAL NOT NULL,
      source TEXT,
      UNIQUE(member_id, date, source)
    );
    CREATE INDEX IF NOT EXISTS idx_health_mindful_minutes_date ON health_mindful_minutes(member_id, date);

    CREATE TABLE IF NOT EXISTS health_workouts (
      id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      name TEXT,
      start_time TEXT NOT NULL,
      end_time TEXT,
      duration REAL,
      active_energy_qty REAL,
      active_energy_units TEXT,
      metadata_json TEXT,
      PRIMARY KEY (member_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_health_workouts_start ON health_workouts(member_id, start_time);

    CREATE TABLE IF NOT EXISTS health_hourly_energy (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      qty REAL NOT NULL,
      source TEXT,
      UNIQUE(member_id, timestamp, source)
    );
    CREATE INDEX IF NOT EXISTS idx_health_hourly_energy_ts ON health_hourly_energy(member_id, timestamp);

    CREATE TABLE IF NOT EXISTS health_respiratory_rate (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id TEXT NOT NULL,
      date TEXT NOT NULL,
      qty REAL NOT NULL,
      source TEXT,
      UNIQUE(member_id, date, source)
    );
    CREATE INDEX IF NOT EXISTS idx_health_respiratory_rate_date ON health_respiratory_rate(member_id, date);
  `);

  // ── Member-scoped uniqueness migration ──────────────────────────────────
  // Older installs created these tables with a pre-member UNIQUE(date, source)
  // (PRIMARY KEY(id) for workouts). The member_id column was added later via
  // ALTER TABLE, but SQLite can't retrofit a composite UNIQUE constraint in
  // place — so ON CONFLICT(member_id, …) in the upserts below matched no
  // constraint and every write failed. These unique indexes supply the missing
  // conflict target idempotently. Fresh installs already satisfy it via the
  // inline UNIQUE above; this just brings migrated DBs in line.
  d.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_health_sleep_member            ON health_sleep(member_id, date, source);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_health_hrv_member              ON health_hrv(member_id, date, source);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_health_mindful_minutes_member  ON health_mindful_minutes(member_id, date, source);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_health_hourly_energy_member    ON health_hourly_energy(member_id, timestamp, source);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_health_respiratory_rate_member ON health_respiratory_rate(member_id, date, source);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_health_workouts_member         ON health_workouts(member_id, id);
  `);
}

// ── Sleep ─────────────────────────────────────────────────────────────

export async function updateSleepData(memberId: string, data: SleepDataPayload) {
  const metrics = data?.data?.metrics?.[0]?.data;
  if (!metrics || !Array.isArray(metrics)) {
    throw new Error("Invalid data format");
  }

  const d = getWriteDb();
  const stmt = d.prepare(`
    INSERT INTO health_sleep (member_id, date, source, awake, rem, deep, core, asleep, in_bed)
    VALUES ($memberId, $date, $source, $awake, $rem, $deep, $core, $asleep, $in_bed)
    ON CONFLICT(member_id, date, source) DO UPDATE SET
      awake = excluded.awake,
      rem = excluded.rem,
      deep = excluded.deep,
      core = excluded.core,
      asleep = excluded.asleep,
      in_bed = excluded.in_bed
  `);

  const run = d.transaction(() => {
    for (const m of metrics) {
      stmt.run({
        $memberId: memberId,
        $date: new Date(m.date).toISOString(),
        $source: m.source ?? null,
        $awake: m.awake ?? null,
        $rem: m.rem ?? null,
        $deep: m.deep ?? null,
        $core: m.core ?? null,
        $asleep: m.asleep ?? null,
        $in_bed: m.inBed ?? null,
      });
    }
  });
  run();

  return { message: `Upserted ${metrics.length} sleep records.` };
}

export async function getSleepData(memberId: string, startDate: string, endDate: string) {
  const d = getDb();
  const startISO = `${startDate}T00:00:00.000Z`;
  const endISO = `${endDate}T23:59:59.999Z`;

  return d
    .prepare(
      `SELECT * FROM health_sleep WHERE member_id = ? AND date >= ? AND date <= ? ORDER BY date ASC`,
    )
    .all(memberId, startISO, endISO);
}

// ── Mindful Minutes ───────────────────────────────────────────────────

export async function updateMindfulMinutesData(
  memberId: string,
  data: MindfulMinutesDataPayload,
) {
  const metrics = data?.data?.metrics?.[0]?.data;
  if (!metrics || !Array.isArray(metrics)) {
    throw new Error("Invalid data format");
  }

  const d = getWriteDb();
  const stmt = d.prepare(`
    INSERT INTO health_mindful_minutes (member_id, date, qty, source)
    VALUES ($memberId, $date, $qty, $source)
    ON CONFLICT(member_id, date, source) DO UPDATE SET qty = excluded.qty
  `);

  const run = d.transaction(() => {
    for (const m of metrics) {
      stmt.run({
        $memberId: memberId,
        $date: new Date(m.date).toISOString(),
        $qty: m.qty,
        $source: m.source || "mindful_minutes",
      });
    }
  });
  run();

  return { message: `Upserted ${metrics.length} mindful minutes records.` };
}

export async function getMindfulMinutesData(
  memberId: string,
  startDate: string,
  endDate: string,
) {
  const d = getDb();
  const startISO = `${startDate}T00:00:00.000Z`;
  const endISO = `${endDate}T23:59:59.999Z`;

  return d
    .prepare(
      `SELECT * FROM health_mindful_minutes WHERE member_id = ? AND date >= ? AND date <= ? ORDER BY date ASC`,
    )
    .all(memberId, startISO, endISO);
}

// ── Workouts ──────────────────────────────────────────────────────────

export async function updateWorkoutsData(memberId: string, data: WorkoutsDataPayload) {
  const workouts = data?.data?.workouts;
  if (!workouts || !Array.isArray(workouts)) {
    throw new Error("Invalid data format");
  }

  const d = getWriteDb();
  const stmt = d.prepare(`
    INSERT INTO health_workouts (member_id, id, name, start_time, end_time, duration, active_energy_qty, active_energy_units, metadata_json)
    VALUES ($memberId, $id, $name, $start_time, $end_time, $duration, $active_energy_qty, $active_energy_units, $metadata_json)
    ON CONFLICT(member_id, id) DO UPDATE SET
      name = excluded.name,
      start_time = excluded.start_time,
      end_time = excluded.end_time,
      duration = excluded.duration,
      active_energy_qty = excluded.active_energy_qty,
      active_energy_units = excluded.active_energy_units,
      metadata_json = excluded.metadata_json
  `);

  const run = d.transaction(() => {
    for (const w of workouts) {
      // Build a metadata object with all the extra fields MongoDB stored
      const metadata: Record<string, unknown> = {
        ...(w.metadata || {}),
        location: w.location ?? null,
        is_indoor: w.isIndoor ?? null,
        distance_qty: w.distance?.qty ?? null,
        distance_units: w.distance?.units ?? null,
        total_energy_qty: w.totalEnergy?.qty ?? null,
        total_energy_units: w.totalEnergy?.units ?? null,
        intensity_qty: w.intensity?.qty ?? null,
        intensity_units: w.intensity?.units ?? null,
        avg_speed_qty: w.avgSpeed?.qty ?? null,
        avg_speed_units: w.avgSpeed?.units ?? null,
        max_speed_qty: w.maxSpeed?.qty ?? null,
        max_speed_units: w.maxSpeed?.units ?? null,
        elevation_up_qty: w.elevationUp?.qty ?? null,
        elevation_up_units: w.elevationUp?.units ?? null,
        elevation_down_qty: w.elevationDown?.qty ?? null,
        elevation_down_units: w.elevationDown?.units ?? null,
        heart_rate_min: w.heartRate?.min ?? null,
        heart_rate_avg: w.heartRate?.avg ?? null,
        heart_rate_max: w.heartRate?.max ?? null,
        step_cadence_qty: w.stepCadence?.qty ?? null,
        step_cadence_units: w.stepCadence?.units ?? null,
        temperature_qty: w.temperature?.qty ?? null,
        temperature_units: w.temperature?.units ?? null,
        humidity_qty: w.humidity?.qty ?? null,
        humidity_units: w.humidity?.units ?? null,
      };

      stmt.run({
        $memberId: memberId,
        $id: w.id,
        $name: w.name ?? null,
        $start_time: new Date(w.start).toISOString(),
        $end_time: new Date(w.end).toISOString(),
        $duration: w.duration ?? null,
        $active_energy_qty: w.activeEnergyBurned?.qty ?? null,
        $active_energy_units: w.activeEnergyBurned?.units ?? null,
        $metadata_json: JSON.stringify(metadata),
      });
    }
  });
  run();

  return { message: `Upserted ${workouts.length} workout records.` };
}

export async function getWorkoutsData(memberId: string, startDate: string, endDate: string) {
  const d = getDb();
  const startISO = `${startDate}T00:00:00.000Z`;
  const endISO = `${endDate}T23:59:59.999Z`;

  const rows = d
    .prepare(
      `SELECT * FROM health_workouts WHERE member_id = ? AND start_time >= ? AND start_time <= ? ORDER BY start_time ASC`,
    )
    .all(memberId, startISO, endISO) as Record<string, unknown>[];

  // Parse metadata_json back into fields the routes/resolvers expect
  return rows.map((row) => {
    const meta = row.metadata_json
      ? JSON.parse(row.metadata_json as string)
      : {};
    return {
      ...row,
      // Flatten the key MongoDB-era fields back onto the object so existing
      // consumers (schemas.py format_workout_record, healthResolvers.ts) work.
      location: meta.location ?? null,
      is_indoor: meta.is_indoor ?? null,
      distance_qty: meta.distance_qty ?? null,
      distance_units: meta.distance_units ?? null,
      active_energy_burned_qty: row.active_energy_qty,
      active_energy_burned_units: row.active_energy_units,
      total_energy_qty: meta.total_energy_qty ?? null,
      total_energy_units: meta.total_energy_units ?? null,
      intensity_qty: meta.intensity_qty ?? null,
      intensity_units: meta.intensity_units ?? null,
      avg_speed_qty: meta.avg_speed_qty ?? null,
      avg_speed_units: meta.avg_speed_units ?? null,
      max_speed_qty: meta.max_speed_qty ?? null,
      max_speed_units: meta.max_speed_units ?? null,
      elevation_up_qty: meta.elevation_up_qty ?? null,
      elevation_up_units: meta.elevation_up_units ?? null,
      elevation_down_qty: meta.elevation_down_qty ?? null,
      elevation_down_units: meta.elevation_down_units ?? null,
      heart_rate_min: meta.heart_rate_min ?? null,
      heart_rate_avg: meta.heart_rate_avg ?? null,
      heart_rate_max: meta.heart_rate_max ?? null,
      step_cadence_qty: meta.step_cadence_qty ?? null,
      step_cadence_units: meta.step_cadence_units ?? null,
      temperature_qty: meta.temperature_qty ?? null,
      temperature_units: meta.temperature_units ?? null,
      humidity_qty: meta.humidity_qty ?? null,
      humidity_units: meta.humidity_units ?? null,
    };
  });
}

// ── Hourly Active Energy ──────────────────────────────────────────────

export async function updateHourlyActiveEnergyData(
  memberId: string,
  data: HourlyActiveEnergyDataPayload,
) {
  const metrics = data?.data?.metrics?.[0]?.data;
  if (!metrics || !Array.isArray(metrics)) {
    console.error("Invalid data received:", JSON.stringify(data, null, 2));
    throw new Error(
      "Invalid data format: Expected data.metrics[0].data to be an array",
    );
  }

  if (metrics.length === 0) {
    return { message: "No data to update." };
  }

  const d = getWriteDb();
  const stmt = d.prepare(`
    INSERT INTO health_hourly_energy (member_id, timestamp, qty, source)
    VALUES ($memberId, $timestamp, $qty, $source)
    ON CONFLICT(member_id, timestamp, source) DO UPDATE SET qty = excluded.qty
  `);

  const valid = metrics.filter(
    (m) => m && m.date && m.qty !== undefined,
  );

  if (valid.length === 0) {
    return { message: "No valid data to update." };
  }

  const run = d.transaction(() => {
    for (const m of valid) {
      stmt.run({
        $memberId: memberId,
        $timestamp: new Date(m.date).toISOString(),
        $qty: m.qty,
        $source: m.source || "default",
      });
    }
  });
  run();

  return { message: `Upserted ${valid.length} hourly energy records.` };
}

export async function getHourlyActiveEnergyData(
  memberId: string,
  startDate: string,
  endDate: string,
) {
  const d = getDb();
  const startISO = `${startDate}T00:00:00.000Z`;
  const endISO = `${endDate}T23:59:59.999Z`;

  return d
    .prepare(
      `SELECT * FROM health_hourly_energy WHERE member_id = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC`,
    )
    .all(memberId, startISO, endISO);
}

// ── HRV ───────────────────────────────────────────────────────────────

export async function updateHRVData(memberId: string, data: HRVDataPayload) {
  const metrics = data?.data?.metrics?.[0]?.data;
  if (!metrics || !Array.isArray(metrics)) {
    throw new Error("Invalid data format");
  }

  const valid = metrics.filter(
    (m) => m && m.date && m.qty !== undefined,
  );

  if (valid.length === 0) {
    return { message: "No valid data to update." };
  }

  const d = getWriteDb();
  const stmt = d.prepare(`
    INSERT INTO health_hrv (member_id, date, qty, source)
    VALUES ($memberId, $date, $qty, $source)
    ON CONFLICT(member_id, date, source) DO UPDATE SET qty = excluded.qty
  `);

  const run = d.transaction(() => {
    for (const m of valid) {
      stmt.run({
        $memberId: memberId,
        $date: new Date(m.date).toISOString(),
        $qty: m.qty,
        $source: m.source || "default",
      });
    }
  });
  run();

  return { message: `Upserted ${valid.length} HRV records.` };
}

export async function getHRVData(memberId: string, startDate: string, endDate: string) {
  const d = getDb();
  const startISO = `${startDate}T00:00:00.000Z`;
  const endISO = `${endDate}T23:59:59.999Z`;

  return d
    .prepare(
      `SELECT * FROM health_hrv WHERE member_id = ? AND date >= ? AND date <= ? ORDER BY date ASC`,
    )
    .all(memberId, startISO, endISO);
}

// ── Respiratory Rate ──────────────────────────────────────────────────

export async function updateRespiratoryRateData(
  memberId: string,
  data: RespiratoryRateDataPayload,
) {
  const metrics = data?.data?.metrics?.[0]?.data;
  if (!metrics || !Array.isArray(metrics)) {
    throw new Error("Invalid data format");
  }

  const valid = metrics.filter(
    (m) => m && m.date && m.qty !== undefined,
  );

  if (valid.length === 0) {
    return { message: "No valid data to update." };
  }

  const d = getWriteDb();
  const stmt = d.prepare(`
    INSERT INTO health_respiratory_rate (member_id, date, qty, source)
    VALUES ($memberId, $date, $qty, $source)
    ON CONFLICT(member_id, date, source) DO UPDATE SET qty = excluded.qty
  `);

  const run = d.transaction(() => {
    for (const m of valid) {
      stmt.run({
        $memberId: memberId,
        $date: new Date(m.date).toISOString(),
        $qty: m.qty,
        $source: m.source || "default",
      });
    }
  });
  run();

  return { message: `Upserted ${valid.length} respiratory rate records.` };
}

export async function getRespiratoryRateData(
  memberId: string,
  startDate: string,
  endDate: string,
) {
  const d = getDb();
  const startISO = `${startDate}T00:00:00.000Z`;
  const endISO = `${endDate}T23:59:59.999Z`;

  return d
    .prepare(
      `SELECT * FROM health_respiratory_rate WHERE member_id = ? AND date >= ? AND date <= ? ORDER BY date ASC`,
    )
    .all(memberId, startISO, endISO);
}
