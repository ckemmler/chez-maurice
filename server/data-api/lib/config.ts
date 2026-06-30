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
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

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
  if (process.env.MAURICE_DATA_DIR) return process.env.MAURICE_DATA_DIR;
  const cfg = loadConfig();
  if (cfg.paths?.data_dir) return cfg.paths.data_dir;
  throw new Error(
    "Maurice data_dir not configured. Set MAURICE_DATA_DIR or create ~/.maurice/config.toml with [paths] data_dir."
  );
}

export function getDbPath(name: string): string {
  return resolve(getDataDir(), name);
}

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
