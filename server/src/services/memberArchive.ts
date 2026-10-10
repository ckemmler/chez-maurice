/**
 * The member archive — `maurice-member-archive`, version 1.
 *
 * Everything one member is, as one file they can read and take elsewhere:
 * the GDPR's rights of access and portability (art. 15 and 20), 3 October
 * 2026. The household archive (services/archive.ts) already moved a whole
 * household, but only an admin may ask for it, and it hands them every
 * member's conversations along with the provider keys. This one is asked for
 * by the member, about the member, and holds nothing of anyone else.
 *
 * It is made to be read as much as to be imported: JSON a person can open,
 * not a database — one file per conversation, one per table — beside the
 * garden as it is on disk (history included), the library files, the images
 * their conversations show and their avatar. See docs/member-data.md.
 *
 * What is left out, on purpose:
 *
 *   - credentials — password and PIN hashes, sessions, tokens, the mail and
 *     address-book passwords, the publishing token;
 *   - other people's words — in a room shared with other members, only the
 *     member's own messages travel;
 *   - what can be rebuilt — the semantic index, the conversation summaries.
 *
 * The mail store is exported opened: its subjects and readings are sealed
 * with the household's key (tools/email/sealing.py), which the member does
 * not hold and another household does not have.
 *
 * Import pours an archive into an existing account — the member's own, on
 * this household or another. It adds and never overwrites: a conversation,
 * a file or a note already there stays as it is. An archive is a file
 * someone uploaded, so nothing in it is trusted: columns are checked against
 * the schema, a row never lands under another member's conversation or
 * folder, library files get new names on disk, and the garden's `.git` is
 * not taken (a repository's config and hooks run commands) — the notes are
 * committed afresh, the history stays in the archive.
 */

import { Database } from "bun:sqlite";
import {
  copyFileSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { getAppDir } from "../../lib/appDir";
import { autoCommit } from "../../data-api/services/gardenFiche";
import { indexGardenPaths } from "../../data-api/services/gardenIndex";
import db from "../db";
import {
  ArchiveError, TAR_ENV, TAR_EXCLUDES, archiveFilename, snapshotDb, tarFailed, tarFlavor, tarOut,
} from "./archive";
import { BUILD } from "./buildInfo";
import { gardensRoot } from "./gardensRoot";
import { decryptSecret } from "./mailAccounts";
import { columnsOf, dataDbPaths, imageRefs, mailStorePath, tablesOf } from "./memberErase";

export const MEMBER_ARCHIVE_FORMAT = "maurice-member-archive";
export const MEMBER_ARCHIVE_VERSION = 1;

export type MemberManifest = {
  format: typeof MEMBER_ARCHIVE_FORMAT;
  version: typeof MEMBER_ARCHIVE_VERSION;
  /** Unique to this export: an account takes a given archive in once. */
  archive_id: string;
  created_at: string;
  member: { id: string; username: string; display_name: string };
  household: string;
  server_version: string;
  /** The archive's top-level entries, directories with a trailing slash. */
  contents: string[];
  counts: Record<string, number>;
};

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
const json = (file: string, value: unknown) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
};

/** The member's rows of maurice.db, table by table: `[table, owner column,
 *  columns that never leave]`. Conversations and the account have their own
 *  shape and are not in this list. */
const TABLES: [table: string, column: string, secret?: string[]][] = [
  ["user_preferences", "user_id"],
  ["folders", "user_id"],
  ["files", "user_id"],
  ["composer_specs", "account_id"],
  ["maurices", "created_by"],
  ["life_facts", "member_id"],
  ["domain_briefs", "member_id"],
  ["domain_proposals", "member_id"],
  ["domain_mail", "member_id"],
  ["domain_seen", "member_id"],
  ["mail_accounts", "member_id", ["secret"]],
  ["mail_conversations", "member_id"],
  ["mail_reading_consent", "member_id"],
  ["mail_sender_rules", "member_id"],
  ["contact_accounts", "member_id", ["secret"]],
  ["contact_cards", "member_id"],
  ["calibre_libraries", "account_id"],
  ["note_shares", "owner_id"],
  ["blocks", "member_id"],
  ["reports", "reporter_member_id"],
  ["spend_ledger", "user_id"],
];

/** Of those, what an import writes back. The rest is for reading: accounts
 *  come without their password, a library names a path of the old machine,
 *  shares, blocks and reports name members of the old household, and what
 *  was spent there was not spent here. */
const IMPORTED = [
  "user_preferences", "maurices", "folders", "files", "life_facts", "domain_briefs",
  "domain_proposals", "domain_mail", "domain_seen", "mail_sender_rules",
];

/** Account columns that are credentials, or the household's business. */
const ACCOUNT_SECRET = ["password_hash", "pin_hash", "cloudflare_token", "household_id"];

/** Top-level names the archive uses: a garden directory called one of these
 *  cannot be renamed on the fly by tar and is copied instead. */
const RESERVED = ["manifest.json", "account.json", "conversations", "maurice", "data", "mail", "files", "images", "avatars", "garden"];

// ── Export ──────────────────────────────────────────────────────

/** Hard-link when the two sit on one volume, copy when they do not. */
function place(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  try { linkSync(src, dest); } catch { copyFileSync(src, dest); }
}

/** The mail store, opened: every table as rows, the sealed columns in clear. */
function exportMail(memberId: string, staging: string): number {
  const store = mailStorePath(memberId);
  if (!existsSync(store) || statSync(store).size === 0) return 0;
  const snap = join(staging, ".mail.db");
  snapshotDb(store, snap);
  const d = new Database(snap, { readonly: true });
  let messages = 0;
  try {
    for (const table of tablesOf(d)) {
      const rows = (d.query(`SELECT * FROM ${ident(table)}`).all() as Record<string, any>[]).map((row) => {
        const out: Record<string, any> = {};
        for (const [k, v] of Object.entries(row)) {
          if (!k.endsWith("_sealed")) { out[k] = v; continue; }
          try { out[k.slice(0, -7)] = v == null ? null : decryptSecret(String(v)); } catch { out[k.slice(0, -7)] = null; }
        }
        return out;
      });
      if (table === "messages") messages = rows.length;
      if (rows.length) json(join(staging, "mail", `${table}.json`), rows);
    }
  } finally {
    d.close();
    rmSync(snap, { force: true });
  }
  return messages;
}

type Prepared = { staging: string; manifest: MemberManifest; filename: string; tarArgs: string[]; cleanup: () => void };

function prepare(memberId: string): Prepared {
  const user = db.query(`SELECT * FROM users WHERE id = ?`).get(memberId) as Record<string, any> | null;
  if (!user) throw new ArchiveError("no such member");
  const appDir = resolve(getAppDir());

  // Inside the app dir, so the library files can be hard-linked rather than
  // copied: an export must not need the room to hold the library twice.
  const tmp = join(appDir, "tmp");
  mkdirSync(tmp, { recursive: true });
  const staging = mkdtempSync(join(tmp, "member-archive-"));
  const cleanup = () => { try { rmSync(staging, { recursive: true, force: true }); } catch {} };

  try {
    const counts: Record<string, number> = {};

    const account = Object.fromEntries(Object.entries(user).filter(([k]) => !ACCOUNT_SECRET.includes(k)));
    json(join(staging, "account.json"), account);

    // Conversations, one file each. A room shared with other members carries
    // only what this member wrote there.
    const convos = db.query(
      `SELECT c.*, EXISTS (SELECT 1 FROM conversation_participants p
                            WHERE p.conversation_id = c.id AND p.member_id != ?1) AS room
         FROM conversations c
        WHERE c.user_id = ?1
           OR c.id IN (SELECT conversation_id FROM conversation_participants WHERE member_id = ?1)
        ORDER BY c.created_at`,
    ).all(memberId) as Record<string, any>[];
    const images = new Set<string>();
    counts.conversations = convos.length;
    counts.messages = 0;
    for (const c of convos) {
      const room = !!c.room;
      const messages = db.query(
        `SELECT * FROM messages WHERE conversation_id = ? ${room ? "AND author_id = ?" : ""} ORDER BY created_at, rowid`,
      ).all(...(room ? [c.id, memberId] : [c.id])) as Record<string, any>[];
      for (const m of messages) for (const name of imageRefs(m.content)) images.add(name);
      counts.messages += messages.length;
      json(join(staging, "conversations", `${c.id}.json`), { ...c, room, messages });
    }

    const present = new Set(tablesOf(db));
    for (const [table, column, secret] of TABLES) {
      if (!present.has(table)) continue;
      const rows = db.query(`SELECT * FROM ${ident(table)} WHERE ${ident(column)} = ?`).all(memberId) as Record<string, any>[];
      if (!rows.length) continue;
      for (const row of rows) for (const s of secret ?? []) delete row[s];
      counts[table] = rows.length;
      json(join(staging, "maurice", `${table}.json`), rows);
    }

    // The data-api databases: every table that carries a member_id, the
    // household's own rows (scope = 'tenant') left where they are.
    for (const path of dataDbPaths()) {
      const d = new Database(path, { readonly: true });
      try {
        for (const table of tablesOf(d)) {
          const cols = columnsOf(d, table);
          if (!cols.includes("member_id")) continue;
          const own = cols.includes("scope") ? ` AND (scope IS NULL OR scope != 'tenant')` : "";
          const rows = d.query(`SELECT * FROM ${ident(table)} WHERE member_id = ?${own}`).all(memberId) as Record<string, any>[];
          if (!rows.length) continue;
          counts[table] = rows.length;
          json(join(staging, "data", basename(path, ".db"), `${table}.json`), rows);
        }
      } catch (e: any) {
        console.warn(`[member-archive] ${basename(path)}: ${e?.message ?? e}`);
      } finally {
        d.close();
      }
    }

    counts.mail_messages = exportMail(memberId, staging);

    // The disk.
    counts.files = 0;
    for (const f of db.query(`SELECT storage FROM files WHERE user_id = ?`).all(memberId) as { storage: string }[]) {
      const src = join(appDir, "files", basename(f.storage));
      if (existsSync(src)) { place(src, join(staging, "files", basename(f.storage))); counts.files++; }
    }
    counts.images = 0;
    for (const name of images) {
      const src = join(appDir, "images", basename(name));
      if (existsSync(src)) { place(src, join(staging, "images", basename(name))); counts.images++; }
    }
    const avatar = typeof user.avatar_url === "string" && user.avatar_url.startsWith("/api/avatars/") ? basename(user.avatar_url) : null;
    for (const name of [avatar, `${user.username}-sq.png`]) {
      const src = name ? join(appDir, "avatars", name) : null;
      if (src && existsSync(src)) place(src, join(staging, "avatars", name!));
    }

    const garden = join(gardensRoot(), String(user.username));
    const hasGarden = !!user.username && existsSync(garden) && statSync(garden).isDirectory();
    const renamed = hasGarden && !RESERVED.includes(String(user.username));
    if (hasGarden && !renamed) cpSync(garden, join(staging, "garden"), { recursive: true });

    const staged = readdirSync(staging).sort();
    const household = (db.query(`SELECT name FROM households WHERE id = 'default'`).get() as { name: string } | null)?.name ?? "";
    const manifest: MemberManifest = {
      format: MEMBER_ARCHIVE_FORMAT,
      version: MEMBER_ARCHIVE_VERSION,
      archive_id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      member: { id: memberId, username: String(user.username), display_name: String(user.display_name) },
      household,
      server_version: BUILD.version,
      contents: [
        "manifest.json",
        ...staged.map((e) => (statSync(join(staging, e)).isDirectory() ? `${e}/` : e)),
        ...(renamed ? ["garden/"] : []),
      ],
      counts,
    };
    json(join(staging, "manifest.json"), manifest);

    const tarArgs = TAR_EXCLUDES.map((p) => `--exclude=${p}`);
    if (renamed) {
      const flag = tarFlavor() === "bsd" ? "-s" : "--transform";
      const u = String(user.username).replace(/[.[\]\\^$*+?()|]/g, "\\$&");
      tarArgs.push(flag, `|^${u}/|garden/|`, flag, `|^${u}$|garden|`);
    }
    tarArgs.push("-C", staging, "manifest.json", ...staged);
    if (renamed) tarArgs.push("-C", gardensRoot(), String(user.username));

    const filename = archiveFilename(String(user.username)).replace(/\.maurice\.tar\.gz$/, ".maurice-member.tar.gz");
    return { staging, manifest, filename, tarArgs, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

/** Write a member's archive to a file under `outDir`. The caller owns it. */
export async function exportMember(memberId: string, outDir = tmpdir()): Promise<{ path: string; manifest: MemberManifest }> {
  const p = prepare(memberId);
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, p.filename);
  try {
    const proc = Bun.spawn(["tar", "-czf", out, ...p.tarArgs], { env: TAR_ENV, stdout: "ignore", stderr: "pipe" });
    const stderr = new Response(proc.stderr).text();
    const code = await proc.exited;
    if (tarFailed(code, tarFlavor())) {
      try { rmSync(out, { force: true }); } catch {}
      throw new ArchiveError(`tar exited ${code}: ${(await stderr).trim()}`);
    }
    return { path: out, manifest: p.manifest };
  } finally {
    p.cleanup();
  }
}

/** The archive as an HTTP download, streamed as tar produces it — the same
 *  shape as the household's (services/archive.ts, `exportResponse`). */
export function memberExportResponse(memberId: string): Response {
  const p = prepare(memberId);
  const proc = Bun.spawn(["tar", "-czf", "-", ...p.tarArgs], { env: TAR_ENV, stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(proc.stderr).text();
  const flavor = tarFlavor();
  const done = proc.exited.then(async (code) => {
    p.cleanup();
    if (tarFailed(code, flavor)) throw new ArchiveError(`tar exited ${code}: ${(await stderr).trim()}`);
  });
  done.catch((e) => console.error(`[member-archive] export failed: ${e?.message ?? e}`));

  const upstream = proc.stdout.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const { value, done: eof } = await upstream.read();
      if (!eof) { ctrl.enqueue(value); return; }
      try { await done; ctrl.close(); } catch (e) { ctrl.error(e); }
    },
    cancel() {
      try { proc.kill(); } catch {}
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${p.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

// ── Import ──────────────────────────────────────────────────────

db.run(`
  CREATE TABLE IF NOT EXISTS member_imports (
    member_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    archive_id  TEXT NOT NULL,
    imported_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (member_id, archive_id)
  )
`);

export interface ImportReport {
  conversations: number;
  messages: number;
  rows: number;
  files: number;
  images: number;
  notes: number;
  /** Rows the archive held and this household could not take (a brief of a
   *  domain that does not exist here, a row already there). */
  skipped: number;
}

export function readMemberManifest(archivePath: string): MemberManifest {
  if (!existsSync(archivePath)) throw new ArchiveError(`no such archive: ${archivePath}`);
  let m: any;
  try {
    m = JSON.parse(tarOut(["-xzOf", archivePath, "manifest.json"]));
  } catch {
    throw new ArchiveError("not a Maurice member archive: no readable manifest.json in it");
  }
  if (m?.format !== MEMBER_ARCHIVE_FORMAT) throw new ArchiveError(`not a Maurice member archive (format: ${m?.format})`);
  if (m.version !== MEMBER_ARCHIVE_VERSION) {
    throw new ArchiveError(`member archive version ${m.version} — this server reads version ${MEMBER_ARCHIVE_VERSION}`);
  }
  if (typeof m.archive_id !== "string" || typeof m.member?.id !== "string") throw new ArchiveError("manifest.json is incomplete");
  return m as MemberManifest;
}

const readJson = (file: string): any => JSON.parse(readFileSync(file, "utf8"));
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Insert a row with the columns the target table has, ignoring what is
 *  already there. False when nothing was written — a duplicate, or a row the
 *  schema refuses (a foreign key to something this household has not). */
function insert(d: Database, table: string, row: Record<string, any>, cols = columnsOf(d, table)): boolean {
  const keys = Object.keys(row).filter((k) => cols.includes(k));
  if (!keys.length) return false;
  try {
    return d.run(
      `INSERT OR IGNORE INTO ${ident(table)} (${keys.map(ident).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
      keys.map((k) => {
        const v = row[k];
        return v !== null && typeof v === "object" ? JSON.stringify(v) : typeof v === "boolean" ? (v ? 1 : 0) : v;
      }),
    ).changes > 0;
  } catch {
    return false;
  }
}

/** The data-api rows: the member's id replaces the old one, integer keys are
 *  handed out afresh, and a declared foreign key follows its parent's new id. */
function importDataDb(path: string, dir: string, memberId: string, report: ImportReport): void {
  const d = new Database(path);
  try {
    const present = new Set(tablesOf(d));
    const tables = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5))
      .filter((t) => present.has(t) && columnsOf(d, t).includes("member_id"));
    const fksOf = (t: string) => d.query(`PRAGMA foreign_key_list(${ident(t)})`).all() as { table: string; from: string; to: string | null }[];
    // Parents before children.
    tables.sort((a, b) => Number(fksOf(a).some((f) => f.table === b)) - Number(fksOf(b).some((f) => f.table === a)));

    const remap = new Map<string, Map<any, any>>();
    d.transaction(() => {
      for (const table of tables) {
        const info = d.query(`PRAGMA table_info(${ident(table)})`).all() as { name: string; type: string; pk: number }[];
        const pks = info.filter((c) => c.pk > 0);
        const serial = pks.length === 1 && /INT/i.test(pks[0]!.type) ? pks[0]!.name : null;
        const fks = fksOf(table);
        const ids = new Map<any, any>();
        remap.set(table, ids);
        for (const src of readJson(join(dir, `${table}.json`)) as Record<string, any>[]) {
          if (src.scope === "tenant") continue;
          const row: Record<string, any> = { ...src, member_id: memberId };
          const old = serial ? row[serial] : undefined;
          if (serial) delete row[serial];
          for (const fk of fks) {
            const mapped = remap.get(fk.table)?.get(row[fk.from]);
            if (mapped !== undefined) row[fk.from] = mapped;
          }
          if (!insert(d, table, row, info.map((c) => c.name))) { report.skipped++; continue; }
          report.rows++;
          if (serial) ids.set(old, (d.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
        }
      }
    })();
  } finally {
    d.close();
  }
}

/** Copy the archive's garden into the member's, never over a file that is
 *  there, never a symlink, never its `.git`. Returns what was written. */
function importGarden(src: string, dest: string): string[] {
  const written: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git" || name === ".DS_Store" || name.startsWith("._")) continue;
      const from = join(dir, name);
      const st = lstatSync(from);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { walk(from); continue; }
      if (!st.isFile()) continue;
      const to = join(dest, relative(src, from));
      if (existsSync(to)) continue;
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      written.push(to);
    }
  };
  walk(src);
  return written;
}

/**
 * Pour a member archive into an account. Adds, never overwrites; refuses an
 * archive this account already took in.
 */
export async function importMember(archivePath: string, memberId: string): Promise<{ manifest: MemberManifest; report: ImportReport }> {
  const target = db.query(`SELECT id, username, avatar_url FROM users WHERE id = ?`).get(memberId) as
    { id: string; username: string; avatar_url: string | null } | null;
  if (!target) throw new ArchiveError("no such member");
  const manifest = readMemberManifest(archivePath);
  if (db.query(`SELECT 1 FROM member_imports WHERE member_id = ? AND archive_id = ?`).get(memberId, manifest.archive_id)) {
    throw new ArchiveError("this archive was already imported into this account");
  }
  // Nothing in a tar may name a place outside where it is opened.
  for (const name of tarOut(["-tzf", archivePath]).split("\n")) {
    if (name.startsWith("/") || name.split("/").includes("..")) throw new ArchiveError(`unsafe path in archive: ${name}`);
  }

  const appDir = resolve(getAppDir());
  mkdirSync(join(appDir, "tmp"), { recursive: true });
  const work = mkdtempSync(join(appDir, "tmp", "member-import-"));
  const report: ImportReport = { conversations: 0, messages: 0, rows: 0, files: 0, images: 0, notes: 0, skipped: 0 };
  const old = manifest.member.id;
  try {
    const proc = Bun.spawn(["tar", "-xzf", archivePath, "-C", work], { env: TAR_ENV, stdout: "ignore", stderr: "pipe" });
    const stderr = new Response(proc.stderr).text();
    const code = await proc.exited;
    if (code !== 0) throw new ArchiveError(`tar exited ${code}: ${(await stderr).trim()}`);

    const table = (name: string): Record<string, any>[] => {
      const file = join(work, "maurice", `${name}.json`);
      return IMPORTED.includes(name) && existsSync(file) ? readJson(file) : [];
    };
    // Library files get a new name on disk: a `storage` taken from the
    // archive could name a file that is someone else's.
    const blobs: [from: string, to: string][] = [];

    db.transaction(() => {
      db.run(`INSERT INTO member_imports (member_id, archive_id) VALUES (?, ?)`, [memberId, manifest.archive_id]);

      for (const row of table("user_preferences")) insert(db, "user_preferences", { ...row, user_id: memberId });
      for (const row of table("maurices")) {
        const { household_id: _h, ...rest } = row;
        if (insert(db, "maurices", { ...rest, created_by: memberId })) {
          report.rows++;
          insert(db, "maurice_access", { maurice_id: row.id, member_id: memberId });
        } else report.skipped++;
      }

      const convDir = join(work, "conversations");
      for (const f of existsSync(convDir) ? readdirSync(convDir).filter((x) => x.endsWith(".json")) : []) {
        const { messages = [], room, ...conv } = readJson(join(convDir, f)) as Record<string, any>;
        // A room is not the member's to bring: its other voices are not in here.
        if (room || typeof conv.id !== "string") continue;
        insert(db, "conversations", { ...conv, user_id: memberId });
        const owner = db.query(`SELECT user_id FROM conversations WHERE id = ?`).get(conv.id) as { user_id: string } | null;
        if (owner?.user_id !== memberId) { report.skipped++; continue; }
        insert(db, "conversation_participants", { conversation_id: conv.id, member_id: memberId, role: "owner" });
        let added = 0;
        for (const m of messages as Record<string, any>[]) {
          if (insert(db, "messages", { ...m, conversation_id: conv.id, author_id: m.author_id === old ? memberId : null })) added++;
        }
        report.messages += added;
        if (added || !messages.length) report.conversations++;
      }

      const folders = table("folders");
      const mine = new Set(folders.map((f) => f.id));
      // Parents first; a parent that is not in the archive is no parent.
      const placed = new Set<string>();
      for (let pass = 0; pass < folders.length + 1 && placed.size < folders.length; pass++) {
        for (const f of folders) {
          if (placed.has(f.id)) continue;
          const parent = mine.has(f.parent_id) ? f.parent_id : null;
          if (parent && !placed.has(parent)) continue;
          placed.add(f.id);
          if (insert(db, "folders", { ...f, user_id: memberId, parent_id: parent })) report.rows++;
        }
      }
      const myFolder = (id: any) =>
        id && (db.query(`SELECT 1 FROM folders WHERE id = ? AND user_id = ?`).get(id, memberId) ? id : null);
      for (const f of table("files")) {
        const name = basename(String(f.storage ?? ""));
        const from = join(work, "files", name);
        if (!SAFE_NAME.test(name) || !existsSync(from) || !lstatSync(from).isFile()) { report.skipped++; continue; }
        const storage = `${crypto.randomUUID()}${extname(name)}`;
        if (!insert(db, "files", { ...f, user_id: memberId, folder_id: myFolder(f.folder_id), storage })) { report.skipped++; continue; }
        blobs.push([from, join(appDir, "files", storage)]);
        report.files++;
      }

      for (const name of ["life_facts", "domain_briefs", "domain_proposals", "domain_mail", "domain_seen", "mail_sender_rules"]) {
        for (const row of table(name)) {
          if (insert(db, name, { ...row, member_id: memberId })) report.rows++;
          else report.skipped++;
        }
      }
    })();

    for (const [from, to] of blobs) { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); }

    const images = join(work, "images");
    for (const name of existsSync(images) ? readdirSync(images) : []) {
      const from = join(images, name);
      const to = join(appDir, "images", name);
      if (!SAFE_NAME.test(name) || !lstatSync(from).isFile() || existsSync(to)) continue;
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      report.images++;
    }

    // The data-api databases this household has.
    const dataDir = join(work, "data");
    for (const path of dataDbPaths()) {
      const dir = join(dataDir, basename(path, ".db"));
      if (existsSync(dir) && statSync(dir).isDirectory()) {
        try { importDataDb(path, dir, memberId, report); } catch (e: any) {
          console.warn(`[member-archive] import into ${basename(path)}: ${e?.message ?? e}`);
        }
      }
    }

    const garden = join(work, "garden");
    if (existsSync(garden) && lstatSync(garden).isDirectory() && SAFE_NAME.test(target.username)) {
      const root = join(gardensRoot(), target.username);
      if (resolve(root).startsWith(resolve(gardensRoot()) + sep)) {
        const written = importGarden(garden, root);
        report.notes = written.filter((f) => /\.(md|mdx)$/.test(f)).length;
        if (written.length) {
          autoCommit({ root, username: target.username }, written, `Import: ${written.length} file(s) from a member archive`);
          indexGardenPaths(memberId, written);
        }
      }
    }
    return { manifest, report };
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch {}
  }
}
