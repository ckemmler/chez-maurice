/**
 * The garden's content, read off disk — every collection, the way notes
 * already were.
 *
 * This replaces Astro's content layer (`astro:content` + `content.config.ts`)
 * with the same three calls, so a page or a view changes only its import:
 *
 *   getCollection(name, filter?)  → the entries, cheap (no HTML)
 *   getEntry(name, id)            → one entry, with `html`
 *   renderEntry(entry)            → that entry's HTML
 *
 * Why not the content layer. It is a *build-time store*: a glob loader scans
 * the garden once and hands out what it captured. A garden is not a build
 * artefact — Maurice writes to it all day — and keeping the store fresh is
 * what pinned every member's garden to a running `astro dev`, 270 MB apiece.
 * Worse, under rapid edits the store intermittently collapsed a collection to
 * "empty" and never recovered until restart (see `notes-fs.ts`, which was
 * written to escape exactly that, for notes only).
 *
 * Reading files is also how a big garden stays cheap: a list view stats its
 * directory and parses only what changed since last time, and nothing is ever
 * regenerated. A malformed file is skipped with a warning instead of taking
 * its whole collection down.
 *
 * What is lost: the zod schemas. They mostly coerced quoted dates, which YAML
 * types for us anyway; the few fields views depend on are coerced below, and
 * everything else is passed through as authored (`notes-fs` made the same
 * trade and has held).
 */
import fs from "node:fs";
import path from "node:path";
import { createMarkdownProcessor, parseFrontmatter, type MarkdownProcessor } from "@astrojs/markdown-remark";
import remarkCrossRef from "@app/plugins/remark-cross-ref";
import { gardenRoot } from "@app/lib/garden";
import { listAllNotes, listNotes, noteFilePath } from "@app/lib/notes-fs";

export interface Entry {
  /** "<locale>/<slug>" — the id the content layer gave, so URLs are unchanged. */
  id: string;
  slug: string;
  collection: string;
  data: Record<string, any>;
  /** Raw markdown body, frontmatter stripped. */
  body: string;
  /** Absolute path of the file this came from. */
  filePath: string;
  /** Rendered HTML — present on `getEntry`, not on a list. */
  html?: string;
}

/** The resource collections, which also hold the fiches. */
export const RESOURCE_COLLECTIONS = [
  "books", "articles", "movies", "games", "series", "podcasts", "people",
] as const;

/** Every collection and the directory under the garden that holds it. */
const DIRS: Record<string, string> = {
  blog: "blog", essays: "essays", notes: "notes", pages: "pages",
  books: "books", articles: "articles", movies: "movies", games: "games",
  series: "series", podcasts: "podcasts", people: "people",
};

// ── Typed frontmatter ───────────────────────────────────────────

const DATE_KEYS = new Set([
  "date", "last_updated", "date_read", "date_watched", "date_listened", "date_played",
]);
const ARRAY_KEYS = new Set(["tags", "flags", "guests", "platforms"]);

/** Coerce the handful of fields the views actually rely on. */
function coerce(raw: Record<string, unknown>, id: string): Record<string, any> {
  const data: Record<string, any> = { ...raw };
  for (const key of DATE_KEYS) {
    const v = data[key];
    if (v != null && !(v instanceof Date)) data[key] = new Date(v as string);
  }
  for (const key of ARRAY_KEYS) {
    if (key in data && !Array.isArray(data[key])) data[key] = data[key] == null ? [] : [data[key]];
  }
  data.tags ??= [];
  data.flags ??= [];
  // A sort on a missing date must not produce NaN and scramble a list.
  data.date ??= data.date_read ?? data.date_watched ?? data.date_listened ?? data.date_played ?? new Date(0);
  data.locale ??= id.split("/")[0] || "en";
  return data;
}

// ── Reading, with a parse cache keyed by mtime ──────────────────

type Cached = { mtimeMs: number; size: number; data: Record<string, any>; body: string };
const parsed = new Map<string, Cached>();
const rendered = new Map<string, { mtimeMs: number; html: string }>();

function readParsed(filePath: string, id: string): Cached | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  const hit = parsed.get(filePath);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;

  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let raw: Record<string, unknown>;
  let body: string;
  try {
    const fm = parseFrontmatter(text);
    raw = fm.frontmatter as Record<string, unknown>;
    body = fm.content;
  } catch {
    console.warn(`[content-fs] skipping unparseable file: ${filePath}`);
    return null;
  }
  const entry: Cached = { mtimeMs: stat.mtimeMs, size: stat.size, data: coerce(raw, id), body };
  parsed.set(filePath, entry);
  return entry;
}

/** Every markdown file under `dir`, as paths relative to it. */
function walk(dir: string, rel = ""): string[] {
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of names) {
    if (e.name.startsWith(".")) continue;
    const child = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) out.push(...walk(dir, child));
    else if (e.name.endsWith(".md") || e.name.endsWith(".mdx")) out.push(child);
  }
  return out;
}

function entriesFrom(collection: string, base: string, files: string[]): Entry[] {
  const out: Entry[] = [];
  for (const rel of files) {
    const id = rel.replace(/\.mdx?$/, "");
    const filePath = path.join(base, rel);
    const p = readParsed(filePath, id);
    if (!p) continue;
    // A file with no title is a fragment or a stray, not an entry.
    if (collection !== "pages" && typeof p.data.title !== "string" && typeof p.data.name !== "string") continue;
    out.push({
      id, slug: id.includes("/") ? id.slice(id.indexOf("/") + 1) : id,
      collection, data: p.data, body: p.body, filePath,
    });
  }
  return out;
}

/**
 * Fiches are the owner's working notes on a resource. They live beside it
 * (`books/en/x-fiche.md`) and their id spans the collection, as the content
 * layer's cross-collection glob did.
 *
 * They never belong to the public static site — the old config expressed that
 * as "empty when NODE_ENV=production", which would also have emptied them in a
 * production *server* build. The rule is the one that was meant: fiches exist
 * in the garden engine (WEB_SSR), not in a static publish.
 */
function fiches(): Entry[] {
  if (process.env.WEB_SSR !== "1") return [];
  const root = gardenRoot();
  const out: Entry[] = [];
  for (const collection of RESOURCE_COLLECTIONS) {
    const base = path.join(root, collection);
    const files = walk(base).filter((f) => /-fiche\.mdx?$/.test(f));
    for (const e of entriesFrom("fiches", base, files)) {
      out.push({ ...e, id: `${collection}/${e.id}`, collection: "fiches" });
    }
  }
  return out;
}

/** Notes keep their own reader — the one that has served the garden all along. */
function notes(): Entry[] {
  return listAllNotes().map((n) => ({
    id: n.id, slug: n.slug, collection: "notes", data: n.data as Record<string, any>,
    body: n.body, filePath: noteFilePath(n.data.locale as string, n.slug),
  }));
}

// ── The API ─────────────────────────────────────────────────────

/**
 * A collection's entries, optionally filtered — the signature `astro:content`
 * had, so call sites did not have to change. Async for the same reason.
 */
export async function getCollection(
  name: string,
  filter?: (entry: Entry) => unknown,
): Promise<Entry[]> {
  let all: Entry[];
  if (name === "notes") all = notes();
  else if (name === "fiches") all = fiches();
  else {
    const dir = DIRS[name];
    if (!dir) {
      console.warn(`[content-fs] unknown collection: ${name}`);
      return [];
    }
    const base = path.join(gardenRoot(), dir);
    all = entriesFrom(name, base, walk(base).filter((f) => !/-fiche\.mdx?$/.test(f)));
  }
  return filter ? all.filter((e) => !!filter(e)) : all;
}

/** One entry by id ("<locale>/<slug>"), rendered. */
export async function getEntry(name: string, id: string): Promise<Entry | undefined> {
  const entry = (await getCollection(name)).find((e) => e.id === id);
  if (!entry) return undefined;
  return { ...entry, html: await renderEntry(entry) };
}

let _processor: Promise<MarkdownProcessor> | null = null;
function processor(): Promise<MarkdownProcessor> {
  _processor ??= createMarkdownProcessor({
    shikiConfig: { theme: "github-dark" },
    remarkPlugins: [remarkCrossRef],
  });
  return _processor;
}

/**
 * An entry's HTML. Same pipeline as the content layer used (shiki's
 * github-dark, the wiki-link plugin), and the file path goes to the processor
 * so the plugin's locale detection keeps working. Cached by mtime: rendering
 * is the expensive half, and a list view that renders nothing pays nothing.
 */
export async function renderEntry(entry: Entry): Promise<string> {
  if (entry.html) return entry.html;
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(entry.filePath).mtimeMs;
  } catch { /* rendered from memory below */ }
  const hit = rendered.get(entry.filePath);
  if (hit && hit.mtimeMs === mtimeMs) return hit.html;
  const { code } = await (await processor()).render(entry.body, { fileURL: entry.filePath });
  rendered.set(entry.filePath, { mtimeMs, html: code });
  return code;
}

/** Test seam: forget every cached parse and render. */
export function _clearCaches(): void {
  parsed.clear();
  rendered.clear();
}
