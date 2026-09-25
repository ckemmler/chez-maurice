/**
 * The household archive — `maurice-archive`, version 1.
 *
 * Everything a household is, as one file it can take elsewhere: the
 * databases, the gardens with their history, the images, files and avatars.
 * Nothing exported a Maurice before this, and three things waited on it — a
 * demo household becoming a paid one on another machine, handing a hosted
 * household over without the operator opening its data, and the portability
 * the GDPR promises. See docs/household-archive.md for the format.
 *
 * Export snapshots the SQLite databases with VACUUM INTO over a read-only
 * connection (the same reason scripts/backup-db.sh does: a plain copy of a
 * WAL database under a live server can catch a half-written page), writes
 * the manifest beside them in a staging dir, then lets `tar` read the live
 * directories directly — images and uploads are the bulk, and copying them
 * first would double the disk and the wait. The result is one gzipped tar,
 * either written to a file (the CLI) or streamed as it is produced (the
 * routes, where a big household would otherwise sit silent past the server's
 * idle timeout).
 *
 * Import is for a FRESH directory only. It refuses when maurice.db already
 * exists there — the guard that stops it overwriting a real household — and
 * checks every database it extracted. The server's own migrations then take
 * the schema forward on first boot; nothing here knows the schema.
 *
 * This module never imports src/db.ts: the CLI runs beside a live server, and
 * opening the live database from a second process would run its migrations.
 */

import { Database } from "bun:sqlite";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { getAppDir } from "../../lib/appDir";
import { getDataDir } from "../../data-api/lib/config";
import { gardensRoot } from "./gardensRoot";
import { BUILD } from "./buildInfo";

export const ARCHIVE_FORMAT = "maurice-archive";
export const ARCHIVE_VERSION = 1;

export type ArchiveManifest = {
  format: typeof ARCHIVE_FORMAT;
  version: typeof ARCHIVE_VERSION;
  created_at: string;
  household: { id: string; name: string };
  members: { id: string; username: string; display_name: string; role: string }[];
  /** PRAGMA user_version of maurice.db at export time. */
  schema_version: number;
  server_version: string;
  /** The archive's top-level entries, directories with a trailing slash. */
  contents: string[];
};

export type ExportOptions = {
  /** maurice.db, images/, files/, uploads/, avatars/, config.toml, secret.key. */
  appDir?: string;
  /** The data-api databases (life.db, compte.db …). */
  dataDir?: string;
  gardensDir?: string;
  /** Where the staging dir and the tarball go. A temp dir by default. */
  outDir?: string;
};

export class ArchiveError extends Error {}

/** The app-dir entries that travel as they are, when they exist. `secret.key`
 *  opens the mail passwords in maurice.db (services/mailAccounts.ts): without
 *  it a moved household keeps its accounts and loses every password. */
const LIVE_ENTRIES = ["images", "files", "uploads", "avatars", "config.toml", "secret.key"];

/** Patterns tar leaves out of every directory it reads. WAL sidecars belong
 *  to a live database, not to a snapshot; the rest is macOS litter that the
 *  garden engine once read as a note (see scripts/container.sh). */
const TAR_EXCLUDES = ["*.db-wal", "*.db-shm", "._*", ".DS_Store"];

// ── Paths ───────────────────────────────────────────────────────

function resolveDirs(opts: ExportOptions) {
  const appDir = resolve(opts.appDir ?? getAppDir());
  let dataDir = opts.dataDir;
  if (!dataDir) {
    // config.toml names it; without one (a bare MAURICE_DATA_DIR install)
    // the data-api resolves to the app dir itself, and so do we.
    try { dataDir = getDataDir(); } catch { dataDir = appDir; }
  }
  return { appDir, dataDir: resolve(dataDir), gardensDir: resolve(opts.gardensDir ?? gardensRoot()) };
}

/** `<household>-<YYYYMMDD-HHMMSS>.maurice.tar.gz`, local time like backup-db.sh. */
export function archiveFilename(household: string, at = new Date()): string {
  const slug = household.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "maurice";
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `${slug}-${stamp}.maurice.tar.gz`;
}

// ── Databases ───────────────────────────────────────────────────

/** A consistent copy of `src` at `dest`. Read-only on the source: VACUUM INTO
 *  only reads, but a read-write handle may still checkpoint a WAL on close,
 *  and the export's promise is that the live files stay untouched. */
function snapshotDb(src: string, dest: string): void {
  if (statSync(src).size === 0) {
    // An empty placeholder is not a database; VACUUM fails on it. Copy it so
    // the layout still matches.
    copyFileSync(src, dest);
    return;
  }
  let db = new Database(src, { readonly: true });
  try {
    try {
      db.run("VACUUM INTO ?", [dest]);
    } catch (e: any) {
      // A WAL database whose -wal/-shm sidecars are absent — the server is
      // stopped and shut down cleanly — cannot be read by a read-only
      // connection: it may not create the -shm it needs (SQLITE_CANTOPEN).
      // No one is writing then, so a read-write handle is safe; the only
      // trace it leaves is the pair of empty sidecars it removes on close.
      if (e?.code !== "SQLITE_CANTOPEN") throw e;
      db.close();
      db = new Database(src);
      db.run("VACUUM INTO ?", [dest]);
    }
  } finally {
    db.close();
  }
}

/** PRAGMA integrity_check, which must answer exactly `ok`. */
export function checkDb(path: string): void {
  if (statSync(path).size === 0) return;
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query("PRAGMA integrity_check").get() as { integrity_check: string };
    if (row?.integrity_check !== "ok") {
      throw new ArchiveError(`${basename(path)} fails its integrity check: ${row?.integrity_check}`);
    }
  } finally {
    db.close();
  }
}

/** What the manifest says about the household, read from the snapshot rather
 *  than the live database — the snapshot is what the archive carries. */
function describe(mauriceDb: string): Pick<ArchiveManifest, "household" | "members" | "schema_version"> {
  const db = new Database(mauriceDb, { readonly: true });
  try {
    const h = db.query(`SELECT id, name FROM households WHERE id = 'default'`).get() as
      { id: string; name: string } | null;
    const members = db.query(
      `SELECT id, username, display_name, role FROM users ORDER BY created_at, rowid`,
    ).all() as ArchiveManifest["members"];
    const v = db.query("PRAGMA user_version").get() as { user_version: number };
    return {
      household: h ?? { id: "default", name: "Home" },
      members,
      schema_version: v?.user_version ?? 0,
    };
  } finally {
    db.close();
  }
}

// ── tar ─────────────────────────────────────────────────────────

/** macOS ships bsdtar, the image GNU tar. They agree on everything used here
 *  but the rename flag and the meaning of exit code 1. */
let _flavor: "bsd" | "gnu" | null = null;
function tarFlavor(): "bsd" | "gnu" {
  if (_flavor) return _flavor;
  const r = Bun.spawnSync(["tar", "--version"]);
  _flavor = r.stdout.toString().includes("bsdtar") ? "bsd" : "gnu";
  return _flavor;
}

/** Exit 1 from GNU tar means "a file changed as we read it" — a live upload
 *  landing mid-export — and the archive is still whole. bsdtar's 1 is an error. */
function tarFailed(code: number | null, flavor: "bsd" | "gnu"): boolean {
  return code === null || code >= 2 || (code === 1 && flavor === "bsd");
}

type Prepared = {
  staging: string;
  manifest: ArchiveManifest;
  filename: string;
  /** Everything after `tar -c`: excludes, renames, then `-C dir entries…`. */
  tarArgs: string[];
  cleanup: () => void;
};

/** Stage the snapshots and the manifest; work out what tar reads from where. */
function prepare(opts: ExportOptions): Prepared {
  const { appDir, dataDir, gardensDir } = resolveDirs(opts);
  const mauriceDb = join(appDir, "maurice.db");
  if (!existsSync(mauriceDb)) throw new ArchiveError(`no maurice.db in ${appDir}`);

  mkdirSync(opts.outDir ?? tmpdir(), { recursive: true });
  const staging = mkdtempSync(join(opts.outDir ?? tmpdir(), "maurice-archive-"));
  const cleanup = () => { try { rmSync(staging, { recursive: true, force: true }); } catch {} };

  try {
    snapshotDb(mauriceDb, join(staging, "maurice.db"));
    checkDb(join(staging, "maurice.db"));

    // Every database of the data dir, one level deep: life.db, compte.db,
    // recommendations.db, signals.db — whichever exist. When the two roots
    // coincide (MAURICE_DATA_DIR) maurice.db sits among them and is skipped.
    const dataDbs = existsSync(dataDir)
      ? readdirSync(dataDir).filter((f) => f.endsWith(".db") && !(dataDir === appDir && f === "maurice.db")).sort()
      : [];
    if (dataDbs.length) mkdirSync(join(staging, "data"));
    for (const f of dataDbs) {
      snapshotDb(join(dataDir, f), join(staging, "data", f));
      checkDb(join(staging, "data", f));
    }

    const live = LIVE_ENTRIES.filter((e) => existsSync(join(appDir, e)));
    const hasGardens = existsSync(gardensDir) && statSync(gardensDir).isDirectory();

    const contents = [
      "manifest.json", "maurice.db",
      ...(dataDbs.length ? ["data/"] : []),
      ...(hasGardens ? ["gardens/"] : []),
      ...live.map((e) => (statSync(join(appDir, e)).isDirectory() ? `${e}/` : e)),
    ];
    const manifest: ArchiveManifest = {
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      created_at: new Date().toISOString(),
      ...describe(join(staging, "maurice.db")),
      server_version: BUILD.version,
      contents,
    };
    writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

    const flavor = tarFlavor();
    const tarArgs = TAR_EXCLUDES.map((p) => `--exclude=${p}`);
    // The gardens root is `gardens/` in the archive whatever it is called on
    // disk (a source checkout keeps it at web/gardens). Two rules, because a
    // directory entry is `name/` and its files `name/…`, and neither tar
    // offers one anchored pattern that both dialects accept.
    const gname = basename(gardensDir);
    if (hasGardens && gname !== "gardens") {
      const flag = flavor === "bsd" ? "-s" : "--transform";
      tarArgs.push(flag, `|^${gname}/|gardens/|`, flag, `|^${gname}$|gardens|`);
    }
    tarArgs.push("-C", staging, "manifest.json", "maurice.db", ...(dataDbs.length ? ["data"] : []));
    if (live.length) tarArgs.push("-C", appDir, ...live);
    if (hasGardens) tarArgs.push("-C", dirname(gardensDir), gname);

    return { staging, manifest, filename: archiveFilename(manifest.household.name), tarArgs, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

/** The environment tar runs in. COPYFILE_DISABLE stops macOS tar emitting an
 *  AppleDouble `._name` beside every file with extended attributes. */
const TAR_ENV = { ...process.env, COPYFILE_DISABLE: "1" };

// ── Export ──────────────────────────────────────────────────────

/**
 * Write the archive to a file. The caller owns the file afterwards — delete
 * it when done. `outDir` defaults to the system temp dir.
 */
export async function exportHousehold(opts: ExportOptions = {}): Promise<{ path: string; manifest: ArchiveManifest }> {
  const p = prepare(opts);
  const out = join(opts.outDir ?? tmpdir(), p.filename);
  try {
    const proc = Bun.spawn(["tar", "-czf", out, ...p.tarArgs], { env: TAR_ENV, stdout: "ignore", stderr: "pipe" });
    const stderr = new Response(proc.stderr).text();
    const code = await proc.exited;
    const err = (await stderr).trim();
    if (tarFailed(code, tarFlavor())) {
      try { rmSync(out, { force: true }); } catch {}
      throw new ArchiveError(`tar exited ${code}: ${err}`);
    }
    if (err) console.warn(`[archive] tar: ${err}`);
    return { path: out, manifest: p.manifest };
  } finally {
    p.cleanup();
  }
}

/**
 * The archive as a stream, produced as it is read: the routes hand this to
 * the response so the download starts with tar's first block, whatever the
 * size of the uploads. The staging dir goes when tar exits or the client
 * hangs up; `done` settles then, with the exit reason.
 */
export function exportHouseholdStream(opts: ExportOptions = {}): {
  manifest: ArchiveManifest; filename: string; stream: ReadableStream<Uint8Array>; done: Promise<void>;
} {
  const p = prepare(opts);
  const proc = Bun.spawn(["tar", "-czf", "-", ...p.tarArgs], { env: TAR_ENV, stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(proc.stderr).text();
  const flavor = tarFlavor();

  const done = proc.exited.then(async (code) => {
    p.cleanup();
    const err = (await stderr).trim();
    if (tarFailed(code, flavor)) throw new ArchiveError(`tar exited ${code}: ${err}`);
    if (err) console.warn(`[archive] tar: ${err}`);
  });
  done.catch(() => {}); // reported through the stream; never an unhandled rejection

  const upstream = proc.stdout.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const { value, done: eof } = await upstream.read();
      if (!eof) { ctrl.enqueue(value); return; }
      try { await done; ctrl.close(); } catch (e) { ctrl.error(e); }
    },
    cancel() {
      // The client went away: stop reading the household's disk for nothing.
      try { proc.kill(); } catch {}
    },
  });
  return { manifest: p.manifest, filename: p.filename, stream, done };
}

/**
 * The archive as an HTTP download, for the two admin routes. Throws before a
 * byte is sent when the export cannot start (no maurice.db, a database that
 * fails its check); once streaming, a tar failure aborts the download and is
 * logged here, since no status can follow the first chunk.
 */
export function exportResponse(): Response {
  const { stream, filename, done } = exportHouseholdStream();
  done.catch((e) => console.error(`[archive] export failed: ${e?.message ?? e}`));
  return new Response(stream, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

// ── Import ──────────────────────────────────────────────────────

function tarOut(args: string[]): string {
  const r = Bun.spawnSync(["tar", ...args], { env: TAR_ENV });
  if (r.exitCode !== 0) throw new ArchiveError(`tar ${args[0]} failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}

/** The manifest alone, without extracting anything else. */
export function readArchiveManifest(archivePath: string): ArchiveManifest {
  if (!existsSync(archivePath)) throw new ArchiveError(`no such archive: ${archivePath}`);
  let text: string;
  try {
    text = tarOut(["-xzOf", archivePath, "manifest.json"]);
  } catch {
    throw new ArchiveError("not a Maurice archive: no manifest.json in it");
  }
  let m: any;
  try { m = JSON.parse(text); } catch { throw new ArchiveError("manifest.json is not JSON"); }
  if (m?.format !== ARCHIVE_FORMAT) throw new ArchiveError(`not a Maurice archive (format: ${m?.format})`);
  if (m.version !== ARCHIVE_VERSION) {
    throw new ArchiveError(`archive version ${m.version} — this server reads version ${ARCHIVE_VERSION}`);
  }
  return m as ArchiveManifest;
}

/** The archive's top-level entries as tar lists them, for a clean undo. */
function topLevelEntries(archivePath: string): string[] {
  const names = tarOut(["-tzf", archivePath]).split("\n").filter(Boolean);
  return [...new Set(names.map((n) => n.replace(/^\.\//, "").split("/")[0]!))];
}

/**
 * Populate a fresh data dir from an archive. The split layout of every real
 * install comes out: maurice.db at the root, the data-api databases under
 * data/, the gardens under gardens/ — and config.toml's `[paths] data_dir`
 * is repointed there, since the one in the archive names the machine it came
 * from. A server started on `into` (MAURICE_GARDENS_DIR=into/gardens) then
 * migrates the schema forward on first boot.
 */
export async function importHousehold(archivePath: string, opts: { into: string }): Promise<ArchiveManifest> {
  const into = resolve(opts.into);
  if (existsSync(join(into, "maurice.db"))) {
    throw new ArchiveError(`${into} already holds a household (maurice.db exists) — refusing to overwrite it`);
  }
  const manifest = readArchiveManifest(archivePath);
  mkdirSync(into, { recursive: true });

  const entries = topLevelEntries(archivePath);
  const undo = () => {
    for (const e of entries) { try { rmSync(join(into, e), { recursive: true, force: true }); } catch {} }
  };

  try {
    const proc = Bun.spawn(["tar", "-xzf", archivePath, "-C", into], { env: TAR_ENV, stdout: "ignore", stderr: "pipe" });
    const stderr = new Response(proc.stderr).text();
    const code = await proc.exited;
    if (code !== 0) throw new ArchiveError(`tar exited ${code}: ${(await stderr).trim()}`);

    checkDb(join(into, "maurice.db"));
    const dataDir = join(into, "data");
    if (existsSync(dataDir)) {
      for (const f of readdirSync(dataDir).filter((f) => f.endsWith(".db"))) checkDb(join(dataDir, f));
    }

    const config = join(into, "config.toml");
    const dataLine = `data_dir = "${dataDir}"`;
    if (existsSync(config)) {
      const text = readFileSync(config, "utf8");
      const fixed = /^[ \t]*data_dir[ \t]*=/m.test(text)
        ? text.replace(/^([ \t]*)data_dir[ \t]*=.*$/m, `$1${dataLine}`)
        : text + `\n[paths]\n${dataLine}\n`;
      writeFileSync(config, fixed);
    } else {
      writeFileSync(config, `[paths]\n${dataLine}\n`);
    }
    return manifest;
  } catch (e) {
    undo();
    throw e;
  }
}
