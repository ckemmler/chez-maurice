#!/usr/bin/env bun
/**
 * Phase 0c migration — add member_id + scope columns to all per-member tables.
 *
 * Reads the owner's user ID from maurice.db, then backfills all existing rows
 * in akita.db, compte.db, and recommendations.db with that owner ID.
 *
 * Idempotent: safe to run multiple times (ALTER TABLE ADD COLUMN is a no-op
 * if the column already exists; UPDATE uses WHERE member_id IS NULL).
 *
 * Usage:
 *   bun run scripts/add-member-id.ts
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Resolve data directory (reads config.toml like the server does) ──

function getMauriceHome(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  return resolve(home, ".maurice");
}

function getDataDir(): string {
  if (process.env.MAURICE_DATA_DIR) return process.env.MAURICE_DATA_DIR;

  // Read config.toml for paths.data_dir
  const configPath = resolve(getMauriceHome(), "config.toml");
  if (existsSync(configPath)) {
    const text = readFileSync(configPath, "utf-8");
    const match = text.match(/data_dir\s*=\s*"([^"]+)"/);
    if (match) return match[1];
  }

  // Fallback
  return getMauriceHome();
}

const mauriceHome = getMauriceHome();
const dataDir = getDataDir();
const mauriceDbPath = resolve(mauriceHome, "maurice.db"); // maurice.db lives in ~/.maurice, not data dir
const akitaDbPath = resolve(dataDir, "akita.db");
const compteDbPath = resolve(dataDir, "compte.db");
const recommendationsDbPath = resolve(dataDir, "recommendations.db");

// ── Helper: add column if not exists ─────────────────────────────────

function addColumn(db: Database, table: string, column: string, definition: string): boolean {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
  } catch (e: any) {
    if (e.message?.includes("duplicate column")) return false;
    throw e;
  }
}

function backfill(db: Database, table: string, ownerId: string): number {
  const result = db.prepare(`UPDATE ${table} SET member_id = ? WHERE member_id IS NULL`).run(ownerId);
  return result.changes;
}

function tableExists(db: Database, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return !!row;
}

// ── Main ─────────────────────────────────────────────────────────────

function main() {
  console.log("Phase 0c migration: add member_id + scope to all per-member tables");
  console.log(`Data directory: ${dataDir}`);

  // 1. Read owner ID from maurice.db
  if (!existsSync(mauriceDbPath)) {
    console.error(`ERROR: maurice.db not found at ${mauriceDbPath}`);
    console.error("Run the Maurice server first to create the database and owner account.");
    process.exit(1);
  }

  const mauriceDb = new Database(mauriceDbPath, { readonly: true });
  const owner = mauriceDb.prepare(
    "SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1"
  ).get() as { id: string } | null;

  if (!owner) {
    console.error("ERROR: No admin user found in maurice.db. Create an owner account first.");
    mauriceDb.close();
    process.exit(1);
  }

  const ownerId = owner.id;
  console.log(`Owner member ID: ${ownerId}`);
  mauriceDb.close();

  // 2. Migrate akita.db
  if (existsSync(akitaDbPath)) {
    console.log("\n── akita.db ──");
    const akitaDb = new Database(akitaDbPath);
    akitaDb.exec("PRAGMA journal_mode=WAL");

    const akitaTables = [
      // [table, defaultScope]
      ["signals", "personal"],
      ["coaching_plans", "personal"],
      ["places", "personal"],
      ["tasks", "personal"],
      ["task_log", null], // inherits via task_id FK, but we add member_id for direct queries
      ["bookmarks", "personal"],
      ["reading_progress", "personal"],
      ["health_sleep", "personal"],
      ["health_hrv", "personal"],
      ["health_mindful_minutes", "personal"],
      ["health_workouts", "personal"],
      ["health_hourly_energy", "personal"],
      ["health_respiratory_rate", "personal"],
      ["layouts", "personal"],
      ["dossiers", "personal"],
      ["deep_research_requests", "personal"],
      ["dossier_follow_ups", "personal"],
      ["dossier_recommendations", "personal"],
      ["resonances", "personal"],
      ["briefing_topics", "personal"],
    ] as const;

    for (const [table, defaultScope] of akitaTables) {
      if (!tableExists(akitaDb, table)) {
        console.log(`  ${table}: table not found, skipping`);
        continue;
      }

      const addedMemberId = addColumn(akitaDb, table, "member_id", "TEXT");
      if (defaultScope) {
        addColumn(akitaDb, table, "scope", `TEXT NOT NULL DEFAULT '${defaultScope}'`);
      }

      const count = backfill(akitaDb, table, ownerId);
      console.log(`  ${table}: ${addedMemberId ? "added columns" : "columns exist"}, backfilled ${count} rows`);
    }

    // Create index on member_id for key tables
    const indexTables = ["signals", "tasks", "coaching_plans", "layouts", "dossiers", "bookmarks", "places"];
    for (const table of indexTables) {
      if (tableExists(akitaDb, table)) {
        try {
          akitaDb.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_member_id ON ${table}(member_id)`);
        } catch { /* ignore */ }
      }
    }

    akitaDb.close();
  } else {
    console.log(`\nakita.db not found at ${akitaDbPath}, skipping`);
  }

  // 3. Migrate compte.db
  if (existsSync(compteDbPath)) {
    console.log("\n── compte.db ──");
    const compteDb = new Database(compteDbPath);
    compteDb.exec("PRAGMA journal_mode=WAL");

    if (tableExists(compteDb, "transactions")) {
      const added = addColumn(compteDb, "transactions", "member_id", "TEXT");
      addColumn(compteDb, "transactions", "scope", "TEXT NOT NULL DEFAULT 'personal'");
      const count = backfill(compteDb, "transactions", ownerId);
      console.log(`  transactions: ${added ? "added columns" : "columns exist"}, backfilled ${count} rows`);
      try {
        compteDb.exec("CREATE INDEX IF NOT EXISTS idx_transactions_member_id ON transactions(member_id)");
      } catch { /* ignore */ }
    }

    compteDb.close();
  } else {
    console.log(`\ncompte.db not found at ${compteDbPath}, skipping`);
  }

  // 4. Migrate recommendations.db
  if (existsSync(recommendationsDbPath)) {
    console.log("\n── recommendations.db ──");
    const recsDb = new Database(recommendationsDbPath);
    recsDb.exec("PRAGMA journal_mode=WAL");

    for (const table of ["article_recommendations", "book_recommendations"]) {
      if (tableExists(recsDb, table)) {
        const added = addColumn(recsDb, table, "member_id", "TEXT");
        addColumn(recsDb, table, "scope", "TEXT NOT NULL DEFAULT 'personal'");
        const count = backfill(recsDb, table, ownerId);
        console.log(`  ${table}: ${added ? "added columns" : "columns exist"}, backfilled ${count} rows`);
      }
    }

    recsDb.close();
  } else {
    console.log(`\nrecommendations.db not found at ${recommendationsDbPath}, skipping`);
  }

  console.log("\nMigration complete.");
}

main();
