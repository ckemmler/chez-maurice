import { Database } from "bun:sqlite";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getMauriceDbPath } from "../lib/config";

export interface BookMetadata {
  id: number;
  title: string;
  authors: string[];
  tags: string[];
  formats: string[];
  series: string | null;
  description: string | null;
  bookPath: string;
}

export interface ChapterInfo {
  index: number;
  title: string;
  slug: string;
  wordCount: number;
  hasSummary: boolean;
  summaryWordCount: number;
}

// The Calibre library root is a single globally-shared library, configurable
// from the web admin UI (persisted in maurice.db `calibre_libraries`, the
// admin account's default row). We resolve it from there so an admin edit takes
// effect without a redeploy; env vars remain the fallback for first-run / tests.
const ENV_LIBRARY_PATH =
  process.env.CALIBRE_LIBRARY_PATH ?? `${process.env.HOME || "."}/Calibre Library`;

// Warn once per distinct cause: a latching boolean would hide a later, different
// failure, and silence is what hid the admin setting being ignored in the first
// place. Both fallback paths below must say something.
const warnedCauses = new Set<string>();
function warnFallback(cause: string): void {
  if (warnedCauses.has(cause)) return;
  warnedCauses.add(cause);
  console.warn(`[calibre] ${cause}; falling back to library root ${ENV_LIBRARY_PATH}`);
}

function resolveLibraryRoot(): string {
  try {
    const meta = new Database(getMauriceDbPath(), { readonly: true });
    try {
      const row = meta
        .query(
          `SELECT cl.library_root AS root
             FROM calibre_libraries cl
             JOIN users u ON u.id = cl.account_id
            WHERE cl.is_default = 1 AND u.role = 'admin'
         ORDER BY cl.created_at LIMIT 1`,
        )
        .get() as { root: string } | undefined;
      if (row?.root) return row.root;
      // Opened fine but nothing configured: no default library for an admin
      // account. Silent here would serve an empty library with no explanation.
      warnFallback(`no default Calibre library configured for an admin account in ${getMauriceDbPath()}`);
    } finally {
      meta.close();
    }
  } catch (err) {
    // maurice.db unavailable (e.g. tests) — fall through to env.
    warnFallback(`could not read library root from ${getMauriceDbPath()} (${err})`);
  }
  return ENV_LIBRARY_PATH;
}

// Resolving opens maurice.db, so cache the answer — re-resolving per query would
// reopen the main DB on every Calibre read. invalidateLibraryRoot() makes an
// in-process admin edit take effect at once; the TTL bounds staleness when the row
// changes out of process (the Python Calibre MCP tools share this table).
const ROOT_TTL_MS = 5_000;
let cachedRoot: string | null = null;
let cachedRootAt = 0;

/** The library root every read and write path must agree on. */
export function getLibraryRoot(): string {
  const now = Date.now();
  if (cachedRoot === null || now - cachedRootAt >= ROOT_TTL_MS) {
    cachedRoot = resolveLibraryRoot();
    cachedRootAt = now;
  }
  return cachedRoot;
}

/** Drop the cached root so the next call re-reads it. Call after writing library_root. */
export function invalidateLibraryRoot(): void {
  cachedRoot = null;
}

let db: Database | null = null;
// Which root `db` is open against — distinct from cachedRoot, which caches
// resolution. Conflating the two is what made the old refresh rule unreadable.
let openedRoot: string | null = null;

function getDb(): Database {
  const root = getLibraryRoot();
  if (!db || openedRoot !== root) {
    db?.close();
    openedRoot = root;
    const dbPath = process.env.CALIBRE_DB_PATH ?? path.join(root, "metadata.db");
    db = new Database(dbPath, { readonly: true });
  }
  return db;
}

function getBookFormats(bookId: number): string[] {
  const stmt = getDb().query("SELECT format FROM data WHERE book = ? ORDER BY format");
  const rows = stmt.all(bookId) as Array<{ format: string }>;
  return rows.map((r) => r.format.toUpperCase());
}

function getBookRecord(bookId: number): BookMetadata | null {
  const stmt = getDb().query(
    `
      SELECT
        b.id,
        b.title,
        b.path,
        GROUP_CONCAT(a.name, ',') AS authors,
        GROUP_CONCAT(t.name, ',') AS tags,
        s.name AS series,
        c.text AS description
      FROM books b
      LEFT JOIN books_authors_link bal ON bal.book = b.id
      LEFT JOIN authors a ON a.id = bal.author
      LEFT JOIN books_tags_link btl ON b.id = btl.book
      LEFT JOIN tags t ON t.id = btl.tag
      LEFT JOIN books_series_link bsl ON b.id = bsl.book
      LEFT JOIN series s ON s.id = bsl.series
      LEFT JOIN comments c ON c.book = b.id
      WHERE b.id = ?
      GROUP BY b.id
    `,
  );

  const row = stmt.get(bookId) as
    | {
        id: number;
        title: string;
        path: string;
        authors: string | null;
        tags: string | null;
        series: string | null;
        description: string | null;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    title: row.title,
    bookPath: row.path,
    authors: row.authors ? row.authors.split(",") : [],
    tags: row.tags ? row.tags.split(",") : [],
    formats: getBookFormats(row.id),
    series: row.series ?? null,
    description: row.description ?? null,
  };
}

export function listBooks(): BookMetadata[] {
  const stmt = getDb().query(
    `
      SELECT
        b.id, b.title, b.path,
        (SELECT GROUP_CONCAT(a2.name, ',') FROM books_authors_link bal2 JOIN authors a2 ON a2.id = bal2.author WHERE bal2.book = b.id) AS authors,
        (SELECT GROUP_CONCAT(t2.name, ',') FROM books_tags_link btl2 JOIN tags t2 ON t2.id = btl2.tag WHERE btl2.book = b.id) AS tags,
        s.name AS series,
        c.text AS description
      FROM books b
      LEFT JOIN books_series_link bsl ON b.id = bsl.book
      LEFT JOIN series s ON s.id = bsl.series
      LEFT JOIN comments c ON c.book = b.id
      ORDER BY b.sort
    `,
  );

  const rows = stmt.all() as Array<{
    id: number;
    title: string;
    path: string;
    authors: string | null;
    tags: string | null;
    series: string | null;
    description: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    bookPath: row.path,
    authors: row.authors ? row.authors.split(",") : [],
    tags: row.tags ? row.tags.split(",") : [],
    formats: getBookFormats(row.id),
    series: row.series ?? null,
    description: row.description ?? null,
  }));
}

const INDEX_STATE_DB =
  process.env.CORPUS_INDEX_STATE_DB ??
  path.resolve(process.cwd(), "../tools/corpus/data/index_state.db");

let indexDb: Database | null = null;

function getIndexDb(): Database | null {
  if (indexDb) return indexDb;
  try {
    indexDb = new Database(INDEX_STATE_DB, { readonly: true });
    return indexDb;
  } catch {
    return null;
  }
}

function countIndexedSummaries(summaryDir: string, summaryFiles: string[]): number {
  const db = getIndexDb();
  if (!db || summaryFiles.length === 0) return 0;
  const placeholders = summaryFiles.map(() => "?").join(",");
  const paths = summaryFiles.map((f) => path.join(summaryDir, f));
  const stmt = db.query(`SELECT COUNT(*) as cnt FROM file_hashes WHERE path IN (${placeholders})`);
  const row = stmt.get(...paths) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

export async function getChapterStats(bookPath: string): Promise<{ chapters: number; summarized: number; indexed: number }> {
  const bookDir = path.join(getLibraryRoot(), bookPath);
  const chapterDir = path.join(bookDir, "chapters");
  const summaryDir = path.join(bookDir, "chapter_summaries");

  let chapters = 0;
  let summarized = 0;
  let indexed = 0;
  let summaryFiles: string[] = [];

  try {
    const files = await fs.readdir(chapterDir);
    chapters = files.filter((f) => f.endsWith(".txt") && !f.includes(".summary")).length;
  } catch {
    return { chapters: 0, summarized: 0, indexed: 0 };
  }

  try {
    const files = await fs.readdir(summaryDir);
    summaryFiles = files.filter((f) => f.endsWith(".summary.txt"));
    summarized = summaryFiles.length;
  } catch {
    // no summaries dir
  }

  indexed = countIndexedSummaries(summaryDir, summaryFiles);

  return { chapters, summarized, indexed };
}

export async function getBookMetadata(bookId: number): Promise<BookMetadata | null> {
  return getBookRecord(bookId);
}

/** Absolute path to a book's Calibre cover image, or null if it has none. */
export async function getCoverFile(bookId: number): Promise<string | null> {
  const meta = await getBookMetadata(bookId);
  if (!meta) return null;
  const p = path.join(getLibraryRoot(), meta.bookPath, "cover.jpg");
  try {
    await fs.access(p);
    return p;
  } catch {
    return null;
  }
}

export function searchBooksByTags(tags: string[]): BookMetadata[] {
  if (!tags.length) return [];

  const likeConditions = tags.map(() => "LOWER(t.name) LIKE ?").join(" OR ");
  const stmt = getDb().query(
    `
      SELECT DISTINCT b.id, b.title, b.path,
        (SELECT GROUP_CONCAT(a2.name, ',') FROM books_authors_link bal2 JOIN authors a2 ON a2.id = bal2.author WHERE bal2.book = b.id) AS authors,
        (SELECT GROUP_CONCAT(t2.name, ',') FROM books_tags_link btl2 JOIN tags t2 ON t2.id = btl2.tag WHERE btl2.book = b.id) AS tags,
        s.name AS series,
        c.text AS description
      FROM books b
      JOIN books_tags_link btl ON b.id = btl.book
      JOIN tags t ON t.id = btl.tag
      LEFT JOIN books_series_link bsl ON b.id = bsl.book
      LEFT JOIN series s ON s.id = bsl.series
      LEFT JOIN comments c ON c.book = b.id
      WHERE ${likeConditions}
      ORDER BY b.title
    `,
  );

  const rows = stmt.all(...tags.map((t) => `%${t.toLowerCase().trim()}%`)) as Array<{
    id: number;
    title: string;
    path: string;
    authors: string | null;
    tags: string | null;
    series: string | null;
    description: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    bookPath: row.path,
    authors: row.authors ? row.authors.split(",") : [],
    tags: row.tags ? row.tags.split(",") : [],
    formats: getBookFormats(row.id),
    series: row.series ?? null,
    description: row.description ?? null,
  }));
}

function chapterTitleFromFilename(filename: string): string {
  const name = filename.replace(/\.txt$/i, "");
  return name.replace(/^\d+[\-_]?/, "").replace(/[_-]/g, " ").trim() || name;
}

function parseChapterIndex(filename: string, fallback: number): number {
  const match = filename.match(/^(\d{1,4})/);
  if (!match) {
    return fallback;
  }
  const num = parseInt(match[1], 10);
  return Number.isFinite(num) ? num - 1 : fallback;
}

async function fileExists(target: string) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function loadChapterEntries(book: BookMetadata) {
  const bookDir = path.join(getLibraryRoot(), book.bookPath);
  const chapterDir = path.join(bookDir, "chapters");
  const summaryDir = path.join(bookDir, "chapter_summaries");

  const entries: Array<{
    index: number;
    filename: string;
    chapterPath: string;
    summaryPath: string;
    wordCount: number;
    hasSummary: boolean;
    title: string;
  }> = [];

  try {
    const files = await fs.readdir(chapterDir);
    const textFiles = files.filter((file) => file.toLowerCase().endsWith(".txt"));
    const sorted = textFiles.sort((a, b) => a.localeCompare(b));

    for (let pos = 0; pos < sorted.length; pos += 1) {
      const file = sorted[pos];
      if (file.includes(".summary")) {
        continue;
      }
      const chapterPath = path.join(chapterDir, file);
      const summaryPath = path.join(
        summaryDir,
        `${path.parse(file).name}.summary.txt`,
      );
      const content = await fs.readFile(chapterPath, "utf-8");
      const hasSummary = await fileExists(summaryPath);
      let summaryWordCount = 0;
      if (hasSummary) {
        try {
          const sumContent = await fs.readFile(summaryPath, "utf-8");
          summaryWordCount = sumContent.trim() ? sumContent.trim().split(/\s+/).length : 0;
        } catch { /* ignore */ }
      }
      entries.push({
        index: parseChapterIndex(file, pos),
        filename: file,
        chapterPath,
        summaryPath,
        wordCount: content.trim() ? content.trim().split(/\s+/).length : 0,
        hasSummary,
        summaryWordCount,
        title: chapterTitleFromFilename(file),
      });
    }
  } catch {
    return [];
  }

  return entries;
}

export async function listChapters(bookId: number): Promise<ChapterInfo[] | null> {
  const book = getBookRecord(bookId);
  if (!book) {
    return null;
  }
  const entries = await loadChapterEntries(book);
  return entries
    .sort((a, b) => a.index - b.index)
    .map((entry) => ({
      index: entry.index,
      title: entry.title,
      slug: path.parse(entry.filename).name,
      wordCount: entry.wordCount,
      hasSummary: entry.hasSummary,
      summaryWordCount: entry.summaryWordCount,
    }));
}

export async function getChapterContent(bookId: number, chapterIndex: number) {
  const book = getBookRecord(bookId);
  if (!book) {
    return null;
  }
  const entries = await loadChapterEntries(book);
  const chapter = entries.find((entry) => entry.index === chapterIndex);
  if (!chapter) {
    return null;
  }
  const text = await fs.readFile(chapter.chapterPath, "utf-8");
  return { title: chapter.title, text, wordCount: chapter.wordCount };
}

export async function getChapterBySlug(bookId: number, slug: string) {
  const book = getBookRecord(bookId);
  if (!book) return null;
  const entries = await loadChapterEntries(book);
  const chapter = entries.find((e) => path.parse(e.filename).name === slug);
  if (!chapter) return null;
  const text = await fs.readFile(chapter.chapterPath, "utf-8");
  return { title: chapter.title, text, wordCount: chapter.wordCount };
}

export async function getChapterSummaryBySlug(bookId: number, slug: string) {
  const book = getBookRecord(bookId);
  if (!book) return null;
  const entries = await loadChapterEntries(book);
  const chapter = entries.find((e) => path.parse(e.filename).name === slug);
  if (!chapter) return null;
  if (!chapter.hasSummary) return { exists: false };
  const summary = await fs.readFile(chapter.summaryPath, "utf-8");
  return { exists: true, title: chapter.title, summary };
}

export async function getChapterSummaryText(bookId: number, chapterIndex: number) {
  const book = getBookRecord(bookId);
  if (!book) {
    return null;
  }
  const entries = await loadChapterEntries(book);
  const chapter = entries.find((entry) => entry.index === chapterIndex);
  if (!chapter) {
    return null;
  }
  if (!chapter.hasSummary) {
    return { exists: false };
  }
  const summary = await fs.readFile(chapter.summaryPath, "utf-8");
  return { exists: true, title: chapter.title, summary };
}
