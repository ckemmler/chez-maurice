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
 *   - **published**: the card's `public` flag, then a site deploy.
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
  assertLocale, assertSlug, atomicWrite, autoCommit, markOpened, parseFiche, writeFiche, type GardenRef,
} from "./gardenFiche";
import { listGardenEntries, type GardenEntry } from "./gardenEntries";
import { indexGardenPaths } from "./gardenIndex";
import {
  bookFor, isShelfCollection, isWritten, loadLibrary, preferredLocale, readFace, siteFor,
} from "./gardenShelf";

export class EntryWriteError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 422) {
    super(message);
  }
}

export interface EntryRef { collection: string; locale: string; slug: string }

export interface NoteInput {
  text?: string;
  quote?: string;
  /** A page (a book read on paper), or the chapter being read. */
  where?: { page?: string; chapter_title?: string };
}

const COMMENT_HEADING = "## Commentaire";
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

/**
 * One dated block, in the two shapes the shelf reads back: `DATE — text` on a
 * line of its own, or `DATE — <where> :` followed by the quote and the text.
 */
export function noteBlock(date: string, input: NoteInput): string {
  // A line of the member's that opens like a heading would close the section.
  const safe = (s: string) => s.trim().replace(/^(#{1,6}\s)/gm, "\\$1");
  const text = safe(input.text ?? "");
  const quote = (input.quote ?? "").trim();
  const page = (input.where?.page ?? "").trim();
  const chapter = (input.where?.chapter_title ?? "").replace(/\s+/g, " ").trim();
  const where = page ? `p. ${page}` : chapter ? `ch. ${chapter}` : "";

  if (!quote && !where && !text.includes("\n")) return `${date} — ${text}`;
  const blocks = [where ? `${date} — ${where} :` : `${date} :`];
  if (quote) blocks.push(quote.split("\n").map((l) => `> ${l}`.trimEnd()).join("\n"));
  if (text) blocks.push(text);
  return blocks.join("\n\n");
}

/**
 * The body with a block added at the end of `## Commentaire` — the end of the
 * section, not of the file: résonances may follow, and a note left under their
 * heading would be read back as one.
 */
export function withNote(body: string, block: string): string {
  const lines = body.replace(/\s+$/, "").split("\n");
  const at = lines.findIndex((l) => l.trim() === COMMENT_HEADING);
  if (at < 0) {
    const head = lines.join("\n").replace(/^\n+/, "");
    return `\n${head ? `${head}\n\n` : ""}${COMMENT_HEADING}\n\n${block}\n`;
  }
  let end = lines.findIndex((l, i) => i > at && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  const before = lines.slice(0, end).join("\n").replace(/\s+$/, "");
  const after = lines.slice(end).join("\n");
  return `\n${before.replace(/^\n+/, "")}\n\n${block}\n${after ? `\n${after}\n` : ""}`;
}

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
      date: today(),
      flags: [],
      image: entry.image ?? undefined,
      tags: entry.tags,
      locale: entry.locale,
      author: typeof fiche?.meta.author === "string" ? fiche.meta.author : undefined,
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
  return requestDeploy(garden);
}

// ── The site deploy ──
//
// `scripts/publish-web.sh` pulls the garden, builds the static site and
// uploads it: a few minutes, and nothing stops two from running at once. The
// phone can ask for one at any moment, so one runs at a time here, and
// whatever is asked while it runs is folded into a single run that follows —
// which then carries every flag set in the meantime.

export interface DeployState {
  status: "idle" | "queued" | "running" | "failed";
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

type Runner = (garden: GardenRef) => Promise<void>;

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

let runner: Runner = runScript;
let state: DeployState = { status: "idle", started_at: null, finished_at: null, error: null };
let running = false;
let again: GardenRef | null = null;

/** Tests replace the script with a stand-in. */
export function setDeployRunner(r: Runner | null): void {
  runner = r ?? runScript;
  state = { status: "idle", started_at: null, finished_at: null, error: null };
  running = false;
  again = null;
}

export function deployState(): DeployState {
  return { ...state };
}

/**
 * The script publishes one garden to one Pages project (`GARDEN`, by default
 * the owner's, and `GARDEN_PAGES_PROJECT`). Until a project per member exists,
 * only that garden may be deployed from here — another member's would land on
 * the owner's site.
 */
export function canDeploy(memberId: string, garden: GardenRef): boolean {
  return !!siteFor(memberId) && garden.username === (process.env.GARDEN ?? "candide");
}

export function requestDeploy(garden: GardenRef): DeployState {
  if (running) {
    again = garden;
    state = { ...state, status: "queued" };
    return deployState();
  }
  running = true;
  state = { status: "running", started_at: new Date().toISOString(), finished_at: null, error: null };
  runner(garden)
    .then(() => { state = { ...state, status: "idle", finished_at: new Date().toISOString(), error: null }; })
    .catch((err: Error) => {
      console.error("[garden] deploy failed:", err.message);
      state = { ...state, status: "failed", finished_at: new Date().toISOString(), error: err.message };
    })
    .finally(() => {
      running = false;
      const next = again;
      again = null;
      if (next) requestDeploy(next);
    });
  return deployState();
}
