/**
 * The shelf — the garden read the way Carnet shows it: one list of entries of
 * every kind, each with up to three parts.
 *
 *   - the **source**: someone else's words, readable in the app — a Calibre
 *     book, an article's captured text;
 *   - **mine**: the working side — the fiche, its dated notes and résonances,
 *     the fragments Maurice filed, the passages highlighted while reading;
 *   - **shared**: what the member wrote to be read — the body of the card,
 *     a draft until it carries the `public` flag.
 *
 * Nothing is stored for this view. It is read where each part already lives:
 * the markdown for the fiche and the card, life.db for highlights and reading
 * progress, the Calibre library for the books. `gardenEntries.ts` stays the
 * scan of the tree; this file is what a row and a page need on top of it.
 *
 * A card file is not the shared side by existing. Cards are created with the
 * entry's identity (title, cover, rating, date) and often a provider's
 * synopsis as their body; the shared side starts when the member has written
 * something there. See `isWritten`.
 */

import fs from "node:fs";
import path from "node:path";
import db from "../../src/db";
import { getUserPreferences } from "../../src/services/users";
import { getReadingProgress, type ReadingProgress } from "./bookmarks";
import { getChapterStats, listBooks, listChapters, type BookMetadata } from "./calibre";
import { countArticleHighlights, listArticleHighlights } from "./articleHighlights";
import { countHighlights, listHighlights } from "./highlights";
import { fragmentsDir, isOpened, parseFiche, type GardenRef } from "./gardenFiche";
import { listGardenEntries, type GardenEntry } from "./gardenEntries";
import { NEEDS_CAPTURE } from "./gardenArticles";

// ── Kinds ──

/** The collections the shelf lists, and the kind each reads as. */
const KIND_OF: Record<string, ShelfKind> = {
  books: "books", articles: "articles", movies: "movies", series: "series",
  podcasts: "podcasts", games: "games", blog: "posts", essays: "posts",
};
export const SHELF_KINDS = ["books", "articles", "movies", "series", "podcasts", "games", "posts"] as const;
export type ShelfKind = (typeof SHELF_KINDS)[number];

// ── Shapes ──

export interface BookSource {
  type: "book";
  book_id: number;
  chapters: number;
  progress: {
    chapter_slug: string;
    chapter_title: string | null;
    /** Position of the chapter among the book's chapters, 0–1. */
    fraction: number;
    finished: boolean;
    /** False while the member has paused tracking on this book. */
    tracking: boolean;
    updated_at: string;
  } | null;
}

export interface ArticleSource {
  type: "article";
  url: string | null;
  /** False for a bookmark: the site refused the capture, only the link was kept. */
  captured: boolean;
  word_count: number;
  reading_minutes: number;
}

export interface ShelfEntry {
  /** `<collection>/<locale>/<slug>`, or `calibre/<id>` for a book with no entry yet. */
  id: string;
  kind: ShelfKind;
  collection: string | null;
  locale: string | null;
  slug: string | null;
  title: string;
  byline: string | null;
  date: string;
  updated_at: string;
  image: string | null;
  tags: string[];
  rating: number | null;
  status: string | null;
  source: BookSource | ArticleSource | null;
  mine: { notes: number; opened: boolean } | null;
  shared: { state: "draft" | "published" } | null;
  /** The same subject in the member's other locales — one row per subject. */
  translations: { id: string; locale: string; shared: { state: "draft" | "published" } | null }[];
}

export type MineItem =
  | { kind: "note" | "quote"; id: null; date: string | null; text: string; quote: string | null; where: { page: string } | null }
  | { kind: "resonance"; id: null; date: string | null; text: string; quote: string | null;
      from: { label: string; entry_id: string | null; published_url: string | null } | null }
  | { kind: "highlight"; id: string; date: string; text: string; quote: string;
      where: { chapter_slug: string | null; chapter_title: string | null; view: string } }
  | { kind: "fragment"; id: string; date: null; text: string; summary: string };

export interface SharedLink {
  basename: string;
  label: string;
  entry_id: string | null;
  published_url: string | null;
}

export interface ShelfEntryDetail extends Omit<ShelfEntry, "mine" | "shared"> {
  mine: {
    notes: number; opened: boolean; web_path: string | null; file: string;
    prose: string; items: MineItem[];
  } | null;
  shared: {
    state: "draft" | "published"; web_path: string | null; file: string;
    public_url: string | null; title: string | null; body: string; links: SharedLink[];
  } | null;
}

// ── The member's site ──

/** `https://<domain>` when the member publishes a site, else null. */
export function siteFor(memberId: string): string | null {
  const row = db.query(`SELECT notes_domain FROM users WHERE id = ?`).get(memberId) as
    | { notes_domain: string | null }
    | null;
  const domain = (row?.notes_domain ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return domain ? `https://${domain}` : null;
}

/** The public address of a card: its garden path without the `/g/<member>` mount. */
function publicUrl(site: string | null, garden: GardenRef, webPath: string | null): string | null {
  if (!site || !webPath) return null;
  const mount = `/g/${garden.username}`;
  return site + (webPath.startsWith(mount) ? webPath.slice(mount.length) : webPath);
}

// ── Reading one face ──

interface Face {
  fm: Record<string, any>;
  meta: Record<string, any>;
  body: string;
}

function readFace(garden: GardenRef, relFile: string | undefined): Face | null {
  if (!relFile) return null;
  try {
    const parsed = parseFiche(fs.readFileSync(path.join(garden.root, relFile), "utf-8"));
    if (!parsed) return null;
    return { fm: parsed.frontmatter, meta: (parsed.frontmatter.meta ?? {}) as Record<string, any>, body: parsed.body };
  } catch {
    return null;
  }
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Has the member written the shared side? Not when the card's body is empty,
 * and not when it is only what a provider said about the work: the synopsis
 * `create_*_entry` puts there, which the fiche keeps a copy of in its `meta`.
 * An article card from the old scrape route is the same case — its body is the
 * article, someone else's words.
 */
export function isWritten(collection: string, card: Face | null, fiche: Face | null): boolean {
  if (!card) return false;
  const body = squash(card.body);
  if (!body) return false;
  if (collection === "articles" && !fiche && card.fm.url) return false;
  const provided = Object.values(fiche?.meta ?? {})
    .concat([card.fm.description, card.fm.overview])
    .filter((v): v is string => typeof v === "string" && v.length > 40)
    .map(squash);
  return !provided.some((p) => p === body || p.startsWith(body) || body.startsWith(p));
}

const BYLINE_KEYS = ["author", "director", "creator", "host", "publication", "developer", "platform"];

function byline(collection: string, card: Face | null, fiche: Face | null): string | null {
  // An article is known by where it appeared; its `author` is often the
  // byline's URL rather than a name.
  const keys = collection === "articles" ? ["publication", ...BYLINE_KEYS] : BYLINE_KEYS;
  for (const key of keys) {
    const v = card?.fm[key] ?? fiche?.meta[key];
    if (typeof v === "string" && v.trim() && !/^https?:\/\//.test(v.trim())) return v.trim();
    if (Array.isArray(v) && v.length) return v.map(String).join(", ");
  }
  return null;
}

// ── My side, parsed ──
//
// A fiche is free prose, then two sections the server appends to and nothing
// else writes: `## Commentaire` (dated notes) and `## Résonances` (dated blocks
// with a [[wiki-link]] back). Both are append-only and heading-last, which is
// what makes them readable back as items; everything above them is the prose.

const SECTIONS = { note: "## Commentaire", resonance: "## Résonances" } as const;
const DATED = /^(\d{4}-\d{2}-\d{2})(?:\s+—\s+(.*?))?\s*(:)?\s*$/;

interface Parsed { prose: string; items: MineItem[] }

function parseBlocks(kind: "note" | "resonance", text: string): MineItem[] {
  const items: MineItem[] = [];
  let cur: { date: string | null; head: string; colon: boolean; lines: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const quote = cur.lines.filter((l) => l.startsWith(">")).map((l) => l.replace(/^>\s?/, "")).join("\n").trim();
    const rest = cur.lines.filter((l) => !l.startsWith(">")).join("\n").trim();
    // `DATE — text` is a whole note on one line; `DATE — <where> :` opens a
    // block whose text follows.
    const text = cur.colon ? rest : [cur.head, rest].filter(Boolean).join("\n\n");
    if (!text && !quote) {
      cur = null;
      return;
    }
    if (kind === "resonance") {
      const link = cur.head.match(/^de \[\[([^\]|]+)\|([^\]]+)\]\]$/);
      const plain = cur.head.match(/^de \*(.+)\*$/);
      items.push({
        kind: "resonance", id: null, date: cur.date, text, quote: quote || null,
        from: link ? { label: link[2]!, entry_id: link[1]!, published_url: null }
          : plain ? { label: plain[1]!, entry_id: null, published_url: null } : null,
      });
    } else {
      const page = cur.colon ? cur.head.match(/^p\.\s*(\S+)$/) : null;
      items.push({
        kind: quote ? "quote" : "note", id: null, date: cur.date, text, quote: quote || null,
        where: page ? { page: page[1]! } : null,
      });
    }
    cur = null;
  };
  for (const line of text.split("\n")) {
    const m = line.match(DATED);
    if (m) {
      flush();
      cur = { date: m[1]!, head: (m[2] ?? "").trim(), colon: !!m[3], lines: [] };
    } else {
      // Text before the first date: the comment an article was saved with.
      cur ??= { date: null, head: "", colon: true, lines: [] };
      cur.lines.push(line);
    }
  }
  flush();
  return items;
}

function parseMine(fiche: Face, collection: string): Parsed {
  const lines = fiche.body.split("\n");
  const chunks: { kind: "prose" | "note" | "resonance"; lines: string[] }[] = [{ kind: "prose", lines: [] }];
  for (const line of lines) {
    const t = line.trim();
    if (t === SECTIONS.note) chunks.push({ kind: "note", lines: [] });
    else if (t === SECTIONS.resonance) chunks.push({ kind: "resonance", lines: [] });
    // Any other heading the member wrote after a section is prose again.
    else if (/^##\s/.test(t) && chunks.at(-1)!.kind !== "prose") chunks.push({ kind: "prose", lines: [line] });
    else chunks.at(-1)!.lines.push(line);
  }
  let prose = chunks.filter((c) => c.kind === "prose").map((c) => c.lines.join("\n").trim()).filter(Boolean).join("\n\n");
  // An article's fiche opens on the page's own excerpt, quoted: not the member's.
  if (collection === "articles") prose = prose.replace(/^(?:>.*(?:\n|$))+/, "").trim();
  const items = chunks.flatMap((c) => (c.kind === "prose" ? [] : parseBlocks(c.kind, c.lines.join("\n"))));
  return { prose, items };
}

/** What Maurice filed from a conversation. An article's first fragment is its text: the source. */
function readFragments(garden: GardenRef, ficheRel: string, collection: string): MineItem[] {
  const dir = fragmentsDir(path.join(garden.root, ficheRel));
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".frag")).sort();
  } catch {
    return [];
  }
  const out: MineItem[] = [];
  for (const file of files) {
    const id = path.basename(file, ".frag");
    if (collection === "articles" && id === "001") continue;
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, file), "utf-8");
    } catch {
      continue;
    }
    const parsed = parseFiche(raw);
    out.push({
      kind: "fragment", id: `f:${id}`, date: null,
      summary: String(parsed?.frontmatter.summary ?? ""),
      text: (parsed?.body ?? raw).trim(),
    });
  }
  return out;
}

function countFragments(garden: GardenRef, ficheRel: string, collection: string): number {
  try {
    return fs
      .readdirSync(fragmentsDir(path.join(garden.root, ficheRel)))
      .filter((f) => f.endsWith(".frag") && !(collection === "articles" && f === "001.frag")).length;
  } catch {
    return 0;
  }
}

// ── Calibre ──

interface Library {
  books: BookMetadata[];
  byId: Map<number, BookMetadata>;
  byTitle: Map<string, BookMetadata>;
}

/** The household's books. A server without a library simply has none. */
function loadLibrary(given?: BookMetadata[]): Library {
  let books: BookMetadata[] = given ?? [];
  if (!given) {
    try {
      books = listBooks();
    } catch {
      books = [];
    }
  }
  return {
    books,
    byId: new Map(books.map((b) => [b.id, b])),
    byTitle: new Map(books.map((b) => [b.title.trim().toLowerCase(), b])),
  };
}

/**
 * The Calibre book behind a garden entry: by the id the fiche carries when it
 * has one, otherwise by exact title — the same guess résonances make, and only
 * ever a first one, since the id is written the first time the server writes
 * on the entry.
 */
function bookFor(lib: Library, title: string, fiche: Face | null): BookMetadata | null {
  const id = Number(fiche?.meta.calibre_id);
  if (Number.isInteger(id) && lib.byId.has(id)) return lib.byId.get(id)!;
  return lib.byTitle.get(title.trim().toLowerCase()) ?? null;
}

/** A book's chapters, or none when the library cannot answer (moved, offline). */
async function chaptersOf(bookId: number) {
  try {
    return (await listChapters(bookId)) ?? [];
  } catch {
    return [];
  }
}

/** SQLite's `datetime('now')` is UTC without saying so. */
const isoFromSqlite = (s: string) => (/[TZ]/.test(s) ? s : `${s.replace(" ", "T")}Z`);

async function bookSource(memberId: string, book: BookMetadata): Promise<BookSource> {
  const progress = getReadingProgress(memberId, book.id) as ReadingProgress | null;
  if (!progress) {
    const stats = await getChapterStats(book.bookPath);
    return { type: "book", book_id: book.id, chapters: stats.chapters, progress: null };
  }
  // The stored `chapter_index` comes from the file's NNNN- prefix and counts
  // front matter; the slug is the identity both sides agree on.
  const chapters = await chaptersOf(book.id);
  const at = chapters.findIndex((c) => c.slug === progress.chapter_slug);
  const fraction = at >= 0 && chapters.length ? (at + 1) / chapters.length : 0;
  return {
    type: "book", book_id: book.id, chapters: chapters.length,
    progress: {
      chapter_slug: progress.chapter_slug,
      chapter_title: at >= 0 ? chapters[at]!.title : null,
      fraction,
      finished: at >= 0 && at === chapters.length - 1,
      tracking: !!progress.enabled,
      updated_at: isoFromSqlite(progress.updated_at),
    },
  };
}

function articleSource(card: Face | null, fiche: Face | null, garden: GardenRef, ficheRel: string | undefined): ArticleSource {
  const meta = fiche ? fiche.meta : (card?.fm ?? {});
  const words = Number(meta.word_count ?? 0);
  let captured = false;
  if (ficheRel && String(meta.status ?? "") !== NEEDS_CAPTURE) {
    captured = fs.existsSync(path.join(fragmentsDir(path.join(garden.root, ficheRel)), "001.frag"));
  }
  return {
    type: "article",
    url: (meta.url ?? card?.fm.url ?? null) as string | null,
    captured,
    word_count: words,
    reading_minutes: Math.max(1, Math.round(words / 230)),
  };
}

// ── The list ──

interface Counts { books: Map<number, number>; articles: Map<string, number> }

async function describe(
  memberId: string, garden: GardenRef, e: GardenEntry, lib: Library, counts: Counts,
): Promise<{ row: ShelfEntry; card: Face | null; fiche: Face | null; book: BookMetadata | null; subject: string }> {
  const card = readFace(garden, e.card?.file);
  const fiche = readFace(garden, e.fiche?.file);
  const kind = KIND_OF[e.collection]!;
  const book = e.collection === "books" ? bookFor(lib, e.title, fiche) : null;

  const source: ShelfEntry["source"] =
    book ? await bookSource(memberId, book)
    : e.collection === "articles" ? articleSource(card, fiche, garden, e.fiche?.file)
    : null;

  let mine: ShelfEntry["mine"] = null;
  if (fiche && e.fiche) {
    const opened = isOpened(fiche.fm);
    const marked = book ? counts.books.get(book.id) ?? 0
      : e.collection === "articles" ? counts.articles.get(`${e.locale}/${e.slug}`) ?? 0 : 0;
    // An unopened fiche holds nothing of the member's by definition; the
    // highlights are counted all the same, since a bare highlight is theirs.
    const written = opened ? (() => {
      const p = parseMine(fiche, e.collection);
      return p.items.length + (p.prose ? 1 : 0) + countFragments(garden, e.fiche!.file, e.collection);
    })() : 0;
    mine = { notes: written + marked, opened };
  }

  const written = isWritten(e.collection, card, fiche);
  const flags = Array.isArray(card?.fm.flags) ? card!.fm.flags.map(String) : [];
  const rating = Number(card?.fm.rating);
  const read = source?.type === "book" ? source.progress?.updated_at : undefined;

  return {
    card, fiche, book,
    subject: subjectKey(e, card, fiche),
    row: {
      id: `${e.collection}/${e.locale}/${e.slug}`,
      kind, collection: e.collection, locale: e.locale, slug: e.slug,
      title: e.title,
      byline: byline(e.collection, card, fiche) ?? (book ? book.authors.join(", ") || null : null),
      date: e.date,
      // Reading is touching the entry too.
      updated_at: read && read > e.updated_at ? read : e.updated_at,
      image: e.image, tags: e.tags,
      rating: Number.isFinite(rating) && rating > 0 ? rating : null,
      status: typeof card?.fm.status === "string" ? card.fm.status : null,
      source, mine,
      shared: written ? { state: flags.includes("public") ? "published" : "draft" } : null,
      translations: [],
    },
  };
}

// ── One row per subject ──
//
// A card translated into another locale is a second file under another locale
// directory, often under another slug ("la-cite-perdue-de-z" / "the-lost-city-
// of-z"); `translationKey` in the frontmatter is what says they are one
// subject. Without a key, the same slug in the same collection is.

function subjectKey(e: GardenEntry, card: Face | null, fiche: Face | null): string {
  const key = card?.fm.translationKey ?? fiche?.fm.translationKey;
  return `${e.collection}/${typeof key === "string" && key ? key : e.slug}`;
}

/**
 * Fold the locales of one subject into a single row: the one in the member's
 * own language when there is one, otherwise the one they have written on. The
 * others ride along as `translations`, so nothing published is lost from view.
 */
function foldTranslations(rows: { row: ShelfEntry; subject: string }[], preferred: string | null): ShelfEntry[] {
  const groups = new Map<string, ShelfEntry[]>();
  for (const { row, subject } of rows) {
    const g = groups.get(subject);
    if (g) g.push(row);
    else groups.set(subject, [row]);
  }
  const out: ShelfEntry[] = [];
  for (const group of groups.values()) {
    const primary =
      group.find((r) => r.locale === preferred) ?? group.find((r) => r.mine) ?? group[0]!;
    const others = group.filter((r) => r !== primary);
    // What the member touched last counts for the subject, in whichever locale.
    const updated_at = group.reduce((m, r) => (r.updated_at > m ? r.updated_at : m), primary.updated_at);
    out.push({
      ...primary,
      updated_at,
      mine: primary.mine ?? others.find((r) => r.mine)?.mine ?? null,
      source: primary.source ?? others.find((r) => r.source)?.source ?? null,
      translations: others.map((r) => ({ id: r.id, locale: r.locale!, shared: r.shared })),
    });
  }
  return out;
}

function preferredLocale(memberId: string): string | null {
  try {
    return getUserPreferences(memberId).locale || null;
  } catch {
    return null;
  }
}

export async function listShelf(
  memberId: string, garden: GardenRef,
  /** The household library; read from Calibre unless a caller supplies it. */
  books?: BookMetadata[],
): Promise<{
  kinds: { kind: ShelfKind; count: number }[];
  entries: ShelfEntry[];
}> {
  const lib = loadLibrary(books);
  const counts: Counts = { books: countHighlights(memberId), articles: countArticleHighlights(memberId) };

  const rows: { row: ShelfEntry; subject: string }[] = [];
  const claimed = new Set<number>();
  for (const e of listGardenEntries(garden)) {
    if (!KIND_OF[e.collection]) continue;
    const { row, book, subject } = await describe(memberId, garden, e, lib, counts);
    if (book) claimed.add(book.id);
    rows.push({ row, subject });
  }
  const entries = foldTranslations(rows, preferredLocale(memberId));

  // The books nothing is written on yet: readable all the same.
  for (const book of lib.books) {
    if (claimed.has(book.id)) continue;
    const source = await bookSource(memberId, book);
    const marked = counts.books.get(book.id) ?? 0;
    entries.push({
      id: `calibre/${book.id}`, kind: "books", collection: null, locale: null, slug: null,
      title: book.title, byline: book.authors.join(", ") || null,
      date: (book.added ?? "").slice(0, 10),
      updated_at: source.progress?.updated_at ?? book.added ?? "",
      image: null, tags: book.tags, rating: null, status: null,
      source,
      mine: marked ? { notes: marked, opened: true } : null,
      shared: null,
      translations: [],
    });
  }

  entries.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
  const kinds = SHELF_KINDS
    .map((kind) => ({ kind, count: entries.filter((e) => e.kind === kind).length }))
    .filter((k) => k.count > 0);
  return { kinds, entries };
}

// ── One entry ──

const WIKI_LINK = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

export async function getShelfEntry(
  memberId: string, garden: GardenRef, collection: string, locale: string, slug: string,
  books?: BookMetadata[],
): Promise<ShelfEntryDetail | null> {
  if (!KIND_OF[collection]) return null;
  const all = listGardenEntries(garden);
  const e = all.find((x) => x.collection === collection && x.locale === locale && x.slug === slug);
  if (!e) return null;

  const lib = loadLibrary(books);
  const counts: Counts = { books: countHighlights(memberId), articles: countArticleHighlights(memberId) };
  const { row, card, fiche, book, subject } = await describe(memberId, garden, e, lib, counts);
  const site = siteFor(memberId);

  // The page is of the locale asked for; its other locales are named beside it.
  for (const other of all) {
    if (other === e || other.collection !== collection) continue;
    const oCard = readFace(garden, other.card?.file);
    const oFiche = readFace(garden, other.fiche?.file);
    if (subjectKey(other, oCard, oFiche) !== subject) continue;
    const flags = Array.isArray(oCard?.fm.flags) ? oCard!.fm.flags.map(String) : [];
    row.translations.push({
      id: `${other.collection}/${other.locale}/${other.slug}`, locale: other.locale,
      shared: isWritten(collection, oCard, oFiche) ? { state: flags.includes("public") ? "published" : "draft" } : null,
    });
  }

  /** What a [[basename]] names, and where a reader of the site would land. */
  const resolve = (basename: string): { entry_id: string | null; published_url: string | null } => {
    const target = basename.replace(/-fiche$/, "");
    // A link carries no locale; the one beside this entry is the likelier.
    const hits = all.filter((x) => x.slug === target);
    const hit = hits.find((x) => x.locale === locale) ?? hits[0];
    if (!hit) return { entry_id: null, published_url: null };
    const flags = readFace(garden, hit.card?.file)?.fm.flags;
    const isPublic = Array.isArray(flags) && flags.map(String).includes("public");
    return {
      entry_id: `${hit.collection}/${hit.locale}/${hit.slug}`,
      published_url: isPublic ? publicUrl(site, garden, hit.card!.web_path) : null,
    };
  };

  let mine: ShelfEntryDetail["mine"] = null;
  if (fiche && e.fiche && row.mine) {
    const parsed = row.mine.opened ? parseMine(fiche, collection) : { prose: "", items: [] };
    const items: MineItem[] = parsed.items.map((item) =>
      item.kind === "resonance" && item.from?.entry_id
        ? { ...item, from: { label: item.from.label, ...resolve(item.from.entry_id) } }
        : item,
    );
    if (row.mine.opened) items.push(...readFragments(garden, e.fiche.file, collection));

    if (book) {
      const titles = new Map((await chaptersOf(book.id)).map((c) => [c.slug, c.title]));
      for (const h of listHighlights(memberId, book.id)) {
        items.push({
          kind: "highlight", id: `h:${h.id}`, date: isoFromSqlite(h.created_at).slice(0, 10),
          quote: h.quote, text: h.note ?? "",
          where: { chapter_slug: h.chapter_slug, chapter_title: titles.get(h.chapter_slug) ?? null, view: h.view },
        });
      }
    } else if (collection === "articles") {
      for (const h of listArticleHighlights(memberId, locale, slug)) {
        items.push({
          kind: "highlight", id: `h:${h.id}`, date: isoFromSqlite(h.created_at).slice(0, 10),
          quote: h.quote, text: h.note ?? "",
          where: { chapter_slug: null, chapter_title: null, view: h.view },
        });
      }
    }
    // Newest first; what carries no date (a fragment, a note saved with the
    // article) goes last, in the order it was written.
    const dated = items.filter((i) => i.date).sort((a, b) => (a.date! < b.date! ? 1 : a.date! > b.date! ? -1 : 0));
    mine = {
      ...row.mine, web_path: e.fiche.web_path, file: e.fiche.file,
      prose: parsed.prose, items: [...dated, ...items.filter((i) => !i.date)],
    };
  }

  let shared: ShelfEntryDetail["shared"] = null;
  if (row.shared && card && e.card) {
    const body = card.body.trim();
    const links: SharedLink[] = [];
    for (const m of body.matchAll(WIKI_LINK)) {
      links.push({ basename: m[1]!, label: m[2] ?? m[1]!, ...resolve(m[1]!) });
    }
    const heading = body.match(/^#\s+(.+)$/m);
    shared = {
      state: row.shared.state, web_path: e.card.web_path, file: e.card.file,
      public_url: publicUrl(site, garden, e.card.web_path),
      title: heading ? heading[1]!.trim() : null,
      body, links,
    };
  }

  return { ...row, mine, shared };
}
