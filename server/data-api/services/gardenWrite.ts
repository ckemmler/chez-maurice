/**
 * Writing on an entry from Carnet — the two sides the shelf reads
 * (gardenShelf.ts), written the way they are read back.
 *
 *   - **mine**: a dated block appended under `## Commentaire` in the fiche,
 *     the section and the date format an article's notes already use. The
 *     fiche is created when the entry has none, and opened if it was not.
 *   - **shared**: the body of the card. The frontmatter is left exactly as
 *     written — the card's identity was put there by other hands (the garden
 *     tool, the member in Obsidian) and is not this file's to restyle.
 *   - **completed**: what a card of its kind says about its subject (when
 *     it was read or watched, by whom it is, where it showed, its cover),
 *     taken from the fiche's metadata and added where the card lacks it.
 *   - **covered**: a picture the member's device brings, for an entry the
 *     server could not fetch one for.
 *   - **published**: the card's `public` flag, then a site deploy.
 *   - **deleted**: the card, the fiche and what hangs under the fiche, in
 *     every locale of the subject; a deploy when something was online.
 *   - **archived**: nothing in the garden at all (shelfArchive.ts).
 *
 * Every write commits (and pushes) the member's garden, like every other
 * garden write. Nothing is stored beside the markdown.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { setFlag } from "../../src/services/gardenTools";
import { getBookMetadata } from "./calibre";
import { slugify } from "./articleExtract";
import {
  assertLocale, assertSlug, atomicWrite, autoCommit, downloadImage, dumpFrontmatter, markOpened, parseFiche,
  resourceImagePaths, writeFiche, type GardenRef, type ResourceCollection,
} from "./gardenFiche";
import { listGardenEntries, type GardenEntry } from "./gardenEntries";
import { indexGardenPaths, unindexGardenPath } from "./gardenIndex";
import {
  bookFor, isShelfCollection, isWritten, loadLibrary, ownSiteFor, preferredLocale, readFace, siteFor, subjectKey,
} from "./gardenShelf";
import { setArchived } from "./shelfArchive";
import { buildPublicPages } from "./publicPages";

export class EntryWriteError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 422) {
    super(message);
  }
}

export interface EntryRef { collection: string; locale: string; slug: string }

// The note as text lives in gardenNote.ts, free of the shelf's imports.
import { noteBlock, withNote, type NoteInput } from "./gardenNote";
export { noteBlock, withNote, type NoteInput };

const today = () => new Date().toISOString().slice(0, 10);

function findEntry(garden: GardenRef, ref: EntryRef): GardenEntry {
  if (!isShelfCollection(ref.collection)) throw new EntryWriteError(`Not an entry: ${ref.collection}`, 404);
  const entry = listGardenEntries(garden).find(
    (e) => e.collection === ref.collection && e.locale === ref.locale && e.slug === ref.slug,
  );
  if (!entry) throw new EntryWriteError(`No such entry: ${ref.collection}/${ref.locale}/${ref.slug}`, 404);
  return entry;
}

function fileOf(garden: GardenRef, ref: EntryRef, suffix: "" | "-fiche"): string {
  const target = path.join(garden.root, ref.collection, assertLocale(ref.locale), `${assertSlug(ref.slug)}${suffix}.md`);
  if (!path.resolve(target).startsWith(path.resolve(garden.root) + path.sep)) {
    throw new EntryWriteError("path escapes the garden", 400);
  }
  return target;
}

// ── My side ──

/** The entry's fiche, created empty when it has none. Returns its absolute path. */
function ensureFiche(garden: GardenRef, entry: GardenEntry, meta: Record<string, any> = {}): { file: string; created: boolean } {
  if (entry.fiche) return { file: path.join(garden.root, entry.fiche.file), created: false };
  const file = fileOf(garden, entry, "-fiche");
  writeFiche(file, {
    title: entry.title,
    resource_collection: entry.collection,
    resource_id: entry.slug,
    date: today(),
    tags: [],
    locale: entry.locale,
    meta: { title: entry.title, ...meta },
  }, "");
  return { file, created: true };
}

/**
 * Add a note to the member's side of an entry. `calibreId` is the book the
 * shelf matched to this entry, when it matched one by title: the first write
 * records it, so the match never has to be guessed again.
 */
export function addNote(
  memberId: string, garden: GardenRef, ref: EntryRef, input: NoteInput, calibreId?: number | null,
): void {
  if (!(input.text ?? "").trim() && !(input.quote ?? "").trim()) {
    throw new EntryWriteError("text or quote required", 400);
  }
  const entry = findEntry(garden, ref);
  const { file } = ensureFiche(garden, entry, calibreId ? { calibre_id: calibreId } : {});

  const parsed = parseFiche(fs.readFileSync(file, "utf-8"));
  if (!parsed) throw new EntryWriteError(`Could not parse: ${path.relative(garden.root, file)}`, 422);

  const block = noteBlock(today(), input);
  // The same note sent twice (a retry after a lost answer) is written once.
  const body = parsed.body.includes(block) ? parsed.body : withNote(parsed.body, block);

  markOpened(parsed.frontmatter);
  if (calibreId && parsed.frontmatter.meta?.calibre_id == null) {
    parsed.frontmatter.meta = { ...(parsed.frontmatter.meta ?? {}), calibre_id: calibreId };
  }
  writeFiche(file, parsed.frontmatter, body);
  autoCommit(garden, [file], `Note on ${entry.collection}/${entry.slug}`);
  indexGardenPaths(memberId, [file]);
}

/**
 * The garden entry of a book of the library, with a fiche: the one that
 * exists, or a new one. This is how a book nothing was written on gets its
 * member's side — from a first note, or a first highlight with a note.
 */
export async function entryForBook(
  memberId: string, garden: GardenRef, bookId: number, locale?: string,
): Promise<EntryRef> {
  const book = await getBookMetadata(bookId);
  if (!book) throw new EntryWriteError(`Book not found: ${bookId}`, 404);

  const lib = loadLibrary([book]);
  const books = listGardenEntries(garden).filter((e) => e.collection === "books");
  const existing = books.find((e) => bookFor(lib, e.title, readFace(garden, e.fiche?.file))?.id === bookId);

  const ref: EntryRef = existing
    ? { collection: "books", locale: existing.locale, slug: existing.slug }
    : {
        collection: "books",
        // No language is known for the book: the member's own, else the one
        // most of their books are filed under.
        locale: assertLocale(locale ?? preferredLocale(memberId) ?? majorityLocale(books) ?? "fr"),
        slug: assertSlug(slugify(book.title) || `book-${bookId}`),
      };

  const file = fileOf(garden, ref, "-fiche");
  if (!fs.existsSync(file)) {
    writeFiche(file, {
      title: existing?.title ?? book.title,
      resource_collection: "books",
      resource_id: ref.slug,
      date: today(),
      tags: [],
      locale: ref.locale,
      meta: {
        title: book.title,
        author: book.authors.join(", ") || undefined,
        calibre_id: bookId,
        description: book.description || undefined,
      },
    }, "");
    autoCommit(garden, [file], `Open book fiche: books/${ref.slug}`);
    indexGardenPaths(memberId, [file]);
  } else {
    // Opened, and tied to the book for good.
    const parsed = parseFiche(fs.readFileSync(file, "utf-8"));
    if (parsed) {
      const opened = markOpened(parsed.frontmatter);
      const stamped = parsed.frontmatter.meta?.calibre_id == null;
      if (stamped) parsed.frontmatter.meta = { ...(parsed.frontmatter.meta ?? {}), calibre_id: bookId };
      if (opened || stamped) {
        writeFiche(file, parsed.frontmatter, parsed.body);
        autoCommit(garden, [file], `Open book fiche: books/${ref.slug}`);
        indexGardenPaths(memberId, [file]);
      }
    }
  }
  return ref;
}

function majorityLocale(entries: GardenEntry[]): string | null {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.locale, (counts.get(e.locale) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

// ── The shared side ──

const FRONTMATTER = /^---\n[\s\S]*?\n---\n?/;

/**
 * Write the body of the card. The card is created as a draft when the entry
 * only has a fiche; an existing card keeps its frontmatter byte for byte.
 */
export function writeShared(
  memberId: string, garden: GardenRef, ref: EntryRef, input: { body: string; title?: string },
): void {
  const entry = findEntry(garden, ref);
  let body = String(input.body ?? "").replace(/\r\n/g, "\n").trim();
  const title = (input.title ?? "").replace(/\s+/g, " ").trim();
  // The piece's own title is its first heading; a body that brings one keeps it.
  if (title && body && !/^#\s/m.test(body)) body = `# ${title}\n\n${body}`;

  const file = fileOf(garden, ref, "");
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, "utf-8");
    const fm = raw.match(FRONTMATTER)?.[0];
    if (!fm) throw new EntryWriteError(`Could not parse: ${path.relative(garden.root, file)}`, 422);
    atomicWrite(file, `${fm.replace(/\n?$/, "\n")}${body ? `\n${body}\n` : ""}`);
  } else {
    if (!body) return;   // nothing written, nothing to create
    const fiche = readFace(garden, entry.fiche?.file);
    writeFiche(file, {
      title: entry.title,
      ...cardIdentity(entry.collection, fiche?.meta ?? {}),
      flags: [],
      image: entry.image ?? undefined,
      tags: entry.tags,
      locale: entry.locale,
    }, body);
  }
  autoCommit(garden, [file], `Write ${entry.collection}/${entry.slug}`);
  indexGardenPaths(memberId, [file]);
}

/**
 * Publish or unpublish the shared side: the `public` flag on the card, then a
 * deploy of the member's site. Refused when nothing is written, and when the
 * member has no site to deploy to.
 */
export function setPublished(memberId: string, garden: GardenRef, ref: EntryRef, on: boolean): DeployState {
  const entry = findEntry(garden, ref);
  if (!canDeploy(memberId, garden)) throw new EntryWriteError("No site is set up for this member", 409);
  if (!entry.card) throw new EntryWriteError("Nothing is written to publish", 409);

  const file = path.join(garden.root, entry.card.file);
  if (on && !isWritten(entry.collection, readFace(garden, entry.card.file), readFace(garden, entry.fiche?.file))) {
    throw new EntryWriteError("Nothing is written to publish", 409);
  }
  const raw = fs.readFileSync(file, "utf-8");
  const next = setFlag(raw, "public", on);
  if (next !== raw) {
    atomicWrite(file, next);
    autoCommit(garden, [file], `Set public ${on ? "on" : "off"}: ${path.basename(file)}`);
  }
  return requestDeploy(garden, deployKind(memberId));
}

// ── What a card says about its subject ──
//
// A card made by the garden tool carries its kind's own fields: `date_watched`
// and `platform` for a series, `author` and `date_read` for a book. One made
// here, the first time a member writes the shared side of an entry that only
// had a fiche, used to carry a title and a date and nothing else — no cover,
// no author — and the site's pages, which format the kind's own date without
// asking, could not render it. The fiche has all of it under `meta`, put
// there by the provider when the fiche was opened: this reads it back.

/** The date each kind of card is filed under. */
const DATE_FIELD: Record<string, string> = {
  books: "date_read", articles: "date_read", movies: "date_watched", series: "date_watched",
  music: "date_listened", podcasts: "date_listened", games: "date_played",
};

/** Card field ← the fiche's `meta` key, per kind (the garden tool's own mapping, promote_fiche). */
const FROM_META: Record<string, [string, string][]> = {
  books: [["author", "author"], ["year", "year"]],
  articles: [["source", "site_name"], ["url", "url"], ["author", "author"]],
  movies: [["director", "director"], ["year", "year"]],
  series: [["platform", "platform"]],
  music: [["artist", "artist"], ["year", "year"]],
  podcasts: [["host", "host"], ["url", "url"]],
  games: [["developer", "developer"], ["year", "year"], ["platforms", "platforms"]],
};

const STATUS: Record<string, string> = { books: "read", series: "watched" };

function cardIdentity(collection: string, meta: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  if (DATE_FIELD[collection]) out[DATE_FIELD[collection]!] = today();
  else out.date = today();
  if (STATUS[collection]) out.status = STATUS[collection];
  for (const [field, key] of FROM_META[collection] ?? []) {
    const v = meta[key];
    const empty = v == null || v === "" || (Array.isArray(v) && !v.length);
    // An article's `author` is often the byline's address rather than a name.
    if (!empty && !(typeof v === "string" && /^https?:\/\//.test(v) && field !== "url")) out[field] = v;
  }
  return out;
}

/** Where the provider keeps the cover, when the fiche recorded one. */
function coverSource(meta: Record<string, any>): string | null {
  if (typeof meta.poster_path === "string" && meta.poster_path.startsWith("/")) {
    return `https://image.tmdb.org/t/p/w500${meta.poster_path}`;
  }
  for (const key of ["thumbnail", "cover_url", "artwork", "image"]) {
    const v = meta[key];
    if (typeof v === "string" && /^https?:\/\//.test(v)) return v;
  }
  return null;
}

/**
 * Complete a card from its fiche: every field of its kind the card lacks, and
 * its cover — the file already in the garden under the entry's name, or the
 * provider's, fetched. What the card says is never replaced: the lines are
 * added at the end of its frontmatter, the rest left byte for byte. Answers
 * with the fields added; none when the card was whole, or has no fiche to
 * complete it from.
 */
export async function completeCard(memberId: string, garden: GardenRef, ref: EntryRef): Promise<string[]> {
  const entry = findEntry(garden, ref);
  // An entry that is a fiche and nothing else has no card to complete: that is
  // not a fault, and asking is the same gesture for every entry.
  if (!entry.card) return [];
  const file = path.join(garden.root, entry.card.file);
  const raw = fs.readFileSync(file, "utf-8");
  const card = parseFiche(raw);
  if (!card || !FRONTMATTER.test(raw)) throw new EntryWriteError(`Could not parse: ${entry.card.file}`, 422);
  const meta = readFace(garden, entry.fiche?.file)?.meta ?? {};

  const want = cardIdentity(entry.collection, meta);
  // A card filed under one date is not given a second: `date` already says when.
  const dateField = DATE_FIELD[entry.collection];
  if (dateField && card.frontmatter.date != null) {
    const d = card.frontmatter.date as unknown;
    want[dateField] = d instanceof Date ? d.toISOString().slice(0, 10) : String(d);
  }
  if (card.frontmatter.translationKey == null) want.translationKey = entry.slug;

  const touched = [file];
  if (card.frontmatter.image == null) {
    const cover = resourceImagePaths(garden, entry.collection as ResourceCollection, entry.locale, entry.slug);
    const source = coverSource(meta);
    if (fs.existsSync(cover.file) || (source && (await downloadImage(source, cover.file)))) {
      want.image = cover.url;
      touched.push(cover.file);
    }
  }

  const missing = Object.keys(want).filter((k) => card.frontmatter[k] == null);
  if (!missing.length) return [];
  const lines = dumpFrontmatter(Object.fromEntries(missing.map((k) => [k, want[k]])));
  // Before the closing fence of the frontmatter, which is the first `\n---`
  // after the opening one.
  atomicWrite(file, raw.replace(/\n---(\n|$)/, `\n${lines}\n---$1`));
  autoCommit(garden, touched, `Complete ${entry.collection}/${entry.slug}: ${missing.join(", ")}`);
  indexGardenPaths(memberId, [file]);
  return missing;
}

// ── A cover the member's device brings ──
//
// The server fetches a cover when it can reach the page. Many sites refuse
// anything that is not a browser (gatesnotes.com answers 403 to a server, and
// to a link-preview bot too), and from any app but Safari a share carries only
// an address: the article is saved bare. The phone can load the page in a real
// web engine — the system's own link preview — and read the picture the page
// names for sharing. This is where it brings it.

const MAX_COVER_BYTES = 8 * 1024 * 1024;

/** JPEG or PNG, by what the bytes say rather than by what the request claims. */
function isPicture(bytes: Uint8Array): boolean {
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  return jpeg || png;
}

/**
 * Give an entry the cover the caller holds: the file under the entry's name
 * among the garden's images, named in the fiche's `meta` (where an article's
 * cover is read from) and on the card when it has none. A cover already there
 * is replaced: asking is the member saying this one is the right one. One
 * commit.
 */
export function setCover(memberId: string, garden: GardenRef, ref: EntryRef, bytes: Uint8Array): void {
  const entry = findEntry(garden, ref);
  if (!bytes.length) throw new EntryWriteError("No picture was sent", 400);
  if (bytes.length > MAX_COVER_BYTES) throw new EntryWriteError("That picture is too large", 400);
  if (!isPicture(bytes)) throw new EntryWriteError("A cover is a JPEG or a PNG", 400);

  const cover = resourceImagePaths(garden, entry.collection as ResourceCollection, entry.locale, entry.slug);
  fs.mkdirSync(path.dirname(cover.file), { recursive: true });
  fs.writeFileSync(cover.file, bytes);
  attachCover(memberId, garden, entry, cover);
}

/** Name the cover file on the entry's faces, and commit it with them. */
function attachCover(memberId: string, garden: GardenRef, entry: GardenEntry, cover: { file: string; url: string }): void {
  const touched = [cover.file];

  if (entry.fiche) {
    const file = path.join(garden.root, entry.fiche.file);
    const parsed = parseFiche(fs.readFileSync(file, "utf-8"));
    if (parsed && parsed.frontmatter.meta?.image !== cover.url) {
      parsed.frontmatter.meta = { ...(parsed.frontmatter.meta ?? {}), image: cover.url };
      writeFiche(file, parsed.frontmatter, parsed.body);
      touched.push(file);
    }
  }
  if (entry.card) {
    const file = path.join(garden.root, entry.card.file);
    const raw = fs.readFileSync(file, "utf-8");
    if (parseFiche(raw)?.frontmatter.image == null && FRONTMATTER.test(raw)) {
      atomicWrite(file, raw.replace(/\n---(\n|$)/, `\n${dumpFrontmatter({ image: cover.url })}\n---$1`));
      touched.push(file);
    }
  }
  autoCommit(garden, touched, `Cover for ${entry.collection}/${entry.slug}`);
  indexGardenPaths(memberId, touched.filter((f) => f.endsWith(".md")));
}

/**
 * An entry that shows without a cover is given the one it can have without
 * asking anyone: the file already under its name in the garden, or the
 * provider's, fetched from the address the fiche kept. Whatever faces it has
 * — a fiche alone, a card alone, both. Answers whether it now has one.
 */
export async function completeCover(memberId: string, garden: GardenRef, ref: EntryRef): Promise<boolean> {
  const entry = findEntry(garden, ref);
  if (entry.image) return true;
  const cover = resourceImagePaths(garden, entry.collection as ResourceCollection, entry.locale, entry.slug);
  const source = coverSource(readFace(garden, entry.fiche?.file)?.meta ?? {});
  if (!fs.existsSync(cover.file) && !(source && (await downloadImage(source, cover.file)))) return false;
  attachCover(memberId, garden, entry, cover);
  return true;
}

// ── Deleting, putting away ──

/** Every locale of the subject `entry` is one of: the row the list shows. */
function subjectOf(garden: GardenRef, entry: GardenEntry): GardenEntry[] {
  const key = (e: GardenEntry) => subjectKey(e, readFace(garden, e.card?.file), readFace(garden, e.fiche?.file));
  const subject = key(entry);
  return listGardenEntries(garden).filter((e) => e.collection === entry.collection && key(e) === subject);
}

const idOf = (e: GardenEntry) => `${e.collection}/${e.locale}/${e.slug}`;

function filesUnder(dir: string): string[] {
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return names.flatMap((n) => (n.isDirectory() ? filesUnder(path.join(dir, n.name)) : [path.join(dir, n.name)]));
}

/**
 * Delete an entry: the card, the fiche, and what hangs under the fiche (the
 * fragments Maurice filed, an article's captured text, the flashcards), in
 * every locale of the subject — a row of the list is one subject, and a
 * translation left behind would stay published with nothing to show it. One
 * commit, so the garden's history gives it back. What is not the entry's
 * stays: the book in the library, the passages highlighted in it. A deploy
 * follows when something that was online is gone.
 */
export function deleteEntry(memberId: string, garden: GardenRef, ref: EntryRef): { deleted: string[]; deploy: DeployState | null } {
  const group = subjectOf(garden, findEntry(garden, ref));
  const root = path.resolve(garden.root) + path.sep;
  const removed: string[] = [];
  let wasOnline = false;

  for (const e of group) {
    const flags = readFace(garden, e.card?.file)?.fm.flags;
    if (Array.isArray(flags) && flags.map(String).includes("public")) wasOnline = true;

    const files = [e.card?.file, e.fiche?.file].filter((f): f is string => !!f).map((f) => path.join(garden.root, f));
    const under = e.fiche ? path.join(garden.root, e.fiche.file).replace(/\.md$/, "") : null;
    if (under) files.push(...filesUnder(under));
    for (const file of files) {
      if (!path.resolve(file).startsWith(root)) throw new EntryWriteError("path escapes the garden", 400);
    }
    for (const file of files) {
      // Its real path, taken while it exists: autoCommit resolves symlinks to
      // match git's own view of the tree, and cannot for a file that is gone.
      try { removed.push(fs.realpathSync(file)); } catch { removed.push(file); }
      fs.rmSync(file, { force: true });
      // The flashcards are git-ignored and were never in the corpus.
      if (!file.includes(`${path.sep}_cards${path.sep}`)) unindexGardenPath(memberId, file);
    }
    if (under) fs.rmSync(under, { recursive: true, force: true });
  }

  autoCommit(garden, removed, `Delete ${ref.collection}/${ref.slug}`);
  setArchived(memberId, group.map(idOf), false);
  return {
    deleted: group.map(idOf),
    deploy: wasOnline && canDeploy(memberId, garden) ? requestDeploy(garden, deployKind(memberId)) : null,
  };
}

/**
 * Put an entry away from the member's list, or bring it back. `id` is a shelf
 * id: an entry of the garden, recorded under every locale of its subject so
 * the row stays away whichever locale leads it, or a book of the library
 * nobody wrote on (`calibre/<id>`), which can be put away and nothing else.
 */
export function archiveEntry(memberId: string, garden: GardenRef, id: string, on: boolean): string[] {
  let ids: string[];
  if (/^calibre\/\d+$/.test(id)) {
    ids = [id];
  } else {
    const [collection, locale, slug, ...rest] = id.split("/");
    if (!collection || !locale || !slug || rest.length) throw new EntryWriteError(`Not an entry: ${id}`, 400);
    ids = subjectOf(garden, findEntry(garden, { collection, locale, slug })).map(idOf);
  }
  setArchived(memberId, ids, on);
  return ids;
}

// ── The deploy ──
//
// Two kinds, by what the member has. A site of their own: `scripts/publish-
// web.sh` pulls the garden, builds the site and uploads it to its host. Pages
// on the household's host: built here and swapped into place (publicPages.ts).
//
// Either way nothing stops two from running at once, and the phone can ask for
// one at any moment. So one runs at a time per member, and whatever is asked
// while it runs is folded into a single run that follows — which then carries
// every flag set in the meantime.

export interface DeployState {
  status: "idle" | "queued" | "running" | "failed";
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

type Runner = (garden: GardenRef) => Promise<void>;
type Kind = "site" | "pages";

const SCRIPT = path.resolve(import.meta.dir, "../../../scripts/publish-web.sh");

const runScript: Runner = (garden) =>
  new Promise((resolve, reject) => {
    const child = spawn("bash", [SCRIPT], {
      env: { ...process.env, GARDEN: garden.username },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "";
    const keep = (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-2000); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(tail.trim().split("\n").slice(-3).join(" ⏎ ") || `exit ${code}`))));
  });

const IDLE: DeployState = { status: "idle", started_at: null, finished_at: null, error: null };

interface Slot { state: DeployState; running: boolean; again: Kind | null }
const slots = new Map<string, Slot>();
const slotFor = (username: string): Slot => {
  let slot = slots.get(username);
  if (!slot) slots.set(username, (slot = { state: { ...IDLE }, running: false, again: null }));
  return slot;
};

let override: Runner | null = null;

/** Tests replace both deploys with a stand-in. */
export function setDeployRunner(r: Runner | null): void {
  override = r;
  slots.clear();
}

export function deployState(username: string): DeployState {
  return { ...(slots.get(username)?.state ?? IDLE) };
}

/** Which deploy a member's publish is: their own site, or their pages here. */
function deployKind(memberId: string): Kind {
  return ownSiteFor(memberId) ? "site" : "pages";
}

/**
 * Can this member publish? With a domain of their own: only the garden the
 * publish script is set up for (`GARDEN`, by default the owner's, and its
 * `GARDEN_PAGES_PROJECT`) — another member's would land on the owner's site.
 * Otherwise: when the household serves public pages, and the member is not a
 * child (`siteFor` answers both).
 */
export function canDeploy(memberId: string, garden: GardenRef): boolean {
  if (ownSiteFor(memberId)) return garden.username === (process.env.GARDEN ?? "candide");
  return !!siteFor(memberId);
}

export function requestDeploy(garden: GardenRef, kind: Kind = "site"): DeployState {
  const slot = slotFor(garden.username);
  if (slot.running) {
    slot.again = kind;
    slot.state = { ...slot.state, status: "queued" };
    return { ...slot.state };
  }
  slot.running = true;
  slot.state = { status: "running", started_at: new Date().toISOString(), finished_at: null, error: null };
  const run = override ?? (kind === "pages" ? buildPublicPages : runScript);
  run(garden)
    .then(() => { slot.state = { ...slot.state, status: "idle", finished_at: new Date().toISOString(), error: null }; })
    .catch((err: Error) => {
      console.error(`[garden] deploy failed for ${garden.username}:`, err.message);
      slot.state = { ...slot.state, status: "failed", finished_at: new Date().toISOString(), error: err.message };
    })
    .finally(() => {
      slot.running = false;
      const next = slot.again;
      slot.again = null;
      if (next) requestDeploy(garden, next);
    });
  return { ...slot.state };
}
