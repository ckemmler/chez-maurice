/**
 * Places service — personal places stored in akita.db.
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

export interface Place {
  id: number;
  name: string;
  lat: number;
  lon: number;
  radius: number;
  icon: string | null;
  created_at: string;
  updated_at: string;
}

export function initPlacesTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS places (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      radius REAL NOT NULL DEFAULT 100,
      icon TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
}

export function listPlaces(memberId: string): Place[] {
  return getDb()
    .prepare("SELECT * FROM places WHERE (member_id = $memberId OR scope = 'tenant') ORDER BY name")
    .all({ $memberId: memberId }) as Place[];
}

export function getPlace(memberId: string, id: number): Place | null {
  return (getDb()
    .prepare("SELECT * FROM places WHERE id = $id AND (member_id = $memberId OR scope = 'tenant')")
    .get({ $id: id, $memberId: memberId }) as Place) ?? null;
}

export function createPlace(memberId: string, fields: {
  name: string;
  lat: number;
  lon: number;
  radius?: number;
  icon?: string;
}): Place {
  const row = getDb()
    .prepare(
      `INSERT INTO places (member_id, name, lat, lon, radius, icon)
       VALUES ($memberId, $name, $lat, $lon, $radius, $icon)
       RETURNING *`,
    )
    .get({
      $memberId: memberId,
      $name: fields.name,
      $lat: fields.lat,
      $lon: fields.lon,
      $radius: fields.radius ?? 100,
      $icon: fields.icon ?? null,
    }) as Place;
  return row;
}

export function updatePlace(
  memberId: string,
  id: number,
  fields: { name?: string; lat?: number; lon?: number; radius?: number; icon?: string | null },
): Place | null {
  const sets: string[] = ["updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"];
  const params: Record<string, string | number | null> = { $id: id, $memberId: memberId };

  if (fields.name !== undefined) {
    sets.push("name = $name");
    params.$name = fields.name;
  }
  if (fields.lat !== undefined) {
    sets.push("lat = $lat");
    params.$lat = fields.lat;
  }
  if (fields.lon !== undefined) {
    sets.push("lon = $lon");
    params.$lon = fields.lon;
  }
  if (fields.radius !== undefined) {
    sets.push("radius = $radius");
    params.$radius = fields.radius;
  }
  if (fields.icon !== undefined) {
    sets.push("icon = $icon");
    params.$icon = fields.icon;
  }

  const row = getDb()
    .prepare(`UPDATE places SET ${sets.join(", ")} WHERE id = $id AND member_id = $memberId RETURNING *`)
    .get(params) as Place | null;
  return row;
}

export function deletePlace(memberId: string, id: number): boolean {
  const result = getDb().prepare("DELETE FROM places WHERE id = $id AND member_id = $memberId").run({ $id: id, $memberId: memberId });
  return result.changes > 0;
}

/**
 * Find the closest matching personal place within its radius.
 * Uses haversine distance. Returns the place with smallest radius first (most specific).
 */
export function matchPlace(memberId: string, lat: number, lon: number): Place | null {
  const places = listPlaces(memberId);
  const matches: Array<{ place: Place; distance: number }> = [];

  for (const place of places) {
    const dist = haversineMeters(lat, lon, place.lat, place.lon);
    if (dist <= place.radius) {
      matches.push({ place, distance: dist });
    }
  }

  if (matches.length === 0) return null;

  // Return the most specific match (smallest radius)
  matches.sort((a, b) => a.place.radius - b.place.radius);
  return matches[0].place;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // Earth radius in meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
