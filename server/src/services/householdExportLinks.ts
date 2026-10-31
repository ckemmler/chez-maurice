/**
 * A whole-household archive, waiting to be fetched once.
 *
 * On a hosted household the admin asks for the archive from their Chez
 * Maurice account, after giving their password again; the tower runs
 * scripts/export-household.ts in the container, which writes the archive into
 * the household's own volume and a row here, and mails the admin the link it
 * prints. The archive never passes through the tower. It used to be one
 * GET /api/admin/export away from any admin session in the app; that route is
 * gone (27 October 2026).
 *
 * The token is 32 random bytes, kept only as its SHA-256. The download is
 * single use: the row is taken (deleted) when the request arrives, the file
 * when the response has been sent. An archive nobody fetched is swept at
 * expiry — hourly, and when the server starts. One archive waits at a time:
 * a new export replaces the one before.
 *
 * Every function takes the database handle, for the same reason as
 * services/accountEvents.ts.
 */

import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const EXPORTS_DIRNAME = "household-exports";

export type WaitingExport = { path: string; filename: string; bytes: number; expires_at: string };

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

function dropFile(path: string): void {
  try { rmSync(path, { force: true }); } catch {}
}

/** Record an archive and hand back its token. Earlier waiting archives go. */
export function createExportLink(
  db: Database,
  file: { path: string; filename: string; bytes: number },
  ttlMs: number,
): { token: string; expires_at: string } {
  const token = randomBytes(32).toString("base64url");
  const expires_at = new Date(Date.now() + ttlMs).toISOString();
  const before = db.query(`SELECT path FROM household_exports`).all() as { path: string }[];
  db.transaction(() => {
    db.run(`DELETE FROM household_exports`);
    db.run(
      `INSERT INTO household_exports (token_hash, path, filename, bytes, expires_at) VALUES (?, ?, ?, ?, ?)`,
      [hash(token), file.path, file.filename, file.bytes, expires_at],
    );
  })();
  for (const b of before) if (b.path !== file.path) dropFile(b.path);
  return { token, expires_at };
}

/** The archive a token opens, taken out of the table: a second request with
 *  the same token finds nothing. Null for an unknown or expired token. */
/** Is the link still good? Read only: a mail scanner opening it must not use it up. */
export function peekExport(db: Database, token: string): WaitingExport | null {
  if (!token || token.length > 128) return null;
  const row = db.query(`SELECT path, filename, bytes, expires_at FROM household_exports WHERE token_hash = ?`)
    .get(hash(token)) as WaitingExport | null;
  if (!row || new Date(row.expires_at).getTime() < Date.now() || !existsSync(row.path)) return null;
  return row;
}

export function takeExport(db: Database, token: string): WaitingExport | null {
  if (!token || token.length > 128) return null;
  const h = hash(token);
  const row = db.query(`SELECT path, filename, bytes, expires_at FROM household_exports WHERE token_hash = ?`)
    .get(h) as WaitingExport | null;
  if (!row) return null;
  db.run(`DELETE FROM household_exports WHERE token_hash = ?`, [h]);
  if (new Date(row.expires_at).getTime() < Date.now() || !existsSync(row.path)) {
    dropFile(row.path);
    return null;
  }
  return row;
}

/** Expired rows and their files; then any file in the exports dir that no row
 *  names and nothing touched for ORPHAN_AGE_MS — an export interrupted
 *  half-way. The age spares an export still being written (its staging dir
 *  and tarball live here until the row is made). */
const ORPHAN_AGE_MS = 3 * 3600_000;

export function sweepExports(db: Database, dir: string): number {
  const now = new Date().toISOString();
  const gone = db.query(`SELECT path FROM household_exports WHERE expires_at < ?`).all(now) as { path: string }[];
  db.run(`DELETE FROM household_exports WHERE expires_at < ?`, [now]);
  for (const g of gone) dropFile(g.path);
  if (!existsSync(dir)) return gone.length;
  const kept = new Set((db.query(`SELECT path FROM household_exports`).all() as { path: string }[]).map((r) => r.path));
  let n = gone.length;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (kept.has(p)) continue;
    try {
      if (Date.now() - statSync(p).mtimeMs < ORPHAN_AGE_MS) continue;
      rmSync(p, { recursive: true, force: true });
      n++;
    } catch {}
  }
  return n;
}
