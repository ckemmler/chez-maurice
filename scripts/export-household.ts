#!/usr/bin/env bun
/**
 * The whole household as one archive, waiting behind a single-use link.
 *
 *   bun run scripts/export-household.ts [--ttl 6h]
 *
 * What a hosted household's tower runs (docker exec) when the admin asks for
 * the archive from their Chez Maurice account, having given their password
 * again. The archive is written into the household's own volume
 * (<app dir>/household-exports/), the link printed, and the tower mails it to
 * the admin. The server serves it once at /export/<token> and deletes it then,
 * or at expiry (server/src/services/householdExportLinks.ts). Every member is
 * told the household was exported (server/src/services/accountEvents.ts).
 *
 * stdout, last line, one JSON object:
 *   { "ok": true, "url": "https://<domain>/export/<token>", "expires_at": "<ISO>", "bytes": n }
 *   { "ok": false, "error": "…" }            and a non-zero exit
 *
 * The domain is MAURICE_PUBLIC_HOST (the container sets it from
 * MAURICE_DOMAIN). On a household without one — a Mac at home — use the
 * console's /admin/export or scripts/export-household.sh instead.
 *
 * The archive is the admin's profile of the household archive
 * (services/archive.ts, withoutCredentials): no session, API token, PIN hash
 * or provider key, besides the passwords every archive leaves behind.
 *
 * Like scripts/archive.ts it never imports server/src/db.ts: it runs beside
 * the live server, and a second process must not run the migrations. It
 * writes two tables the server created.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { getAppDir, getMauriceDbPath } from "../server/lib/appDir";
import { exportHousehold } from "../server/src/services/archive";
import { recordHouseholdExport } from "../server/src/services/accountEvents";
import { createExportLink, EXPORTS_DIRNAME } from "../server/src/services/householdExportLinks";

function answer(o: Record<string, unknown>, code = 0): never {
  console.log(JSON.stringify(o));
  process.exit(code);
}

/** `6h`, `90m`, `1d` → milliseconds; between 10 minutes and 2 days. */
export function parseTtl(raw: string | undefined): number | null {
  const m = /^(\d+)([mhd])$/.exec((raw ?? "6h").trim());
  if (!m) return null;
  const ms = Number(m[1]) * { m: 60_000, h: 3600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
  return ms >= 600_000 && ms <= 2 * 86_400_000 ? ms : null;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--ttl");
  const ttl = parseTtl(i >= 0 ? args[i + 1] : undefined);
  if (ttl === null) answer({ ok: false, error: "--ttl must be like 6h, 90m or 1d, between 10 minutes and 2 days" }, 2);

  const host = (process.env.MAURICE_PUBLIC_HOST ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!host) answer({ ok: false, error: "MAURICE_PUBLIC_HOST is not set: no public address to serve the archive from" }, 1);

  const dbPath = getMauriceDbPath();
  if (!existsSync(dbPath)) answer({ ok: false, error: `no maurice.db at ${dbPath}` }, 1);

  const dir = join(getAppDir(), EXPORTS_DIRNAME);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  try {
    // forAdmin: no session, token, PIN hash or provider key leaves with it —
    // on a hosted household the provider key is the operator's.
    const { path } = await exportHousehold({ outDir: dir, forAdmin: true });
    const bytes = statSync(path).size;
    const db = new Database(dbPath);
    try {
      db.run("PRAGMA busy_timeout = 10000");
      // The members are told before the link exists.
      recordHouseholdExport(db);
      const { token, expires_at } = createExportLink(db, { path, filename: basename(path), bytes }, ttl);
      answer({ ok: true, url: `https://${host}/export/${token}`, expires_at, bytes });
    } finally {
      db.close();
    }
  } catch (e: any) {
    answer({ ok: false, error: e?.message ?? String(e) }, 1);
  }
}
