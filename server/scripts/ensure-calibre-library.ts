/**
 * Create an empty Calibre library where there is none.
 *
 * Calibre-Web does not make libraries — it redirects to `/admin/dbconfig` and
 * waits to be shown one. A household served over the web has no desktop Calibre
 * to make it with, so a fresh install would land on an error screen with no way
 * forward. This runs before Calibre-Web starts and gives it a real, empty
 * library to open.
 *
 * "Real" is the whole point: the schema is Calibre's own file, vendored
 * unmodified (see `server/vendor/calibre/README.md`), so what we create is a
 * library any Calibre in the world can open — not a lookalike.
 *
 *   bun run scripts/ensure-calibre-library.ts [root]
 *
 * Idempotent, and deliberately timid: an existing `metadata.db` is never
 * touched, whatever state it is in. Repairing someone's library is not this
 * script's business.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { getDataDir } from "../data-api/lib/config";

/** Default library for an install that has never been told otherwise. Under the
 *  data dir, because on a shipped install there is no repo and no ~/Calibre
 *  Library — and because it has to survive the container being replaced. */
export function defaultLibraryRoot(): string {
  return process.env.MAURICE_CALIBRE_LIBRARY ?? path.join(getDataDir(), "calibre", "library");
}

const SCHEMA_PATH = path.resolve(import.meta.dir, "../vendor/calibre/metadata_sqlite.sql");

export interface EnsureResult {
  root: string;
  created: boolean;
  reason: string;
}

export function ensureCalibreLibrary(root = defaultLibraryRoot()): EnsureResult {
  const metaPath = path.join(root, "metadata.db");
  if (existsSync(metaPath)) {
    return { root, created: false, reason: "library already present" };
  }

  mkdirSync(root, { recursive: true });

  // Build it beside its target and move it into place, so an interrupted run
  // never leaves a half-written metadata.db that later looks "already present"
  // and is silently trusted.
  const tmpPath = path.join(root, `.metadata.db.new-${process.pid}`);
  try {
    unlinkSync(tmpPath);
  } catch {}

  const schema = readFileSync(SCHEMA_PATH, "utf8");
  const db = new Database(tmpPath, { create: true });
  try {
    db.exec(schema);
    // Calibre identifies a library by a uuid in `library_id`; it generates one
    // on first use, but a library that already has it cannot be mistaken for
    // another when two are merged or synced.
    db.run(`INSERT INTO library_id (uuid) VALUES (?)`, [crypto.randomUUID()]);
  } catch (err) {
    db.close();
    try {
      unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
  db.close();

  renameSync(tmpPath, metaPath);
  return { root, created: true, reason: "created from Calibre's own schema" };
}

if (import.meta.main) {
  const root = process.argv[2] || defaultLibraryRoot();
  const result = ensureCalibreLibrary(root);
  console.log(`[calibre-library] ${result.root}: ${result.reason}`);
}
