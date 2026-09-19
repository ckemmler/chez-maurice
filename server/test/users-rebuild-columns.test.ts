// The guest-role rebuild of `users` (db.ts) recreates the table from two
// column lists. A column added by a guarded ALTER but left out of those lists
// is silently dropped for any database old enough to be rebuilt — which is
// how everyday_model and experimental_tools were lost until 19 September 2026.
// This boots the schema over a hand-made pre-guest database and checks that
// every later column survives with its value.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("users rebuild", () => {
  test("carries every later column across the guest-role rebuild", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maurice-rebuild-"));
    const path = join(dir, "maurice.db");
    const old = new Database(path);
    old.run(`CREATE TABLE households (id TEXT PRIMARY KEY, name TEXT, api_key TEXT, default_model TEXT, max_tokens INTEGER, color TEXT, icon TEXT, created_at TEXT)`);
    old.run(`INSERT INTO households (id, name) VALUES ('default', 'h')`);
    old.run(`CREATE TABLE users (
      id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL DEFAULT 'default' REFERENCES households(id),
      username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'standard' CHECK (role IN ('admin', 'standard')),
      password_hash TEXT, pin_hash TEXT, avatar_color TEXT NOT NULL DEFAULT '#2c5aa0',
      profile_text TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_active_at TEXT)`);
    // The ALTERs run before the rebuild, so on a real boot these columns exist
    // — with values — by the time the table is recreated.
    old.run(`ALTER TABLE users ADD COLUMN everyday_model TEXT`);
    old.run(`ALTER TABLE users ADD COLUMN experimental_tools INTEGER NOT NULL DEFAULT 0`);
    old.run(`ALTER TABLE users ADD COLUMN spend_cap_daily_usd REAL`);
    old.run(`INSERT INTO users (id, username, display_name, everyday_model, experimental_tools, spend_cap_daily_usd)
             VALUES ('u1', 'alice', 'Alice', 'mistral-small', 1, 2.5)`);
    old.close();

    const prev = process.env.MAURICE_DATA_DIR;
    process.env.MAURICE_DATA_DIR = dir;
    try {
      await import(`../src/db?rebuild=${Date.now()}`);
    } finally {
      if (prev === undefined) delete process.env.MAURICE_DATA_DIR; else process.env.MAURICE_DATA_DIR = prev;
    }

    const db = new Database(path, { readonly: true });
    const sql = (db.query(`SELECT sql FROM sqlite_master WHERE name = 'users'`).get() as { sql: string }).sql;
    expect(sql).toContain("'guest'");
    const row = db.query(`SELECT everyday_model, experimental_tools, spend_cap_daily_usd FROM users WHERE id = 'u1'`).get() as any;
    expect(row).toEqual({ everyday_model: "mistral-small", experimental_tools: 1, spend_cap_daily_usd: 2.5 });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
