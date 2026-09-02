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
  // The env var is read on every call, never cached: caching it made this
  // function keep answering with whatever the first caller in the process
  // happened to resolve. Under `bun test`, where every file shares one process,
  // that meant a suite setting MAURICE_GARDENS_DIR got someone else's answer
  // and wrote its fixtures into the checkout. Reading an env var is free; the
  // cache below is for the filesystem probe that follows.
  const env = process.env.MAURICE_GARDENS_DIR;
  if (env) return env;
  if (_cached) return _cached;
  // server/src/services -> ../../../web/gardens == <repo>/web/gardens
  const repo = resolve(import.meta.dir, "../../../web/gardens");
  if (existsSync(repo)) return (_cached = repo);
  _cached = join(process.env.HOME || "/tmp", ".maurice", "gardens");
  return _cached;
}
