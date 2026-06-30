#!/usr/bin/env bun
/**
 * One-time migration: extract coaching plans from garden notes into the
 * coaching_plans SQLite table.
 *
 * Usage: bun scripts/migrate-coaching-plans.ts [--dry-run]
 */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { promises as fs } from "node:fs";
import yaml from "js-yaml";

const repoRoot = resolve(import.meta.dir, "..");
const DB_PATH = resolve(repoRoot, "data", "akita.db");
const CONTENT_ROOT = resolve(repoRoot, "akita-web", "src", "content", "notes");
const DRY_RUN = process.argv.includes("--dry-run");

// ── Frontmatter parser ───────────────────────────────────────────────

function parseFrontmatter(content: string): { meta: Record<string, any>; body: string } | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const raw = match[1];
  const body = content.slice(match[0].length).trim();

  try {
    const meta = yaml.load(raw) as Record<string, any>;
    return { meta: meta ?? {}, body };
  } catch {
    return null;
  }
}

// ── Scan for plans ───────────────────────────────────────────────────

async function findPlanFiles(): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith(".md")) {
        results.push(full);
      }
    }
  }

  await walk(CONTENT_ROOT);
  return results;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log(DRY_RUN ? "🔍 DRY RUN — no changes will be made\n" : "");

  const files = await findPlanFiles();
  console.log(`Scanning ${files.length} note files...\n`);

  const plans: Array<{
    title: string;
    description: string | null;
    icon: string | null;
    category: string | null;
    tags: string[];
    active_from: string | null;
    active_until: string | null;
    archived: boolean;
    metrics: any[];
    note_slug: string;
  }> = [];

  for (const file of files) {
    const content = await fs.readFile(file, "utf8");
    const parsed = parseFrontmatter(content);
    if (!parsed) continue;

    const { meta } = parsed;
    if (!Array.isArray(meta.coaching_metrics) || meta.coaching_metrics.length === 0) continue;

    const tags = Array.isArray(meta.tags) ? meta.tags : [];
    if (!tags.includes("coaching")) continue;

    // Derive slug from filename
    const slug = file
      .replace(CONTENT_ROOT + "/", "")
      .replace(/\.md$/, "");

    const flags = Array.isArray(meta.flags) ? meta.flags : [];
    const archived = flags.includes("archived") || tags.includes("archived");

    // Normalize date fields — js-yaml may parse bare dates as Date objects
    const activeFrom = meta.active_from
      ? meta.active_from instanceof Date
        ? meta.active_from.toISOString().slice(0, 10)
        : String(meta.active_from)
      : null;
    const activeUntil = meta.active_until
      ? meta.active_until instanceof Date
        ? meta.active_until.toISOString().slice(0, 10)
        : String(meta.active_until)
      : null;

    plans.push({
      title: meta.title ?? slug,
      description: meta.description ?? null,
      icon: meta.icon ?? null,
      category: meta.category ?? null,
      tags,
      active_from: activeFrom,
      active_until: activeUntil,
      archived,
      metrics: meta.coaching_metrics,
      note_slug: slug,
    });
  }

  console.log(`Found ${plans.length} coaching plan(s):\n`);
  for (const p of plans) {
    const status = p.archived ? " (archived)" : p.active_from ? ` (active from ${p.active_from})` : " (active)";
    console.log(`  • ${p.title}${status}`);
    console.log(`    slug: ${p.note_slug}`);
    console.log(`    category: ${p.category ?? "—"}`);
    console.log(`    metrics: ${p.metrics.length}`);
    for (const m of p.metrics) {
      const target = m.frequency ?? (m.enumerate ? "enumerate" : m.max_per_day ? `max ${m.max_per_day}/day` : "?");
      console.log(`      - ${m.pillar} [${m.signal_category}] → ${target}`);
    }
    console.log();
  }

  if (DRY_RUN) {
    console.log("Dry run complete. Run without --dry-run to insert into database.");
    return;
  }

  // Insert into database
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS coaching_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      category TEXT,
      tags_json TEXT,
      active_from TEXT,
      active_until TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      metrics_json TEXT NOT NULL,
      note_slug TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Check for existing plans to avoid duplicates
  const existing = db
    .prepare("SELECT note_slug FROM coaching_plans WHERE note_slug IS NOT NULL")
    .all() as Array<{ note_slug: string }>;
  const existingSlugs = new Set(existing.map((r) => r.note_slug));

  const insert = db.prepare(`
    INSERT INTO coaching_plans
      (title, description, icon, category, tags_json, active_from, active_until, archived, metrics_json, note_slug)
    VALUES
      ($title, $description, $icon, $category, $tags_json, $active_from, $active_until, $archived, $metrics_json, $note_slug)
  `);

  let inserted = 0;
  let skipped = 0;

  for (const p of plans) {
    if (existingSlugs.has(p.note_slug)) {
      console.log(`  ⊘ Skipping ${p.title} (already exists)`);
      skipped++;
      continue;
    }

    insert.run({
      $title: p.title,
      $description: p.description,
      $icon: p.icon,
      $category: p.category,
      $tags_json: JSON.stringify(p.tags),
      $active_from: p.active_from,
      $active_until: p.active_until,
      $archived: p.archived ? 1 : 0,
      $metrics_json: JSON.stringify(p.metrics),
      $note_slug: p.note_slug,
    });
    console.log(`  ✓ Inserted ${p.title}`);
    inserted++;
  }

  db.close();
  console.log(`\nDone. ${inserted} inserted, ${skipped} skipped.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
