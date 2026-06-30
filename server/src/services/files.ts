// Per-user file library: nestable folders + files stored on disk under
// <dataDir>/files/<id><ext>. Text files get a rough token estimate (≈4 chars
// per token); binaries (pdf/img/…) are uncounted. Owned per user_id.
import { join, extname } from "path";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from "fs";
import db, { dataDir } from "../db";

export const filesDir = join(dataDir, "files");
mkdirSync(filesDir, { recursive: true });

const QUOTA_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB

export function kindForName(name: string): string {
  const ext = extname(name).toLowerCase().replace(".", "");
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tiff", "bmp", "svg"].includes(ext)) return "img";
  if (["md", "markdown", "txt", "text", "csv", "json", "yaml", "yml", "log", "rtf"].includes(ext)) return "text";
  return "file";
}

function estimateTokens(buffer: Buffer): number {
  return Math.ceil(buffer.toString("utf8").length / 4);
}

export interface FolderRow { id: string; parent_id: string | null; name: string; created_at: string; }
export interface FileRow {
  id: string; folder_id: string | null; name: string; kind: string;
  size_bytes: number; token_estimate: number | null; created_at: string;
}

/** The whole library for a user: flat folders + files (the client nests them) + a summary. */
export function listLibrary(userId: string) {
  const folders = db.query(`SELECT id, parent_id, name, created_at FROM folders WHERE user_id = ? ORDER BY name`).all(userId) as FolderRow[];
  const files = db.query(`SELECT id, folder_id, name, kind, size_bytes, token_estimate, created_at FROM files WHERE user_id = ? ORDER BY name`).all(userId) as FileRow[];
  const size = files.reduce((s, f) => s + (f.size_bytes || 0), 0);
  return { folders, files, summary: { count: files.length, size_bytes: size, quota_bytes: QUOTA_BYTES } };
}

export function createFolder(userId: string, parentId: string | null, name: string): FolderRow {
  const id = crypto.randomUUID();
  db.run(`INSERT INTO folders (id, user_id, parent_id, name) VALUES (?, ?, ?, ?)`, [id, userId, parentId, name]);
  return db.query(`SELECT id, parent_id, name, created_at FROM folders WHERE id = ?`).get(id) as FolderRow;
}

export function updateFolder(userId: string, id: string, patch: { name?: string; parent_id?: string | null }): FolderRow | null {
  const sets: string[] = []; const params: any[] = [];
  if (patch.name !== undefined) { sets.push("name = ?"); params.push(patch.name); }
  if (patch.parent_id !== undefined) { sets.push("parent_id = ?"); params.push(patch.parent_id); }
  if (!sets.length) return null;
  params.push(id, userId);
  db.run(`UPDATE folders SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, params);
  return db.query(`SELECT id, parent_id, name, created_at FROM folders WHERE id = ? AND user_id = ?`).get(id, userId) as FolderRow | null;
}

/** Delete a folder, its descendant folders, and all their files (storage + rows). */
export function deleteFolder(userId: string, id: string): void {
  const ids = [id];
  for (let i = 0; i < ids.length; i++) {
    const kids = db.query(`SELECT id FROM folders WHERE parent_id = ? AND user_id = ?`).all(ids[i], userId) as { id: string }[];
    kids.forEach((k) => ids.push(k.id));
  }
  for (const fid of ids) {
    const files = db.query(`SELECT storage FROM files WHERE folder_id = ? AND user_id = ?`).all(fid, userId) as { storage: string }[];
    files.forEach((f) => { try { unlinkSync(join(filesDir, f.storage)); } catch {} });
  }
  db.run(`DELETE FROM folders WHERE id = ? AND user_id = ?`, [id, userId]); // ON DELETE CASCADE removes nested folders + files rows
}

export function saveFile(userId: string, folderId: string | null, name: string, buffer: Buffer): FileRow {
  const id = crypto.randomUUID();
  const storage = `${id}${extname(name)}`;
  writeFileSync(join(filesDir, storage), buffer);
  const kind = kindForName(name);
  const tokens = kind === "text" ? estimateTokens(buffer) : null;
  db.run(
    `INSERT INTO files (id, user_id, folder_id, name, kind, size_bytes, storage, token_estimate) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, folderId, name, kind, buffer.length, storage, tokens],
  );
  return db.query(`SELECT id, folder_id, name, kind, size_bytes, token_estimate, created_at FROM files WHERE id = ?`).get(id) as FileRow;
}

export function updateFile(userId: string, id: string, patch: { name?: string; folder_id?: string | null }): FileRow | null {
  const sets: string[] = []; const params: any[] = [];
  if (patch.name !== undefined) { sets.push("name = ?"); params.push(patch.name); }
  if (patch.folder_id !== undefined) { sets.push("folder_id = ?"); params.push(patch.folder_id); }
  if (!sets.length) return null;
  params.push(id, userId);
  db.run(`UPDATE files SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, params);
  return db.query(`SELECT id, folder_id, name, kind, size_bytes, token_estimate, created_at FROM files WHERE id = ? AND user_id = ?`).get(id, userId) as FileRow | null;
}

export function deleteFile(userId: string, id: string): void {
  const row = db.query(`SELECT storage FROM files WHERE id = ? AND user_id = ?`).get(id, userId) as { storage: string } | undefined;
  if (!row) return;
  try { unlinkSync(join(filesDir, row.storage)); } catch {}
  db.run(`DELETE FROM files WHERE id = ? AND user_id = ?`, [id, userId]);
}

/** A file's bytes + name for serving/attaching (owner only). */
export function readFile(userId: string, id: string): { name: string; kind: string; buffer: Buffer } | null {
  const row = db.query(`SELECT name, kind, storage FROM files WHERE id = ? AND user_id = ?`).get(id, userId) as { name: string; kind: string; storage: string } | undefined;
  if (!row) return null;
  const path = join(filesDir, row.storage);
  if (!existsSync(path)) return null;
  return { name: row.name, kind: row.kind, buffer: readFileSync(path) };
}
