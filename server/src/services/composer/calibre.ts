import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { getDefaultLibrary } from "../calibreLibraries";

// Bun-side, read-only Calibre reader for the composer. Resolves the account's
// library (Phase A calibre_libraries), opens metadata.db read-only, and reads
// the on-disk chapters/ + chapter_summaries/ that the Python tools produced.
// Separate from the Python MCP tools (which serve Maurice's chat) because the
// composer needs differently-shaped reads (coverage, classification, weights).

export interface BookHit {
  id: number;
  title: string;
  authors: string[];
  path: string;
}

export interface BookCoverage {
  chaptersExtracted: number;
  chaptersWithSummary: number;
}

export function libraryRootFor(memberId: string): string | null {
  return getDefaultLibrary(memberId)?.library_root ?? null;
}

function openMeta(root: string): Database | null {
  const meta = path.join(root, "metadata.db");
  if (!fs.existsSync(meta)) return null;
  try {
    return new Database(meta, { readonly: true });
  } catch {
    return null;
  }
}

/** Search the account's library by title/author. Empty query → recent-ish list. */
export function searchBooks(memberId: string, q: string, limit = 20): BookHit[] {
  const root = libraryRootFor(memberId);
  if (!root) return [];
  const db = openMeta(root);
  if (!db) return [];
  try {
    const like = `%${q.trim()}%`;
    const filtered = q.trim().length > 0;
    const rows = db
      .query(
        `SELECT b.id, b.title, b.path,
                GROUP_CONCAT(DISTINCT a.name) AS authors
         FROM books b
         LEFT JOIN books_authors_link bal ON b.id = bal.book
         LEFT JOIN authors a ON bal.author = a.id
         ${filtered ? "WHERE b.title LIKE ? COLLATE NOCASE OR a.name LIKE ? COLLATE NOCASE" : ""}
         GROUP BY b.id
         ORDER BY b.title COLLATE NOCASE
         LIMIT ?`,
      )
      .all(...(filtered ? [like, like, limit] : [limit])) as Array<{
      id: number;
      title: string;
      path: string;
      authors: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      path: r.path,
      authors: r.authors ? r.authors.split(",") : [],
    }));
  } finally {
    db.close();
  }
}

// ── B3: chapter listing + front/back-matter classification ────────────────
//
// section_type ∈ front_matter | body | back_matter. Reuses the kind of signal
// the Python skip logic encodes (name patterns + tiny size) and adds position:
// a leading run of front/tiny chapters is front_matter; anything matching a
// hard back-matter pattern (Notes 1…, References, Index, Acknowledgements, …)
// OR sitting after the last substantial body chapter is back_matter. Front/back
// are `hidden` (out of "all"); only an explicit Select tick can pull one in.

const FRONT = [
  /^none$/, /^cover/, /^landing\s*page/, /^praise/, /^half[\s-]*title/, /^title\s*page/,
  /^frontispiece/, /^copyright/, /^colophon/, /^dedication/, /^epigraph/, /^contents?$/,
  /^table\s+of\s+contents/, /^toc$/, /^list\s+of\s+(figures|tables|illustrations|maps|plates)/,
  /^foreword/, /^preface/, /^also\s+by/, /^by\s+the\s+same\s+author/, /^a\s+note\s+(on|about|to)\b/,
  /^maps?$/,
];
const BACK = [
  /^notes?(\s+\d+)?$/, /^end\s*notes/, /^references?$/, /^bibliography/, /^works\s+cited/,
  /^further\s+reading/, /^index(es)?$/, /^glossary/, /^appendix/, /^appendices/, /^acknowledg/,
  /^about\s+the\s+(author|publisher)/, /^credits/, /^permissions/, /^afterword/,
  /^discussion\s+questions/, /^reading\s+group/,
];
const TINY = 1200; // bytes — front/back stubs (dividers, blanks)

function cleanName(stem: string): string {
  return stem
    .replace(/^\d+[-_]/, "") // strip the NNNN- index prefix
    .replace(/[_:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
const hits = (name: string, pats: RegExp[]) => pats.some((p) => p.test(name));

export type SectionType = "front_matter" | "body" | "back_matter";

export function classifyChapters(
  chapters: { name: string; size: number }[],
): SectionType[] {
  const n = chapters.length;
  const type: SectionType[] = new Array(n).fill("body");
  const front = chapters.map((c) => hits(c.name, FRONT));
  const back = chapters.map((c) => hits(c.name, BACK));
  const tiny = chapters.map((c) => c.size < TINY);

  // leading front-matter run
  let i = 0;
  while (i < n && !back[i] && (front[i] || tiny[i])) {
    type[i] = "front_matter";
    i++;
  }
  // last substantial body chapter (not front-run, not back-pattern, not tiny)
  let lastBody = -1;
  for (let k = 0; k < n; k++) {
    if (type[k] !== "front_matter" && !back[k] && !tiny[k] && !front[k]) lastBody = k;
  }
  // back-matter: any hard back pattern anywhere, or anything after the last body
  for (let k = 0; k < n; k++) {
    if (back[k] || (lastBody >= 0 && k > lastBody)) type[k] = "back_matter";
  }
  return type;
}

export interface ChapterInfo {
  index: number;
  ref: string; // filename stem — the stable chapter id
  name: string;
  section_type: SectionType;
  hidden: boolean;
  word_count: number;
  has_summary: boolean;
  summary_tok: number;
  full_tok: number;
}

export interface BookChapters {
  id: number;
  title: string;
  authors: string[];
  chapters: ChapterInfo[];
  visible_count: number;
  coverage: { summarized: number; total: number }; // over visible (body) chapters
}

/** Classified chapter listing for one book. Stats files only (no content read). */
export function listChapters(memberId: string, bookId: number): BookChapters | null {
  const root = libraryRootFor(memberId);
  if (!root) return null;
  const db = openMeta(root);
  if (!db) return null;
  let bookPath: string, title: string, authors: string[];
  try {
    const row = db
      .query(
        `SELECT b.title, b.path, GROUP_CONCAT(DISTINCT a.name) AS authors
         FROM books b LEFT JOIN books_authors_link bal ON b.id = bal.book
         LEFT JOIN authors a ON bal.author = a.id WHERE b.id = ? GROUP BY b.id`,
      )
      .get(bookId) as { title: string; path: string; authors: string | null } | null;
    if (!row) return null;
    bookPath = row.path;
    title = row.title;
    authors = row.authors ? row.authors.split(",") : [];
  } finally {
    db.close();
  }

  const base = path.join(root, bookPath);
  const chaptersDir = path.join(base, "chapters");
  const summariesDir = path.join(base, "chapter_summaries");
  let files: string[];
  try {
    files = fs.readdirSync(chaptersDir).filter((f) => f.endsWith(".txt")).sort();
  } catch {
    files = [];
  }

  const raw = files.map((f) => {
    const stem = f.replace(/\.txt$/, "");
    let size = 0;
    try {
      size = fs.statSync(path.join(chaptersDir, f)).size;
    } catch {}
    const summaryPath = path.join(summariesDir, `${stem}.summary.txt`);
    let summarySize = 0;
    let hasSummary = false;
    try {
      summarySize = fs.statSync(summaryPath).size;
      hasSummary = true;
    } catch {}
    return { stem, name: cleanName(stem), size, hasSummary, summarySize };
  });

  const types = classifyChapters(raw.map((r) => ({ name: r.name, size: r.size })));

  const chapters: ChapterInfo[] = raw.map((r, i) => ({
    index: i,
    ref: r.stem,
    name: r.name,
    section_type: types[i],
    hidden: types[i] !== "body",
    word_count: Math.round(r.size / 6),
    has_summary: r.hasSummary,
    summary_tok: Math.ceil(r.summarySize / 4),
    full_tok: Math.ceil(r.size / 4),
  }));

  const visible = chapters.filter((c) => !c.hidden);
  return {
    id: bookId,
    title,
    authors,
    chapters,
    visible_count: visible.length,
    coverage: { summarized: visible.filter((c) => c.has_summary).length, total: visible.length },
  };
}

/** Read chapter texts (summary or full) by ref, for context resolution. */
export function readChapters(
  memberId: string,
  bookId: number,
  refs: string[],
  rep: "summary" | "full",
): Array<{ ref: string; text: string }> {
  const root = libraryRootFor(memberId);
  if (!root) return [];
  const db = openMeta(root);
  if (!db) return [];
  let bookPath: string;
  try {
    const row = db.query(`SELECT path FROM books WHERE id = ?`).get(bookId) as { path: string } | null;
    if (!row) return [];
    bookPath = row.path;
  } finally {
    db.close();
  }
  const dir = path.join(root, bookPath, rep === "full" ? "chapters" : "chapter_summaries");
  const suffix = rep === "full" ? ".txt" : ".summary.txt";
  return refs.map((ref) => {
    let text = "";
    try {
      text = fs.readFileSync(path.join(dir, ref + suffix), "utf8");
    } catch {}
    return { ref, text };
  });
}

/** Summary coverage for one book, read from its on-disk artifact dirs. */
export function bookCoverage(root: string, bookPath: string): BookCoverage {
  const base = path.join(root, bookPath);
  const count = (dir: string, suffix: string) => {
    try {
      return fs.readdirSync(path.join(base, dir)).filter((f) => f.endsWith(suffix)).length;
    } catch {
      return 0;
    }
  };
  return {
    chaptersExtracted: count("chapters", ".txt"),
    chaptersWithSummary: count("chapter_summaries", ".summary.txt"),
  };
}
