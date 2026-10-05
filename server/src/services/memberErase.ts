/**
 * Erasing a member — the GDPR's right to erasure (art. 17), 3 October 2026.
 *
 * Until now "delete a member" was one statement, `DELETE FROM users`, and the
 * cascades of maurice.db were all that followed. Everything else a member is
 * stayed: their files and images on disk, their garden and its history, their
 * mail store, their part of the semantic index, their rows of life.db, their
 * name in the ledger, and every copy of all that in the night's snapshots.
 *
 * Two gestures, the same walk:
 *
 *   - `data`    — everything the member put in or Maurice derived from it
 *                 goes; the account stays (name, sign-in, devices, settings,
 *                 what the admin granted), empty, ready to be used again;
 *   - `account` — the same, then the account itself.
 *
 * What the walk covers, in order — the corpus first, while the gateway can
 * still be asked as the member:
 *
 *   1. the semantic index (the corpus tool's `forget_member`);
 *   2. maurice.db — `purgeMauriceDb`;
 *   3. the data-api databases (life.db, compte.db …) — `purgeDataDb`, every
 *      table that carries a `member_id`;
 *   4. the disk: library files, conversation images no one else's message
 *      still shows, the uploaded chat exports, the mail store, the garden
 *      with its history and its local bare remote, the avatar;
 *   5. the night's local snapshots (backups/db), rewritten without the member;
 *   6. the logs, lines that name the member.
 *
 * What is not theirs alone is not destroyed with them. A room they opened
 * and others still sit in is handed to the longest-standing of those; only
 * the member's own messages leave it. A domain they created that other
 * members were given stays, without its author. A row of the data-api marked
 * `scope = 'tenant'` is the household's. And what a turn cost was spent:
 * the ledger keeps the amounts and, on `account`, loses the name.
 *
 * What this cannot reach is said, not hidden — `residual` in the result:
 * a garden's remote on someone else's machine, a site already published, a
 * household archive an admin exported, the operator's off-site backups
 * (which expire on their own schedule). docs/member-data.md has the list.
 *
 * `purgeMauriceDb` and `purgeDataDb` take the database as an argument and
 * assume nothing about its schema beyond what they find: the same two
 * functions rewrite a snapshot taken three weeks and ten migrations ago.
 */

import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import {
  existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { getAppDir } from "../../lib/appDir";
import { getDataDir } from "../../data-api/lib/config";
import db from "../db";
import { gardensRoot } from "./gardensRoot";
import { corpusCall } from "./mcpClient";

export type EraseScope = "data" | "account";

// ── Schema helpers ──────────────────────────────────────────────

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

export function tablesOf(d: Database): string[] {
  return (d.query(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  ).all() as { name: string }[]).map((r) => r.name);
}

export function columnsOf(d: Database, table: string): string[] {
  try {
    return (d.query(`PRAGMA table_info(${ident(table)})`).all() as { name: string }[]).map((r) => r.name);
  } catch {
    return []; // a virtual table whose module is not loaded here
  }
}

const has = (d: Database, table: string, column: string) => columnsOf(d, table).includes(column);

// ── maurice.db ──────────────────────────────────────────────────

/** `/api/images/<name>` as a message's markdown carries it. */
const IMAGE_REF = /\/api\/images\/([A-Za-z0-9][A-Za-z0-9._-]*)/g;

export function imageRefs(text: string | null | undefined): string[] {
  return text ? [...text.matchAll(IMAGE_REF)].map((m) => m[1]!) : [];
}

/** Tables whose rows are the member's own, by the column that says so. A
 *  table or a column a given database does not have is skipped. */
const OWNED: [table: string, column: string][] = [
  ["composer_specs", "account_id"],
  ["folders", "user_id"],
  ["files", "user_id"],
  ["note_shares", "owner_id"],
  ["note_shares", "member_id"],
  ["domain_briefs", "member_id"],
  ["life_facts", "member_id"],
  ["mail_accounts", "member_id"],
  ["mail_conversations", "member_id"],
  ["contact_cards", "member_id"],
  ["contact_accounts", "member_id"],
  ["domain_proposals", "member_id"],
  ["domain_mail", "member_id"],
  ["mail_sender_rules", "member_id"],
  ["domain_seen", "member_id"],
  ["calibre_libraries", "account_id"],
  ["blocks", "member_id"],
  ["blocks", "blocked_member_id"],
  ["reports", "reporter_member_id"],
  // So that the member may take their own archive back in afterwards.
  ["member_imports", "member_id"],
];

export interface MauricePurge {
  /** Conversations removed with everything under them. */
  conversations: number;
  /** Rooms handed to another participant. */
  handed_over: number;
  /** The member's own messages removed from rooms that stay. */
  messages: number;
  /** Rows removed from the owned tables. */
  rows: number;
  /** Image names the removed messages pointed at. */
  images: string[];
  /** `files.storage` of the removed library files. */
  files: string[];
}

/**
 * Remove a member from a maurice.db — the live one, or a snapshot of it.
 * One transaction; `PRAGMA foreign_keys` is turned on for it, the cascades
 * do part of the work.
 */
export function purgeMauriceDb(d: Database, memberId: string, scope: EraseScope): MauricePurge {
  const out: MauricePurge = { conversations: 0, handed_over: 0, messages: 0, rows: 0, images: [], files: [] };
  const tables = new Set(tablesOf(d));
  const run = (sql: string, params: any[] = []) => { d.run(sql, params); };
  // Counted before, not read from `changes`: that also counts what the
  // cascades and the full-text triggers removed underneath.
  const del = (table: string, where: string, params: any[]): number => {
    const n = (d.query(`SELECT COUNT(*) AS n FROM ${ident(table)} WHERE ${where}`).get(...params) as { n: number }).n;
    if (n) d.run(`DELETE FROM ${ident(table)} WHERE ${where}`, params);
    return n;
  };

  d.run("PRAGMA foreign_keys = ON");
  // A deleted row's bytes otherwise stay in the file's free pages, readable
  // by anyone who opens it with something other than SQL.
  d.run("PRAGMA secure_delete = ON");
  d.transaction(() => {
    const rooms = tables.has("conversation_participants");
    const authored = tables.has("messages") && has(d, "messages", "author_id");

    // What the disk holds for the rows about to go.
    if (tables.has("files")) {
      out.files = (d.query(`SELECT storage FROM files WHERE user_id = ?`).all(memberId) as { storage: string }[]).map((r) => r.storage);
    }
    if (tables.has("messages") && tables.has("conversations")) {
      const texts = d.query(
        `SELECT m.content FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE (c.user_id = ?1 ${authored ? "OR m.author_id = ?1" : ""}) AND m.content LIKE '%/api/images/%'`,
      ).all(memberId) as { content: string }[];
      out.images = [...new Set(texts.flatMap((t) => imageRefs(t.content)))];
    }

    // A room the member opened and others still sit in is theirs too: it
    // goes to whoever joined first among them.
    if (rooms && tables.has("conversations")) {
      const shared = d.query(
        `SELECT c.id,
                (SELECT p.member_id FROM conversation_participants p
                  WHERE p.conversation_id = c.id AND p.member_id != ?1
                  ORDER BY p.joined_at, p.rowid LIMIT 1) AS heir
           FROM conversations c WHERE c.user_id = ?1`,
      ).all(memberId) as { id: string; heir: string | null }[];
      for (const room of shared) {
        if (!room.heir) continue;
        run(`UPDATE conversations SET user_id = ? WHERE id = ?`, [room.heir, room.id]);
        run(`UPDATE conversation_participants SET role = 'owner' WHERE conversation_id = ? AND member_id = ?`, [room.id, room.heir]);
        out.handed_over++;
      }
    }

    if (tables.has("conversations")) {
      out.conversations = del("conversations", "user_id = ?", [memberId]);
    }
    // Their words in the rooms that stay, then their seat there.
    if (authored) out.messages = del("messages", "author_id = ?", [memberId]);
    if (rooms) run(`DELETE FROM conversation_participants WHERE member_id = ?`, [memberId]);

    for (const [table, column] of OWNED) {
      if (tables.has(table) && has(d, table, column)) out.rows += del(table, `${ident(column)} = ?`, [memberId]);
    }
    // A report that names the member as its subject names them still.
    if (tables.has("reports")) out.rows += del("reports", "target_type = 'member' AND target_id = ?", [memberId]);

    // A garden's settings are keyed by its audience: the gardeners' ids, joined.
    if (tables.has("garden_settings")) {
      const keys = (d.query(`SELECT id FROM garden_settings`).all() as { id: string }[])
        .filter((r) => r.id.split("+").includes(memberId));
      for (const k of keys) out.rows += del("garden_settings", "id = ?", [k.id]);
    }

    // The domains and companions they created — unless another member was
    // given one, in which case it stays and only forgets who made it.
    if (tables.has("maurices") && has(d, "maurices", "created_by")) {
      const mine = d.query(`SELECT id FROM maurices WHERE created_by = ?`).all(memberId) as { id: string }[];
      for (const m of mine) {
        const others = tables.has("maurice_access")
          ? (d.query(`SELECT COUNT(*) AS n FROM maurice_access WHERE maurice_id = ? AND member_id != ?`).get(m.id, memberId) as { n: number }).n
          : 0;
        if (others) {
          run(`UPDATE maurices SET created_by = NULL WHERE id = ?`, [m.id]);
          continue;
        }
        if (tables.has("conversations") && has(d, "conversations", "maurice_id")) {
          run(`UPDATE conversations SET maurice_id = NULL WHERE maurice_id = ?`, [m.id]);
        }
        out.rows += del("maurices", "id = ?", [m.id]);
      }
    }

    if (tables.has("users")) {
      if (scope === "account") {
        // What a turn cost was spent; who spent it leaves with them.
        if (tables.has("spend_ledger") && has(d, "spend_ledger", "user_id")) {
          run(`UPDATE spend_ledger SET user_id = NULL WHERE user_id = ?`, [memberId]);
        }
        run(`DELETE FROM users WHERE id = ?`, [memberId]);
      } else {
        for (const column of ["profile_text", "notes_domain", "cloudflare_account", "cloudflare_token"]) {
          if (has(d, "users", column)) run(`UPDATE users SET ${ident(column)} = NULL WHERE id = ?`, [memberId]);
        }
      }
    }
  })();
  settle(d, tables.has("messages_fts") ? ["messages_fts"] : []);
  return out;
}

/** After a purge: merge the full-text indexes (a deleted row's words stay in
 *  their segments until then) and fold the write-ahead log back into the
 *  file, where the rows it still spells out are overwritten. */
function settle(d: Database, fts: string[] = []): void {
  for (const table of fts) {
    try { d.run(`INSERT INTO ${ident(table)}(${ident(table)}) VALUES ('optimize')`); } catch { /* not an FTS5 table here */ }
  }
  try { d.run("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* a reader holds it: the next checkpoint will */ }
}

// ── The data-api databases ──────────────────────────────────────

export interface DataPurge {
  deleted: number;
  /** Rows that carry the member's id but belong to the household (`scope = 'tenant'`). */
  shared: number;
  /** `dossiers.content_path` of the removed dossiers. */
  paths: string[];
}

/**
 * Remove a member from a data-api database: every table with a `member_id`
 * loses the member's rows, then the rows that pointed at those (a declared
 * foreign key without a cascade — `task_log` → `tasks`). A row marked
 * `scope = 'tenant'` is the household's and stays.
 */
export function purgeDataDb(d: Database, memberId: string): DataPurge {
  const out: DataPurge = { deleted: 0, shared: 0, paths: [] };
  const tables = tablesOf(d);
  d.run("PRAGMA secure_delete = ON");
  d.transaction(() => {
    const touched = new Set<string>();
    for (const table of tables) {
      const cols = columnsOf(d, table);
      if (!cols.includes("member_id")) continue;
      const own = cols.includes("scope") ? ` AND (scope IS NULL OR scope != 'tenant')` : "";
      if (cols.includes("scope")) {
        out.shared += (d.query(`SELECT COUNT(*) AS n FROM ${ident(table)} WHERE member_id = ? AND scope = 'tenant'`).get(memberId) as { n: number }).n;
      }
      if (table === "dossiers" && cols.includes("content_path")) {
        out.paths = (d.query(`SELECT content_path FROM dossiers WHERE member_id = ?${own} AND content_path IS NOT NULL`).all(memberId) as { content_path: string }[])
          .map((r) => r.content_path);
      }
      const n = (d.query(`SELECT COUNT(*) AS n FROM ${ident(table)} WHERE member_id = ?${own}`).get(memberId) as { n: number }).n;
      if (n) {
        d.run(`DELETE FROM ${ident(table)} WHERE member_id = ?${own}`, [memberId]);
        touched.add(table);
      }
      out.deleted += n;
    }
    // Children left pointing at nothing.
    for (const table of tables) {
      let fks: { table: string; from: string; to: string | null }[] = [];
      try { fks = d.query(`PRAGMA foreign_key_list(${ident(table)})`).all() as any[]; } catch { continue; }
      for (const fk of fks) {
        if (!touched.has(fk.table) || !fk.to) continue;
        out.deleted += d.run(
          `DELETE FROM ${ident(table)} WHERE ${ident(fk.from)} IS NOT NULL
             AND ${ident(fk.from)} NOT IN (SELECT ${ident(fk.to)} FROM ${ident(fk.table)})`,
        ).changes;
      }
    }
  })();
  settle(d);
  return out;
}

/** The data-api databases of this household, maurice.db left out. */
export function dataDbPaths(): string[] {
  const appDir = resolve(getAppDir());
  let dataDir: string;
  try { dataDir = resolve(getDataDir()); } catch { dataDir = appDir; }
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir)
    .filter((f) => f.endsWith(".db") && !(dataDir === appDir && f === "maurice.db"))
    .map((f) => join(dataDir, f))
    .filter((p) => statSync(p).size > 0);
}

// ── The disk ────────────────────────────────────────────────────

const rm = (path: string) => { try { rmSync(path, { recursive: true, force: true }); } catch {} };

/** `path` and the sidecars of a WAL database. */
function rmDb(path: string): boolean {
  const there = existsSync(path);
  for (const suffix of ["", "-wal", "-shm"]) rm(path + suffix);
  return there;
}

/** The same rule as `store_path` in tools/email/store.py. */
export function mailStorePath(memberId: string): string {
  return join(getAppDir(), "mail", `${memberId.replace(/[^A-Za-z0-9_.-]/g, "_")}.db`);
}

function within(path: string, base: string): boolean {
  const p = resolve(path);
  return p.startsWith(resolve(base) + sep);
}

/** Images the removed messages showed and no remaining message does. */
function removeImages(names: string[]): number {
  const dir = join(getAppDir(), "images");
  let n = 0;
  for (const name of names) {
    const still = db.query(`SELECT 1 FROM messages WHERE content LIKE ? LIMIT 1`).get(`%/api/images/${name}%`);
    if (still) continue;
    for (const f of [name, `${name}.orig`, `${name.replace(/\.[^.]+$/, "")}.orig`]) {
      const p = join(dir, f);
      if (within(p, dir) && existsSync(p)) { rm(p); n++; }
    }
  }
  return n;
}

interface GardenErase {
  removed: boolean;
  /** Remotes this server cannot empty: `name url`. */
  remotes: string[];
}

function removeGarden(username: string): GardenErase {
  const root = gardensRoot();
  const garden = join(root, username);
  const out: GardenErase = { removed: false, remotes: [] };
  if (!username || !within(garden, root)) return out;

  if (existsSync(join(garden, ".git"))) {
    const r = spawnSync("git", ["remote", "-v"], { cwd: garden, encoding: "utf8" });
    const seen = new Set<string>();
    for (const line of (r.stdout ?? "").split("\n")) {
      const [name, url] = line.split(/\s+/);
      if (!name || !url || seen.has(url)) continue;
      seen.add(url);
      // A bare remote on this machine goes with the garden; any other is out of reach.
      const local = url.startsWith("/") || url.startsWith("file://") ? url.replace(/^file:\/\//, "") : null;
      if (local && within(local, getAppDir())) rm(local);
      else out.remotes.push(`${name} ${url}`);
    }
  }
  rm(join(getAppDir(), "git", `${username}.git`));
  if (existsSync(garden)) { rm(garden); out.removed = true; }

  const manifest = join(root, "gardens.json");
  try {
    const m = JSON.parse(readFileSync(manifest, "utf8"));
    if (m && typeof m === "object" && username in m) {
      delete m[username];
      writeFileSync(manifest, JSON.stringify(m, null, 2) + "\n");
    }
  } catch { /* no manifest, or not ours to mend */ }
  return out;
}

/** Drop a member from the nights' state files, which key some of what they
 *  remember by member id. */
function forgetNightlyState(memberId: string): void {
  const dir = getAppDir();
  for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith("-nightly.json")) : []) {
    try {
      const state = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (state?.members && memberId in state.members) {
        delete state.members[memberId];
        writeFileSync(join(dir, f), JSON.stringify(state, null, 2));
      }
    } catch { /* a corrupt state file costs one extra run, nothing more */ }
  }
}

// ── Snapshots ───────────────────────────────────────────────────

/**
 * Rewrite the night's local snapshots (scripts/backup-db.sh) without the
 * member. A snapshot is a whole database, gzipped: it is opened, purged with
 * the same two functions as the live ones, compacted and put back under its
 * own name. One that cannot be rewritten is removed — a backup that still
 * holds an erased member is not one to keep. Returns how many were rewritten
 * and how many removed.
 */
export function scrubSnapshots(memberId: string, scope: EraseScope, dir = join(getAppDir(), "backups", "db")): { rewritten: number; removed: number } {
  const out = { rewritten: 0, removed: 0 };
  if (!existsSync(dir)) return out;
  const mail = `mail-${basename(mailStorePath(memberId), ".db")}-`;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".db.gz"))) {
    const file = join(dir, f);
    // A snapshot of their mail store is theirs whole.
    if (f.startsWith(mail)) { rm(file); out.removed++; continue; }
    if (f.startsWith("mail-")) continue;
    const tmp = join(dir, `.scrub-${process.pid}-${f.slice(0, -3)}`);
    const compact = `${tmp}.vacuum`;
    try {
      writeFileSync(tmp, gunzipSync(readFileSync(file)));
      const d = new Database(tmp);
      try {
        if (f.startsWith("maurice-")) purgeMauriceDb(d, memberId, scope);
        else purgeDataDb(d, memberId);
        // Deleted rows stay readable in the free pages until the file is rebuilt.
        d.run("VACUUM INTO ?", [compact]);
      } finally {
        d.close();
      }
      writeFileSync(file, gzipSync(readFileSync(compact)));
      out.rewritten++;
    } catch (e: any) {
      console.warn(`[erase] snapshot ${f} could not be rewritten (${e?.message ?? e}) — removed`);
      rm(file);
      out.removed++;
    } finally {
      for (const p of [tmp, `${tmp}-wal`, `${tmp}-shm`, compact]) rm(p);
    }
  }
  return out;
}

// ── Logs ────────────────────────────────────────────────────────

/** Where this install's logs are: MAURICE_LOG_DIR, else the launchd agents'
 *  directory on a Mac and the app dir's on a container. Never guessed under
 *  `bun test`. */
function logDirs(): string[] {
  if (process.env.MAURICE_LOG_DIR) return [process.env.MAURICE_LOG_DIR];
  if (process.env.NODE_ENV === "test") return [];
  return [join(homedir(), "Library", "Logs", "Maurice"), join(getAppDir(), "logs")].filter((d) => existsSync(d));
}

/** Drop the lines that name the member — their id, or a path of their
 *  garden. The request log is the only place either appears. */
export function scrubLogs(memberId: string, username: string): number {
  const marks = [memberId, ...(username ? [`/g/${username}/`, `/g/${username} `, `/images/${username}/`, `/garden-images/${username}/`, `/gardens/${username}`] : [])];
  let n = 0;
  for (const dir of logDirs()) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".log"))) {
      const file = join(dir, f);
      try {
        const lines = readFileSync(file, "utf8").split("\n");
        const kept = lines.filter((l) => !marks.some((m) => l.includes(m)));
        if (kept.length === lines.length) continue;
        n += lines.length - kept.length;
        // In place, same inode: the services hold these files open for append.
        writeFileSync(file, kept.join("\n"));
      } catch { /* a log that cannot be read is not rewritten */ }
    }
  }
  return n;
}

// ── The register ────────────────────────────────────────────────
//
// What was erased, and when: an opaque id and a date, nothing that says who.
// It is the household's proof that the request was honoured, and where a
// step that could not run (the gateway was down) waits to be tried again —
// `pending` then holds the garden's path, which the corpus needs to forget
// its files, and is emptied the moment the step succeeds.

db.run(`
  CREATE TABLE IF NOT EXISTS erasures (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id  TEXT NOT NULL,
    scope      TEXT NOT NULL CHECK (scope IN ('data', 'account')),
    erased_at  TEXT NOT NULL DEFAULT (datetime('now')),
    pending    TEXT
  )
`);

export interface EraseDeps {
  /** The corpus tool's `forget_member`, through the gateway. */
  corpus: (memberId: string, garden: string | null) => Promise<any>;
}
const defaultDeps: EraseDeps = {
  corpus: (memberId, garden) => corpusCall(memberId, "forget_member", { member_id: memberId, ...(garden ? { garden } : {}) }),
};
let deps: EraseDeps = defaultDeps;
/** Tests swap the gateway for a stub. */
export function setEraseDeps(d: Partial<EraseDeps> | null): void {
  deps = d ? { ...defaultDeps, ...d } : defaultDeps;
}

async function forgetCorpus(memberId: string, garden: string | null = null): Promise<boolean> {
  try {
    const r = await deps.corpus(memberId, garden);
    if (r?.error || r?.raw) throw new Error(String(r.error ?? r.raw));
    return true;
  } catch (e: any) {
    console.warn(`[erase] the corpus could not be reached: ${e?.message ?? e}`);
    return false;
  }
}

/** Try again what an earlier erasure had to leave. Called at boot and before
 *  each new erasure. */
export async function retryPendingErasures(): Promise<number> {
  const rows = db.query(`SELECT id, member_id, pending FROM erasures WHERE pending IS NOT NULL`).all() as
    { id: number; member_id: string; pending: string }[];
  let done = 0;
  for (const r of rows) {
    if (await forgetCorpus(r.member_id, r.pending.startsWith("/") ? r.pending : null)) {
      db.run(`UPDATE erasures SET pending = NULL WHERE id = ?`, [r.id]);
      done++;
    }
  }
  return done;
}

// ── The whole gesture ───────────────────────────────────────────

export interface EraseResult {
  scope: EraseScope;
  conversations: number;
  handed_over: number;
  messages: number;
  rows: number;
  files: number;
  images: number;
  garden: boolean;
  mail: boolean;
  /** False when the gateway was down: recorded, and tried again at boot. */
  corpus: boolean;
  snapshots: { rewritten: number; removed: number };
  log_lines: number;
  /** What this server cannot reach, for the member (or the admin) to be told. */
  residual: {
    /** Remotes of the garden's repository, on someone else's machine. */
    garden_remotes: string[];
    /** The member had a site published, or the means to publish one. */
    published_site: boolean;
    /** Household archives an admin exported, still in backups/archive. */
    household_archives: number;
    /** Rows of the data-api that carry the member's id but are the household's. */
    shared_rows: number;
    /** Always true: an operator's off-site backups expire on their schedule. */
    offsite_backups: true;
  };
}

export class EraseError extends Error {
  constructor(public code: "not_found" | "last_admin") {
    super(code);
  }
}

/** An admin may not leave a household that others still live in without one. */
export function assertMayLeave(memberId: string): void {
  const u = db.query(`SELECT role FROM users WHERE id = ?`).get(memberId) as { role: string } | null;
  if (!u) throw new EraseError("not_found");
  if (u.role !== "admin") return;
  const admins = (db.query(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND id != ?`).get(memberId) as { n: number }).n;
  const others = (db.query(`SELECT COUNT(*) AS n FROM users WHERE id != ?`).get(memberId) as { n: number }).n;
  if (!admins && others) throw new EraseError("last_admin");
}

export async function eraseMember(memberId: string, scope: EraseScope): Promise<EraseResult> {
  const user = db.query(
    `SELECT username, avatar_url, notes_domain, cloudflare_account FROM users WHERE id = ?`,
  ).get(memberId) as { username: string; avatar_url: string | null; notes_domain: string | null; cloudflare_account: string | null } | null;
  if (!user) throw new EraseError("not_found");
  if (scope === "account") assertMayLeave(memberId);

  await retryPendingErasures().catch(() => {});
  const appDir = getAppDir();

  // 1. The index, while the gateway still answers for this member.
  const gardenPath = user.username ? join(gardensRoot(), user.username) : null;
  const corpus = await forgetCorpus(memberId, gardenPath);

  // 2. maurice.db.
  const purge = purgeMauriceDb(db, memberId, scope);
  db.run(`INSERT INTO erasures (member_id, scope, pending) VALUES (?, ?, ?)`, [memberId, scope, corpus ? null : gardenPath ?? "corpus"]);

  // 3. The data-api databases.
  let shared = 0;
  let dataRows = 0;
  for (const path of dataDbPaths()) {
    const d = new Database(path);
    try {
      const r = purgeDataDb(d, memberId);
      shared += r.shared;
      dataRows += r.deleted;
      const dossiers = resolve(import.meta.dir, "..", "..", "..", "dossiers");
      for (const p of r.paths) {
        const file = resolve(dossiers, p);
        if (within(file, dossiers)) rm(file);
      }
    } catch (e: any) {
      console.warn(`[erase] ${basename(path)}: ${e?.message ?? e}`);
    } finally {
      d.close();
    }
  }

  // 4. The disk.
  let files = 0;
  const filesDir = join(appDir, "files");
  for (const storage of purge.files) {
    const p = join(filesDir, storage);
    if (within(p, filesDir) && existsSync(p)) { rm(p); files++; }
  }
  const images = removeImages(purge.images);
  const uploads = join(appDir, "uploads");
  for (const f of existsSync(uploads) ? readdirSync(uploads) : []) {
    if (f.includes(`-${memberId}-`)) rm(join(uploads, f));
  }
  const mail = rmDb(mailStorePath(memberId));
  forgetNightlyState(memberId);
  const garden = removeGarden(user.username);
  if (scope === "account") {
    const avatars = join(appDir, "avatars");
    const own = user.avatar_url?.startsWith("/api/avatars/") ? join(avatars, basename(user.avatar_url)) : null;
    for (const p of [own, join(avatars, `${user.username}-sq.png`)]) if (p && within(p, avatars)) rm(p);
  }

  // 5 and 6. The copies.
  const snapshots = scrubSnapshots(memberId, scope);
  const log_lines = scrubLogs(memberId, user.username);

  const archives = join(appDir, "backups", "archive");
  const result: EraseResult = {
    scope,
    conversations: purge.conversations,
    handed_over: purge.handed_over,
    messages: purge.messages,
    rows: purge.rows + dataRows,
    files,
    images,
    garden: garden.removed,
    mail,
    corpus,
    snapshots,
    log_lines,
    residual: {
      garden_remotes: garden.remotes,
      published_site: !!(user.notes_domain || user.cloudflare_account),
      household_archives: existsSync(archives) ? readdirSync(archives).filter((f) => f.endsWith(".tar.gz")).length : 0,
      shared_rows: shared,
      offsite_backups: true,
    },
  };
  // Counts only: written after the logs were cleaned, it says nothing of who.
  console.log(`[erase] ${scope} erased: ${JSON.stringify({ ...result, residual: { ...result.residual, garden_remotes: garden.remotes.length } })}`);
  return result;
}
