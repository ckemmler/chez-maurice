/**
 * What a member has put away from their list.
 *
 * Archiving is a view of the list and nothing else: the entry stays in the
 * garden as it is, a published page stays online, and the library keeps its
 * book. So it is not written into the markdown — a book of the household's
 * library that nobody wrote on has no file to write it into, and one member
 * putting a book away must not hide it from the others. One row per member
 * and per shelf id (`<collection>/<locale>/<slug>`, or `calibre/<id>`), in
 * life.db beside the reading progress.
 */

import { Database } from "bun:sqlite";
import { getLifeDbPath } from "../lib/config";

// Bound once, like highlights.ts and articleHighlights.ts, which the shelf
// reads in the same breath: the three must be the same file. (Under `bun test`
// a suite that sets its own data dir removes it when done, and a path resolved
// again at each call would then name a folder that is gone.)
const DB_PATH = getLifeDbPath();

let db: Database;
function getDb(): Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS shelf_archive (
        member_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        archived_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (member_id, entry_id)
      )
    `);
  }
  return db;
}

export function archivedIds(memberId: string): Set<string> {
  const rows = getDb().query(`SELECT entry_id FROM shelf_archive WHERE member_id = ?`).all(memberId) as { entry_id: string }[];
  return new Set(rows.map((r) => r.entry_id));
}

/** Put away, or bring back. Idempotent either way. */
export function setArchived(memberId: string, ids: string[], on: boolean): void {
  const d = getDb();
  const stmt = on
    ? d.query(`INSERT OR IGNORE INTO shelf_archive (member_id, entry_id) VALUES (?, ?)`)
    : d.query(`DELETE FROM shelf_archive WHERE member_id = ? AND entry_id = ?`);
  for (const id of ids) stmt.run(memberId, id);
}
