/**
 * What a garden's repository never takes in (17 October 2026). One list, so
 * that the repository made at a garden's first clone (services/gitHttp.ts)
 * and the night's export (services/gardenExport.ts) cannot disagree.
 *
 *   - the system's litter;
 *   - a vault's own settings and bin, which belong to each device that opens
 *     a clone, not to the garden;
 *   - any database, whole or in WAL pieces: the databases are snapshotted
 *     beside the gardens, never versioned in them.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const GARDEN_IGNORES = [
  ".DS_Store",
  ".obsidian/",
  ".trash/",
  "*.db",
  "*.db-wal",
  "*.db-shm",
  "*.sqlite",
  "*.sqlite3",
];

/** Add to `<root>/.gitignore` whichever of GARDEN_IGNORES it lacks, keeping
 *  every line already there. True if the file changed. */
export function ensureIgnored(root: string): boolean {
  const file = join(root, ".gitignore");
  const had = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = had.split("\n").map((l) => l.trim());
  const missing = GARDEN_IGNORES.filter((l) => !lines.includes(l));
  if (!missing.length) return false;
  writeFileSync(file, (had && !had.endsWith("\n") ? had + "\n" : had) + missing.join("\n") + "\n");
  return true;
}
