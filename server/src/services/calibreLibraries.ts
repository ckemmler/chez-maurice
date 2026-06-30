import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { join } from "path";
import db from "../db";

// Per-account Calibre library configuration. One default library per account
// for now (the table allows more later). The Python Calibre MCP tools read the
// same table from maurice.db to scope every call to the caller's library.

export interface CalibreLibrary {
  id: string;
  account_id: string;
  label: string;
  library_root: string;
  is_default: number;
  created_at: string;
}

export interface LibraryValidation {
  ok: boolean;
  error?: string;
  bookCount?: number;
}

/** Validate that <root>/metadata.db exists and is a readable Calibre schema. */
export function validateLibraryRoot(root: string): LibraryValidation {
  const trimmed = (root || "").trim();
  if (!trimmed) return { ok: false, error: "Library root is required." };
  const metaPath = join(trimmed, "metadata.db");
  if (!existsSync(metaPath)) {
    return {
      ok: false,
      error: `No metadata.db at ${metaPath} — point at the Calibre library root directory (the folder that contains metadata.db), not the file itself.`,
    };
  }
  try {
    const lib = new Database(metaPath, { readonly: true });
    try {
      // Calibre schema sanity: the books table must exist and be queryable.
      const row = lib.query(`SELECT COUNT(*) AS n FROM books`).get() as { n: number };
      return { ok: true, bookCount: row.n };
    } finally {
      lib.close();
    }
  } catch (e: any) {
    return { ok: false, error: `metadata.db is not a readable Calibre database: ${e?.message ?? e}` };
  }
}

export function getDefaultLibrary(accountId: string): CalibreLibrary | null {
  return db
    .query(
      `SELECT * FROM calibre_libraries
       WHERE account_id = ? AND is_default = 1
       ORDER BY created_at LIMIT 1`,
    )
    .get(accountId) as CalibreLibrary | null;
}

export function listLibraries(accountId: string): CalibreLibrary[] {
  return db
    .query(`SELECT * FROM calibre_libraries WHERE account_id = ? ORDER BY created_at`)
    .all(accountId) as CalibreLibrary[];
}

/** Validate then upsert the account's default library. Throws on invalid root. */
export function setDefaultLibrary(
  accountId: string,
  libraryRoot: string,
  label = "Library",
): CalibreLibrary {
  const root = (libraryRoot || "").trim().replace(/\/+$/, "");
  const v = validateLibraryRoot(root);
  if (!v.ok) throw new Error(v.error || "Invalid library");

  const existing = getDefaultLibrary(accountId);
  if (existing) {
    db.run(`UPDATE calibre_libraries SET library_root = ?, label = ? WHERE id = ?`, [
      root,
      label,
      existing.id,
    ]);
  } else {
    db.run(
      `INSERT INTO calibre_libraries (id, account_id, label, library_root, is_default)
       VALUES (?, ?, ?, ?, 1)`,
      [crypto.randomUUID(), accountId, label, root],
    );
  }
  return getDefaultLibrary(accountId)!;
}

export function removeLibrary(accountId: string, id: string): boolean {
  return db.run(`DELETE FROM calibre_libraries WHERE id = ? AND account_id = ?`, [id, accountId])
    .changes > 0;
}
