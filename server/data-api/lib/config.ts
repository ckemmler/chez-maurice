/**
 * Centralized config loader for Maurice services.
 *
 * Resolution order:
 *   1. Environment variables (MAURICE_DATA_DIR, MAURICE_PORT_*, MAURICE_TIMEZONE)
 *   2. ~/.maurice/config.toml
 *
 * No repo-relative fallback — always requires config.toml or env vars.
 */

import { resolve } from "node:path";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { assertTestSandbox } from "../../lib/appDir";

// ── TOML parser (flat key/value sections only) ─────────────────────────

interface TomlConfig {
  [section: string]: Record<string, string>;
}

function parseToml(text: string): TomlConfig {
  const result: TomlConfig = {};
  let current = "_root";
  result[current] = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      current = sectionMatch[1].trim();
      result[current] ??= {};
      continue;
    }
    const kvMatch = line.match(/^([^=]+)=\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      let val = kvMatch[2].trim();
      // Strip quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      result[current][key] = val;
    }
  }
  return result;
}

// ── Config loading ──────────────────────────────────────────────────────

let _config: TomlConfig | null = null;

function loadConfig(): TomlConfig {
  if (_config) return _config;
  const configPath =
    process.env.MAURICE_CONFIG ||
    resolve(homedir(), ".maurice", "config.toml");
  if (existsSync(configPath)) {
    _config = parseToml(readFileSync(configPath, "utf-8"));
  } else {
    _config = {};
  }
  return _config;
}

// ── Public API ──────────────────────────────────────────────────────────

export function getDataDir(): string {
  if (process.env.MAURICE_DATA_DIR) {
    assertTestSandbox(process.env.MAURICE_DATA_DIR, "the data directory (life.db)");
    return process.env.MAURICE_DATA_DIR;
  }
  const cfg = loadConfig();
  if (cfg.paths?.data_dir) {
    // config.toml's data_dir is the household's own: under bun test it is
    // never the right answer (lib/appDir.ts, assertTestSandbox).
    assertTestSandbox(cfg.paths.data_dir, "the data directory (life.db)");
    return cfg.paths.data_dir;
  }
  throw new Error(
    "Maurice data_dir not configured. Set MAURICE_DATA_DIR or create ~/.maurice/config.toml with [paths] data_dir."
  );
}

export function getDbPath(name: string): string {
  return resolve(getDataDir(), name);
}

/**
 * life.db — the data-api's database: health, tasks, signals, dossiers, places,
 * coaching, layouts, reading progress, highlights, bookmarks, résonances.
 *
 * It was `akita.db` until 2026-09-13, the name of the prototype the whole layer
 * was lifted from. Every service opens it through this one function, which on
 * first use renames an old-named file (and its -wal/-shm) to the new name —
 * nothing else has it open at that point, since the server is what opens it.
 * Python readers (tools/shared/config_loader.get_life_db_path) look for the
 * new name first and fall back to the old, so they follow whichever the server
 * has done, and never rename anything themselves.
 */
let lifeDbReady = false;
export function getLifeDbPath(): string {
  const life = getDbPath("life.db");
  if (!lifeDbReady) {
    lifeDbReady = true;
    const old = getDbPath("akita.db");
    if (!existsSync(life) && existsSync(old)) {
      for (const suffix of ["", "-wal", "-shm"]) {
        if (existsSync(old + suffix)) renameSync(old + suffix, life + suffix);
      }
      console.log("[data-api] akita.db renamed to life.db");
    }
  }
  return life;
}

/**
 * Path to maurice.db, which is NOT a data_dir database — do not reach for
 * getDbPath("maurice.db"), which resolves under [paths] data_dir and points at a
 * file that never exists. See lib/appDir.ts for the rule and why the two differ.
 */
export { getMauriceDbPath } from "../../lib/appDir";

export function getPort(service: string): number {
  const envKey = `MAURICE_PORT_${service.toUpperCase().replace(/-/g, "_")}`;
  if (process.env[envKey]) return parseInt(process.env[envKey]!, 10);
  const cfg = loadConfig();
  if (cfg.ports?.[service]) return parseInt(cfg.ports[service], 10);
  // Defaults
  const defaults: Record<string, number> = {
    api: 3001,
    "mcp-gateway": 8710,
    qdrant: 6333,
    web: 4321,
    // Calibre-Web's own default, kept: one less thing that differs between a
    // Maurice install and every guide written about it.
    "calibre-web": 8083,
  };
  return defaults[service] ?? 3000;
}

export function getTimezone(): string {
  if (process.env.MAURICE_TIMEZONE) return process.env.MAURICE_TIMEZONE;
  if (process.env.AKITA_TIMEZONE) return process.env.AKITA_TIMEZONE;
  const cfg = loadConfig();
  if (cfg.general?.timezone) return cfg.general.timezone;
  return "Europe/Paris";
}
