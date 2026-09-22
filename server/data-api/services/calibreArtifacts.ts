/**
 * Where Maurice's per-book artifacts live — `chapters/` and `chapter_summaries/`.
 *
 * They used to be written *inside* the Calibre library, next to the book files,
 * and found again by `books.path`. That works only as long as nothing else
 * touches the library: Calibre rewrites `path` whenever the title or the author
 * changes, renaming the directory on disk, and every extracted chapter silently
 * stops being found. A hosted install makes that routine rather than rare — the
 * point of serving the library over the web is that people edit metadata there.
 *
 * So artifacts move out of the library, under the data dir, keyed by
 * `books.uuid` — the one identifier Calibre never rewrites:
 *
 *     <dataDir>/calibre/artifacts/<uuid>-<title>/chapters/
 *                                               /chapter_summaries/
 *
 * The title is decoration, not identity. It is in the path because corpus reads
 * a chunk's book title from its directory name (`extract_from_path` in
 * corpus.yaml is corpus's only metadata source), and it is never renamed
 * afterwards: a stale label costs a slightly wrong heading in a search result,
 * a rename costs a full reindex of the book. Resolution matches on the uuid
 * prefix, so a directory whose label has gone stale is still found.
 *
 * ## The legacy fallback
 *
 * A library that predates this holds its artifacts at the old location. Rather
 * than make everyone run a migration before chapters reappear, a book with
 * artifacts in the library and none under the data dir keeps using the old
 * location — for reads *and* writes, so a half-summarized book never ends up
 * with its chapters in one place and its summaries in the other. Migrating is
 * what moves it across, once, for good:
 *
 *     bun run scripts/migrate-calibre-artifacts.ts
 */

import { readdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { getDataDir } from "../lib/config";

export const CHAPTERS_DIR = "chapters";
export const SUMMARIES_DIR = "chapter_summaries";

/** Mirrored as `_MAX_TITLE_SEGMENT` in maurice-tools/calibre/artifacts.py. */
const MAX_TITLE_SEGMENT = 80;

/** Root of the artifact tree. Overridable for tests and for an install that
 *  wants it elsewhere; otherwise it sits under the configured data dir. */
export function artifactsRoot(): string {
  return (
    process.env.MAURICE_CALIBRE_ARTIFACTS_DIR ??
    path.join(getDataDir(), "calibre", "artifacts")
  );
}

/** A book title reduced to something safe as a single path segment. Separators
 *  and control characters are what actually break a path; the length cap keeps
 *  us clear of filesystem limits once the 36-char uuid and a chapter filename
 *  are added on. Trailing dots and spaces are stripped because Windows and some
 *  network filesystems quietly drop them, which would make the directory we
 *  created unfindable by the name we used. */
export function safeTitleSegment(title: string): string {
  // Written as a scan rather than a regex: the characters that have to go are
  // the C0 controls and DEL, and a literal control character in a source file
  // is the kind of thing an editor eats silently.
  const neutralised = Array.from(title || "")
    .map((ch) => {
      const code = ch.codePointAt(0)!;
      const isControl = code < 0x20 || code === 0x7f;
      return isControl || ch === "/" || ch === "\\" ? " " : ch;
    })
    .join("");
  // Truncate by code point, not by UTF-16 unit: `slice` would cut an emoji or
  // any astral character in half, leaving a lone surrogate in a directory name
  // — and would disagree with the Python side, which counts code points. The
  // two implementations must produce byte-identical paths.
  const collapsed = neutralised.replace(/\s+/g, " ").trim();
  const cleaned = Array.from(collapsed)
    .slice(0, MAX_TITLE_SEGMENT)
    .join("")
    .replace(/[. ]+$/, "");
  return cleaned || "sans titre";
}

/** The canonical directory for a book — where a fresh one is created. */
export function canonicalArtifactsDir(uuid: string, title: string): string {
  return path.join(artifactsRoot(), `${uuid}-${safeTitleSegment(title)}`);
}

// Resolving a book whose canonical directory does not exist means listing the
// root, and the callers that matter iterate over an entire library (listBooks →
// bookCoverage per book). Cache the listing for long enough to cover one such
// sweep without holding a view that outlives an extraction run.
const LISTING_TTL_MS = 5_000;
let cachedListing: string[] | null = null;
let cachedListingAt = 0;

function rootListing(): string[] {
  const now = Date.now();
  if (cachedListing === null || now - cachedListingAt >= LISTING_TTL_MS) {
    try {
      cachedListing = readdirSync(artifactsRoot());
    } catch {
      cachedListing = [];
    }
    cachedListingAt = now;
  }
  return cachedListing;
}

/** Drop the cached listing. Call after creating or moving an artifact directory
 *  in-process — the TTL alone would leave a just-migrated book unfindable. */
export function invalidateArtifactsListing(): void {
  cachedListing = null;
}

/** True when a directory holds either artifact kind. An empty directory does
 *  not count: it is what a failed extraction leaves behind, and treating it as
 *  occupied would pin a book to a location that has nothing in it. */
function hasArtifacts(dir: string): boolean {
  return existsSync(path.join(dir, CHAPTERS_DIR)) || existsSync(path.join(dir, SUMMARIES_DIR));
}

export interface ArtifactLookup {
  /** The Calibre library root — only needed to find pre-migration artifacts. */
  libraryRoot: string;
  /** `books.path`, the library-relative directory of the book. */
  bookPath: string;
  uuid: string | null;
  title: string;
}

/**
 * The directory holding this book's artifacts, for reading and for writing.
 *
 * A book with no artifacts anywhere resolves to its canonical directory, which
 * may not exist yet — callers that write must create it.
 */
export function bookArtifactsDir({ libraryRoot, bookPath, uuid, title }: ArtifactLookup): string {
  // No uuid means a hand-built or very old library whose `books` table lacks the
  // column. Nothing stable to key on, so such a library keeps the old layout.
  if (!uuid) return path.join(libraryRoot, bookPath);

  const canonical = canonicalArtifactsDir(uuid, title);
  if (existsSync(canonical)) return canonical;

  // The title changed since the directory was created: match on the uuid, which
  // did not. Prefix only — a uuid is a fixed 36-char form, so `<uuid>-` cannot
  // collide with another book's directory.
  const prefix = `${uuid}-`;
  const existing = rootListing().find((e) => e.startsWith(prefix) || e === uuid);
  if (existing) return path.join(artifactsRoot(), existing);

  // Pre-migration: the library still owns this book's artifacts. Stay there for
  // writes too, so extraction and summarization cannot end up split across the
  // two layouts. `migrate-calibre-artifacts.ts` is what ends this.
  const legacy = path.join(libraryRoot, bookPath);
  if (hasArtifacts(legacy)) return legacy;

  return canonical;
}

// path → { uuid, title }, for the callers that hold neither and would otherwise
// reopen metadata.db per book. Keyed by library root as well, since two members
// can have two libraries in one process.
const identityCache = new Map<string, { uuid: string | null; title: string } | null>();

/** Resolve a book's uuid and title from its library-relative path. */
export function bookIdentity(
  libraryRoot: string,
  bookPath: string,
): { uuid: string | null; title: string } | null {
  const key = JSON.stringify([libraryRoot, bookPath]);
  const hit = identityCache.get(key);
  if (hit !== undefined) return hit;

  let result: { uuid: string | null; title: string } | null = null;
  try {
    const db = new Database(path.join(libraryRoot, "metadata.db"), { readonly: true });
    try {
      // `uuid` is standard Calibre but absent from hand-built libraries, and
      // naming a missing column throws — which would take down every chapter
      // read rather than degrade to the old layout.
      const cols = db.query(`PRAGMA table_info(books)`).all() as Array<{ name: string }>;
      const hasUuid = cols.some((c) => c.name === "uuid");
      const row = db
        .query(`SELECT ${hasUuid ? "uuid" : "NULL AS uuid"}, title FROM books WHERE path = ?`)
        .get(bookPath) as { uuid: string | null; title: string } | undefined;
      if (row) result = { uuid: row.uuid ?? null, title: row.title };
    } finally {
      db.close();
    }
  } catch {
    result = null;
  }

  identityCache.set(key, result);
  return result;
}

/** Drop the identity cache — after a migration, or when the library changes. */
export function invalidateBookIdentities(): void {
  identityCache.clear();
}

/**
 * Read artifact files named by *client-supplied* refs.
 *
 * A chapter ref arrives in a composer request body, and the obvious
 * implementation — `readFileSync(join(dir, ref + suffix))` — lets `../` walk out
 * of the artifact directory and read any file the server can reach. Validating
 * the ref is the fragile answer: separators, encodings, unicode look-alikes and
 * absolute paths all have to be caught, and one miss is the whole bug.
 *
 * So the ref is never joined to a path. The directory is listed, and a ref is
 * served only if the name it asks for is one of the entries that came back —
 * `readdir` yields bare filenames, so no traversal can match one. This is the
 * defence `getChapterBySlug` already uses in the data-api, made reusable.
 *
 * An unknown ref reads as empty text, which is what a missing chapter did
 * before: the caller assembles context and a gap is not worth an error.
 */
export function readArtifactTexts(
  dir: string,
  refs: string[],
  suffix: string,
): Array<{ ref: string; text: string }> {
  let present: Set<string>;
  try {
    present = new Set(readdirSync(dir));
  } catch {
    present = new Set();
  }

  return refs.map((ref) => {
    const filename = `${ref}${suffix}`;
    if (!present.has(filename)) return { ref, text: "" };
    let text = "";
    try {
      text = readFileSync(path.join(dir, filename), "utf8");
    } catch {
      // Listed a moment ago, unreadable now: a concurrent extraction, or a
      // permission problem. Same answer as a missing chapter.
    }
    return { ref, text };
  });
}

/** Convenience for callers holding only a library root and `books.path`. */
export function artifactsDirForBookPath(libraryRoot: string, bookPath: string): string {
  const id = bookIdentity(libraryRoot, bookPath);
  return bookArtifactsDir({
    libraryRoot,
    bookPath,
    uuid: id?.uuid ?? null,
    title: id?.title ?? "",
  });
}
