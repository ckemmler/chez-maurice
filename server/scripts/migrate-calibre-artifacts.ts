/**
 * Move a library's `chapters/` and `chapter_summaries/` out of the Calibre
 * library and under the data dir, keyed by `books.uuid`.
 *
 * Why they had to move is in `data-api/services/calibreArtifacts.ts`: Calibre
 * renames a book's directory whenever its title or author changes, and every
 * extracted chapter stops being found. Until a library is migrated its books
 * keep using the old location — nothing breaks, they are just still exposed to
 * the rename. This ends that, once.
 *
 *   bun run scripts/migrate-calibre-artifacts.ts [--library <root>] [--apply]
 *
 * Without `--apply` it prints what it would move and changes nothing. That is
 * the default because this walks someone's book collection: seeing the plan
 * before it runs is worth one extra command.
 *
 * Safe to re-run: a book already at the new location is skipped, and a
 * destination that exists is never merged into or overwritten — it is reported
 * and left alone, which is the only answer that cannot lose a summary.
 *
 * The corpus indexes chapters and summaries by absolute path, so after this
 * every book looks new to it and is re-embedded once. Point corpus.yaml at the
 * new root (`<dataDir>/calibre/artifacts`) and reindex.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import path from "node:path";
import {
  CHAPTERS_DIR,
  SUMMARIES_DIR,
  artifactsRoot,
  canonicalArtifactsDir,
} from "../data-api/services/calibreArtifacts";
import { getLibraryRoot } from "../data-api/services/calibre";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const libIdx = args.indexOf("--library");
const libraryRoot = libIdx >= 0 ? args[libIdx + 1] : getLibraryRoot();

if (!libraryRoot || !existsSync(path.join(libraryRoot, "metadata.db"))) {
  console.error(`✗ No Calibre library at ${libraryRoot || "(unset)"} — pass --library <root>.`);
  process.exit(1);
}

const db = new Database(path.join(libraryRoot, "metadata.db"), { readonly: true });
const hasUuid = (db.query(`PRAGMA table_info(books)`).all() as Array<{ name: string }>).some(
  (c) => c.name === "uuid",
);
if (!hasUuid) {
  // Without uuid there is no stable key, and moving on `path` alone would
  // reproduce exactly the fragility this migration exists to remove.
  console.error(`✗ ${libraryRoot} has no books.uuid column — nothing stable to key on.`);
  process.exit(1);
}

const books = db
  .query(`SELECT id, uuid, title, path FROM books ORDER BY id`)
  .all() as Array<{ id: number; uuid: string | null; title: string; path: string }>;
db.close();

let moved = 0;
let skipped = 0;
let blocked = 0;

for (const book of books) {
  if (!book.uuid) continue;
  const legacy = path.join(libraryRoot, book.path);
  const dest = canonicalArtifactsDir(book.uuid, book.title);
  const kinds = [CHAPTERS_DIR, SUMMARIES_DIR].filter((k) => existsSync(path.join(legacy, k)));
  if (kinds.length === 0) {
    if (existsSync(dest)) skipped++;
    continue;
  }

  const collisions = kinds.filter((k) => existsSync(path.join(dest, k)));
  if (collisions.length > 0) {
    // Both locations hold the same kind of artifact. Merging directory trees
    // blind is how you lose the newer of two summaries, so this one is for a
    // human.
    console.warn(
      `! ${book.title} (${book.id}): ${collisions.join(", ")} exists at both locations — left alone`,
    );
    blocked++;
    continue;
  }

  console.log(`${apply ? "→" : "would move"} ${book.title} (${book.id}): ${kinds.join(", ")}`);
  console.log(`    ${legacy}`);
  console.log(`  → ${dest}`);

  if (apply) {
    mkdirSync(dest, { recursive: true });
    for (const kind of kinds) {
      renameSync(path.join(legacy, kind), path.join(dest, kind));
    }
    // A book directory that now holds nothing but the book files is fine; one
    // that is empty was ours alone and should not be left behind as litter.
    try {
      if (readdirSync(legacy).length === 0) rmdirSync(legacy);
    } catch {}
  }
  moved++;
}

console.log();
console.log(`library:   ${libraryRoot}`);
console.log(`artifacts: ${artifactsRoot()}`);
console.log(
  apply
    ? `moved ${moved} book(s), ${blocked} left alone, ${skipped} already migrated.`
    : `${moved} book(s) to move, ${blocked} need a decision. Re-run with --apply.`,
);
if (apply && moved > 0) {
  console.log(`\nNext: point corpus.yaml at ${artifactsRoot()} and reindex the book sources.`);
}
