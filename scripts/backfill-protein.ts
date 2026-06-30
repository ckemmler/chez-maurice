#!/usr/bin/env bun
/**
 * Backfill protein_g (and calories) for all eating signals that lack them.
 * Uses Claude Sonnet to estimate from the meal description.
 *
 * Usage: bun run scripts/backfill-protein.ts [--dry-run]
 */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";

const DRY_RUN = process.argv.includes("--dry-run");
const DB_PATH = resolve(import.meta.dir, "..", "data", "akita.db");
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-4-5-20250929";
const BATCH_SIZE = 10; // meals per LLM call

if (!API_KEY) {
  console.error("ANTHROPIC_API_KEY not set");
  process.exit(1);
}

interface MealRow {
  id: number;
  details: string;
  timestamp: string;
  metadata_json: string | null;
}

// ── Fetch meals missing protein ──────────────────────────────────────

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode=WAL");

const rows = db.prepare(`
  SELECT id, details, timestamp, metadata_json
  FROM signals
  WHERE category = 'eating'
  ORDER BY timestamp ASC
`).all() as MealRow[];

const needsBackfill = rows.filter((r) => {
  const meta = r.metadata_json ? JSON.parse(r.metadata_json) : {};
  return meta.protein_g == null;
});

console.log(`Total eating signals: ${rows.length}`);
console.log(`Missing protein_g:    ${needsBackfill.length}`);
if (needsBackfill.length === 0) {
  console.log("Nothing to do.");
  process.exit(0);
}
if (DRY_RUN) {
  console.log("\n[DRY RUN] Would backfill these meals:");
  for (const r of needsBackfill) {
    console.log(`  #${r.id} ${r.timestamp.slice(0, 10)} — ${r.details.slice(0, 80)}`);
  }
  process.exit(0);
}

// ── LLM estimation ───────────────────────────────────────────────────

interface Estimate {
  id: number;
  protein_g: number;
  calories: number;
}

async function estimateBatch(meals: MealRow[]): Promise<Estimate[]> {
  const mealList = meals
    .map((m) => `- ID ${m.id}: "${m.details}"`)
    .join("\n");

  const prompt = `Estimate the protein (grams) and calories for each meal below.
Return a JSON array of objects: [{"id": <number>, "protein_g": <integer>, "calories": <integer>}, ...]

Rules:
- Use typical portion sizes if amounts aren't specified.
- A rough estimate is better than none. Be reasonable.
- If a meal is "skipped" or clearly has no food, use 0 for both.
- Return ONLY valid JSON, no markdown fences.

Meals:
${mealList}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${err}`);
  }

  const result = (await response.json()) as {
    content: Array<{ type: string; text?: string }>;
  };

  const raw = result.content?.[0]?.text?.trim() ?? "";
  const jsonStr = raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");

  try {
    return JSON.parse(jsonStr) as Estimate[];
  } catch {
    console.error("Failed to parse LLM response:", jsonStr.slice(0, 200));
    return [];
  }
}

// ── Process in batches ───────────────────────────────────────────────

const updateStmt = db.prepare(`
  UPDATE signals
  SET metadata_json = $metadata_json
  WHERE id = $id
`);

let updated = 0;
let failed = 0;

for (let i = 0; i < needsBackfill.length; i += BATCH_SIZE) {
  const batch = needsBackfill.slice(i, i + BATCH_SIZE);
  const batchNum = Math.floor(i / BATCH_SIZE) + 1;
  const totalBatches = Math.ceil(needsBackfill.length / BATCH_SIZE);
  console.log(`\nBatch ${batchNum}/${totalBatches} (${batch.length} meals)...`);

  try {
    const estimates = await estimateBatch(batch);
    const estimateMap = new Map(estimates.map((e) => [e.id, e]));

    for (const meal of batch) {
      const est = estimateMap.get(meal.id);
      if (!est) {
        console.log(`  ⚠ No estimate for #${meal.id}: ${meal.details.slice(0, 60)}`);
        failed++;
        continue;
      }

      // Merge into existing metadata
      const existing = meal.metadata_json ? JSON.parse(meal.metadata_json) : {};
      existing.protein_g = est.protein_g;
      existing.calories = est.calories;

      updateStmt.run({
        $id: meal.id,
        $metadata_json: JSON.stringify(existing),
      });

      console.log(`  ✓ #${meal.id} → ${est.protein_g}g protein, ${est.calories} kcal — ${meal.details.slice(0, 50)}`);
      updated++;
    }
  } catch (err) {
    console.error(`  ✗ Batch failed:`, err);
    failed += batch.length;
  }

  // Rate limit: small pause between batches
  if (i + BATCH_SIZE < needsBackfill.length) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

console.log(`\nDone. Updated: ${updated}, Failed: ${failed}`);
