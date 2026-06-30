import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Root of all member gardens — the directory holding <member>/notes/<locale>/…
 *
 * Resolution mirrors db.ts's data-dir convention (env-first, no TOML):
 *   1. MAURICE_GARDENS_DIR env
 *   2. the source repo's web/gardens, if present (dev / source checkout)
 *   3. ~/.maurice/gardens (production default; provisioned by the installer)
 *
 * In production the install tree ships no web/ dir, so set MAURICE_GARDENS_DIR
 * (the launchd plist does) to point at the writable data dir.
 */
let _cached: string | null = null;

export function gardensRoot(): string {
  if (_cached) return _cached;
  const env = process.env.MAURICE_GARDENS_DIR;
  if (env) return (_cached = env);
  // server/src/services -> ../../../web/gardens == <repo>/web/gardens
  const repo = resolve(import.meta.dir, "../../../web/gardens");
  if (existsSync(repo)) return (_cached = repo);
  _cached = join(process.env.HOME || "/tmp", ".maurice", "gardens");
  return _cached;
}
