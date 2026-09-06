/**
 * Flashcards on the garden's media — the third face of an entry, after the
 * card and the fiche.
 *
 *   <collection>/<locale>/<slug>-fiche/_cards/<unit>.md
 *
 * One file per generation unit: a book chapter, a whole book, the fiche
 * itself, or one of its fragments. The file is written in the syntax of the
 * Obsidian Spaced Repetition plugin, so the vault reviews the same cards the
 * app does:
 *
 *   #flashcards/books/being-you/chapter-03
 *
 *   Question
 *   ?
 *   Answer
 *   <!--SR:!2026-09-20,13,290-->
 *
 * Everything the plugin does not need lives in the frontmatter: where the
 * cards came from, a hash of that source at generation time (so a fiche that
 * has moved on since is reported as such), the language and mode of the pass,
 * and a fingerprint of every card as generated — which is how a hand-edited
 * card is recognised and kept across a regeneration.
 *
 * The review schedule is the plugin's own `<!--SR:due,interval,ease-->`
 * comment after each card, written by whichever side reviewed last. The
 * `_cards/` directory is git-ignored: a review must not be a commit, and the
 * cards are regenerable from their source.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getHouseholdConfig } from "../../src/services/claude";
import {
  assertLocale,
  assertSlug,
  atomicWrite,
  autoCommit,
  dumpFrontmatter,
  fichePath,
  fragmentsDir,
  gardenFor,
  parseFiche,
  writeFiche,
  RESOURCE_COLLECTIONS,
  type GardenRef,
  type ResourceCollection,
} from "./gardenFiche";
import { indexGardenPaths } from "./gardenIndex";
import { listGardenEntries, type GardenEntry } from "./gardenEntries";
import { findBookEntryByTitle } from "./gardenLinks";
import { slugify } from "./articleExtract";
import { getBookMetadata, getChapterBySlug, listChapters } from "./calibre";

/** Loaded on first use, not at import: highlights.ts binds its database path
 *  the moment it is imported, and the test suites rely on being the ones to
 *  set that path — a static import here would bind it first, to the real
 *  database, for every suite that runs after this module loads. */
async function bookHighlights(memberId: string, bookId: number) {
  const { listHighlights } = await import("./highlights");
  return listHighlights(memberId, bookId);
}

// ── Types ──

export type CardSource =
  | { kind: "chapter"; book_id: number; chapter: string }
  | { kind: "book"; book_id: number }
  | { kind: "fiche"; collection: ResourceCollection; locale: string; slug: string }
  | { kind: "fragment"; collection: ResourceCollection; locale: string; slug: string; fragment: string };

export type CardMode = "comprehension" | "vocabulary";
export const CARD_MODES: CardMode[] = ["comprehension", "vocabulary"];

export type Rating = "hard" | "good" | "easy";

/** The plugin's per-card schedule: `<!--SR:!YYYY-MM-DD,interval,ease-->`. */
export interface Schedule {
  due: string;
  /** Days. */
  interval: number;
  /** Percent × 1: the plugin's 250 is an ease of 2.5. */
  ease: number;
}

export interface Card {
  /** First 8 hex of the question's hash — stable while the question is. A
   *  question rewritten by hand becomes a new id, and the card reads as
   *  hand-written from then on; nothing is lost by that, since its schedule
   *  travels in the file and hand-written cards survive regeneration too. */
  id: string;
  question: string;
  answer: string;
  /** `:::` / `??` cards review both ways. */
  reversed: boolean;
  /** `==term==` cards: the question is the whole text with the deletions. */
  cloze: boolean;
  schedule: Schedule | null;
  /** True when the text no longer matches the fingerprint taken at generation. */
  edited: boolean;
  /** Hand-written in the vault, unknown to any generation pass. */
  manual: boolean;
}

export interface CardFileMeta {
  source: CardSource;
  source_hash: string;
  generated_at: string;
  model: string;
  lang: string;
  answer_lang: string;
  mode: CardMode;
  /** id → fingerprint of question+answer as generated. */
  cards: Record<string, string>;
  /** Free-form hint carried into the prompt, when the caller gave one. */
  hint?: string;
}

export interface CardFile {
  /** Garden-relative path. */
  file: string;
  /** The `_cards/<unit>.md` basename without extension. */
  unit: string;
  meta: CardFileMeta;
  cards: Card[];
  /** The plugin deck tag line. */
  deck: string;
}

export interface CardFileStatus extends CardFile {
  /** The source has changed since the pass. Null when it cannot be read. */
  stale: boolean | null;
  due: number;
  total: number;
}

export class FlashcardError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 422 | 502) {
    super(message);
  }
}

const DEFAULT_LOCALE = "fr";
const DEFAULT_LANG = "fr";
export const CARDS_MODEL = "claude-opus-5";

// ── Hashing ──

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function cardId(question: string): string {
  return sha(normalise(question)).slice(0, 8);
}

export function cardFingerprint(question: string, answer: string): string {
  return sha(`${normalise(question)}\n?\n${normalise(answer)}`).slice(0, 12);
}

// ── Paths ──

/** `<fiche dir>/<slug>-fiche/_cards/` — beside the fragments. */
export function cardsDir(ficheFile: string): string {
  return path.join(path.dirname(ficheFile), path.basename(ficheFile, ".md"), "_cards");
}

export function unitFor(source: CardSource): string {
  switch (source.kind) {
    case "chapter": return `chapter-${assertSlug(source.chapter)}`;
    case "book": return "book";
    case "fiche": return "fiche";
    case "fragment": return `fragment-${source.fragment.replace(/[^0-9a-z-]/gi, "")}`;
  }
}

const GITIGNORE_LINE = "**/_cards/";

/** Make sure the member's garden ignores its card files — once, committed. */
export function ensureCardsIgnored(garden: GardenRef): void {
  const file = path.join(garden.root, ".gitignore");
  let current = "";
  try {
    current = fs.readFileSync(file, "utf-8");
  } catch {
    current = "";
  }
  if (current.split("\n").some((l) => l.trim() === GITIGNORE_LINE)) return;
  const next = `${current.replace(/\n*$/, "")}${current ? "\n" : ""}# Flashcards: reviews rewrite them, and they regenerate from their source.\n${GITIGNORE_LINE}\n`;
  atomicWrite(file, next);
  autoCommit(garden, [file], "Ignore flashcard files");
}

// ── The plugin's syntax ──

const SR_RE = /\s*<!--SR:!?(\d{4}-\d{2}-\d{2}),(\d+),(\d+)-->\s*$/;

export function parseSchedule(text: string): { text: string; schedule: Schedule | null } {
  const m = text.match(SR_RE);
  if (!m) return { text, schedule: null };
  return {
    text: text.slice(0, m.index).trimEnd(),
    schedule: { due: m[1]!, interval: Number(m[2]), ease: Number(m[3]) },
  };
}

export function formatSchedule(s: Schedule): string {
  return `<!--SR:!${s.due},${s.interval},${s.ease}-->`;
}

/** One card block → its parts, or null when the block is not a card. */
export function parseCardBlock(block: string): Omit<Card, "id" | "edited" | "manual"> | null {
  const { text, schedule } = parseSchedule(block.trim());
  const lines = text.split("\n");

  const sep = lines.findIndex((l) => l.trim() === "?" || l.trim() === "??");
  if (sep > 0 && sep < lines.length - 1) {
    return {
      question: lines.slice(0, sep).join("\n").trim(),
      answer: lines.slice(sep + 1).join("\n").trim(),
      reversed: lines[sep]!.trim() === "??",
      cloze: false,
      schedule,
    };
  }
  if (lines.length === 1) {
    const line = lines[0]!;
    const three = line.indexOf(":::");
    if (three > 0) {
      return { question: line.slice(0, three).trim(), answer: line.slice(three + 3).trim(), reversed: true, cloze: false, schedule };
    }
    const two = line.indexOf("::");
    if (two > 0) {
      return { question: line.slice(0, two).trim(), answer: line.slice(two + 2).trim(), reversed: false, cloze: false, schedule };
    }
  }
  const deletions = [...text.matchAll(/==([^=]+)==/g)].map((m) => m[1]!.trim());
  if (deletions.length) {
    return { question: text.trim(), answer: deletions.join(" · "), reversed: false, cloze: true, schedule };
  }
  return null;
}

export function formatCard(card: Pick<Card, "question" | "answer" | "reversed" | "cloze" | "schedule">): string {
  let body: string;
  if (card.cloze) {
    body = card.question;
  } else if (!card.question.includes("\n") && !card.answer.includes("\n") && card.question.length + card.answer.length < 120) {
    body = `${card.question}${card.reversed ? ":::" : "::"}${card.answer}`;
  } else {
    body = `${card.question}\n${card.reversed ? "??" : "?"}\n${card.answer}`;
  }
  if (!card.schedule) return body;
  // The plugin puts the comment on the card's last line for one-liners and on
  // its own line after a multi-line card.
  return body.includes("\n") ? `${body}\n${formatSchedule(card.schedule)}` : `${body} ${formatSchedule(card.schedule)}`;
}

export function deckTag(source: CardSource, entry: { collection: string; slug: string }): string {
  return `#flashcards/${entry.collection}/${entry.slug}/${unitFor(source)}`;
}

// ── Reading a card file ──

export function parseCardFile(garden: GardenRef, absFile: string): CardFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(absFile, "utf-8");
  } catch {
    return null;
  }
  const parsed = parseFiche(raw);
  if (!parsed) return null;
  const meta = parsed.frontmatter as unknown as CardFileMeta;
  if (!meta?.source || typeof meta.source !== "object") return null;
  const known = (meta.cards ?? {}) as Record<string, string>;

  const blocks = parsed.body.split(/\n[ \t]*\n/);
  let deck = "";
  const cards: Card[] = [];
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (/^#flashcards(\/\S*)?(\s+#\S+)*$/.test(trimmed)) {
      deck = trimmed;
      continue;
    }
    const c = parseCardBlock(trimmed);
    if (!c) continue;
    const id = cardId(c.question);
    const fp = known[id];
    cards.push({
      ...c,
      id,
      manual: fp === undefined,
      edited: fp !== undefined && fp !== cardFingerprint(c.question, c.answer),
    });
  }
  return {
    file: path.relative(garden.root, absFile),
    unit: path.basename(absFile, ".md"),
    meta: { ...meta, cards: known },
    cards,
    deck,
  };
}

export function writeCardFile(absFile: string, meta: CardFileMeta, deck: string, cards: Card[]): void {
  // A fingerprint is what the generator wrote, never what the reader changed it
  // into: an edited card keeps its old one, so it still reads as edited after
  // any rewrite (a review, say) and survives the next regeneration.
  const fingerprints: Record<string, string> = {};
  for (const c of cards) {
    if (c.manual) continue;
    fingerprints[c.id] = c.edited ? (meta.cards[c.id] ?? cardFingerprint(c.question, c.answer)) : cardFingerprint(c.question, c.answer);
  }
  const fm = { ...meta, cards: fingerprints };
  const body = [deck, ...cards.map(formatCard)].join("\n\n");
  atomicWrite(absFile, `---\n${dumpFrontmatter(fm as any)}\n---\n\n${body}\n`);
}

// ── Sources ──

interface SourceText {
  title: string;
  text: string;
  /** Passages the reader marked, with their notes — first-class input. */
  highlights: { quote: string; note: string | null }[];
  /** Which language the text is in, when known — steers vocabulary mode. */
  lang?: string;
}

/** Where the cards of a source live: its garden entry and fiche file. */
export interface SourceHome {
  entry: GardenEntry;
  ficheFile: string;
}

export function fingerprintSource(s: SourceText): string {
  const hl = s.highlights
    .map((h) => `${normalise(h.quote)}|${normalise(h.note ?? "")}`)
    .sort()
    .join("\n");
  return sha(`${normalise(s.text)}\n--\n${hl}`);
}

async function readChapter(memberId: string, bookId: number, slug: string): Promise<SourceText> {
  const ch = await getChapterBySlug(bookId, slug);
  if (!ch) throw new FlashcardError(`Chapter not found: ${bookId}/${slug}`, 404);
  const highlights = (await bookHighlights(memberId, bookId))
    .filter((h) => h.chapter_slug === slug)
    .map((h) => ({ quote: h.quote, note: h.note }));
  return { title: ch.title, text: ch.text, highlights };
}

async function readBook(memberId: string, bookId: number): Promise<SourceText> {
  const book = await getBookMetadata(bookId);
  const chapters = await listChapters(bookId);
  if (!book || !chapters) throw new FlashcardError(`Book not found: ${bookId}`, 404);
  const parts: string[] = [];
  for (const c of chapters) {
    const ch = await getChapterBySlug(bookId, c.slug);
    if (ch) parts.push(`## ${ch.title}\n\n${ch.text}`);
  }
  const highlights = (await bookHighlights(memberId, bookId)).map((h) => ({ quote: h.quote, note: h.note }));
  return { title: book.title, text: parts.join("\n\n"), highlights };
}

function readFiche(garden: GardenRef, collection: ResourceCollection, locale: string, slug: string): { source: SourceText; file: string } {
  const file = fichePath(garden, collection, locale, slug);
  let parsed;
  try {
    parsed = parseFiche(fs.readFileSync(file, "utf-8"));
  } catch {
    parsed = null;
  }
  if (!parsed) throw new FlashcardError(`Fiche not found: ${collection}/${locale}/${slug}`, 404);
  const meta = (parsed.frontmatter.meta ?? {}) as Record<string, any>;
  const head = [
    meta.author ? `Author: ${meta.author}` : "",
    meta.description ? `Description: ${meta.description}` : "",
    meta.excerpt ? `Excerpt: ${meta.excerpt}` : "",
    meta.summary ? `Summary: ${meta.summary}` : "",
  ].filter(Boolean).join("\n");
  return {
    file,
    source: {
      title: String(parsed.frontmatter.title ?? slug),
      text: `${head}\n\n${parsed.body.trim()}`.trim(),
      highlights: [],
      lang: String(meta.lang ?? "") || undefined,
    },
  };
}

function readFragment(garden: GardenRef, collection: ResourceCollection, locale: string, slug: string, fragment: string): { source: SourceText; file: string } {
  const file = fichePath(garden, collection, locale, slug);
  const frag = path.join(fragmentsDir(file), `${fragment.replace(/[^0-9a-z-]/gi, "")}.frag`);
  let raw: string;
  try {
    raw = fs.readFileSync(frag, "utf-8");
  } catch {
    throw new FlashcardError(`Fragment not found: ${collection}/${locale}/${slug}/${fragment}`, 404);
  }
  const parsed = parseFiche(raw);
  const title = String(parsed?.frontmatter.summary ?? `${slug} — fragment ${fragment}`);
  return { file, source: { title, text: (parsed?.body ?? raw).trim(), highlights: [] } };
}

/** The source's text and the fiche its cards belong to. Opens a fiche for a
 *  Calibre book that has none yet — asking for cards is the deliberate
 *  gesture that earns a book its fiche. */
export async function resolveSource(
  memberId: string,
  garden: GardenRef,
  source: CardSource,
): Promise<{ text: SourceText; home: SourceHome }> {
  switch (source.kind) {
    case "chapter": {
      const text = await readChapter(memberId, source.book_id, source.chapter);
      return { text, home: await bookHome(memberId, garden, source.book_id) };
    }
    case "book": {
      const text = await readBook(memberId, source.book_id);
      return { text, home: await bookHome(memberId, garden, source.book_id) };
    }
    case "fiche": {
      const { source: text, file } = readFiche(garden, source.collection, source.locale, source.slug);
      return { text, home: entryHome(garden, source.collection, source.locale, source.slug, file) };
    }
    case "fragment": {
      const { source: text, file } = readFragment(garden, source.collection, source.locale, source.slug, source.fragment);
      return { text, home: entryHome(garden, source.collection, source.locale, source.slug, file) };
    }
  }
}

function entryHome(garden: GardenRef, collection: string, locale: string, slug: string, ficheFile: string): SourceHome {
  const entry = listGardenEntries(garden).find(
    (e) => e.collection === collection && e.locale === locale && e.slug === slug,
  );
  if (!entry) throw new FlashcardError(`No garden entry for ${collection}/${locale}/${slug}`, 404);
  return { entry, ficheFile };
}

async function bookHome(memberId: string, garden: GardenRef, bookId: number): Promise<SourceHome> {
  const book = await getBookMetadata(bookId);
  if (!book) throw new FlashcardError(`Book not found: ${bookId}`, 404);

  const existing = findBookEntryByTitle(garden, book.title);
  if (existing?.fiche) {
    return { entry: existing, ficheFile: path.join(garden.root, existing.fiche.file) };
  }

  // A published card with no fiche, or nothing at all: open the fiche.
  const locale = existing?.locale ?? DEFAULT_LOCALE;
  const slug = existing?.slug ?? slugify(book.title) ?? "book";
  const file = fichePath(garden, "books", locale, assertSlug(slug));
  const today = new Date().toISOString().slice(0, 10);
  writeFiche(
    file,
    {
      title: book.title,
      resource_collection: "books",
      resource_id: slug,
      date: today,
      tags: [],
      locale,
      meta: {
        title: book.title,
        author: book.authors.join(", ") || undefined,
        calibre_id: bookId,
        description: book.description || undefined,
      },
    },
    "",
  );
  autoCommit(garden, [file], `Open book fiche for flashcards: books/${slug}`);
  indexGardenPaths(memberId, [file]);

  const entry = listGardenEntries(garden).find((e) => e.collection === "books" && e.locale === locale && e.slug === slug);
  if (!entry) throw new FlashcardError("Could not open a fiche for the book", 422);
  return { entry, ficheFile: file };
}

// ── Generation ──

export interface GenerateOptions {
  lang?: string;
  answer_lang?: string;
  mode?: CardMode;
  /** How many cards to ask for; a sensible default per source kind otherwise. */
  count?: number;
  /** Extra steering, verbatim into the prompt. */
  hint?: string;
  /** Test seam: what turns a prompt into the model's JSON. */
  generator?: (prompt: string) => Promise<string>;
}

interface Draft {
  q: string;
  a: string;
  type?: "basic" | "reversed" | "cloze";
}

function defaultCount(kind: CardSource["kind"]): number {
  return kind === "book" ? 24 : kind === "chapter" ? 10 : kind === "fragment" ? 8 : 6;
}

/** Full language name for the prompt. Unknown codes are passed through. */
function languageName(code: string): string {
  const names: Record<string, string> = {
    fr: "French", en: "English", de: "German", zh: "Chinese (Mandarin, simplified characters, with pinyin)",
    it: "Italian", es: "Spanish", pt: "Portuguese", nl: "Dutch", ja: "Japanese",
  };
  return names[code.toLowerCase().slice(0, 2)] ?? code;
}

const MAX_TEXT_CHARS = 600_000;

export function buildCardsPrompt(
  source: CardSource,
  text: SourceText,
  opts: { lang: string; answer_lang: string; mode: CardMode; count: number; hint?: string },
): string {
  const what =
    source.kind === "chapter" ? `a chapter, "${text.title}", of a book` :
    source.kind === "book" ? `a whole book, "${text.title}"` :
    source.kind === "fragment" ? `a passage ("${text.title}")` :
    `the reader's own notes on "${text.title}" — comments, resonances, and the metadata of the work`;

  const highlights = text.highlights.length
    ? [
        "",
        "The reader marked these passages while reading (with their notes where they wrote one).",
        "They say what mattered to this reader: draw on them first, and make sure each one",
        "that carries an idea is covered by at least one card.",
        "",
        ...text.highlights.map((h) => `- "${h.quote.replace(/\s+/g, " ").trim()}"${h.note ? ` — note: ${h.note.trim()}` : ""}`),
      ]
    : [];

  const task =
    opts.mode === "vocabulary"
      ? [
          `Make ${opts.count} vocabulary flashcards from the text, for a learner of ${languageName(opts.lang)}.`,
          `Pick words and expressions worth learning — useful, idiomatic, or central to the text — over rare ones.`,
          `The question is the word or expression in ${languageName(opts.lang)}, exactly as it appears; the answer is its`,
          `meaning in ${languageName(opts.answer_lang)}, then a short example sentence from or in the spirit of the text.`,
          `Mark them "reversed" so they are reviewed both ways.`,
        ]
      : [
          `Make ${opts.count} flashcards that test understanding of ${what}.`,
          `Each card asks one precise thing — a claim, a mechanism, a distinction, a name, a number — and the answer`,
          `is short: one or two sentences, never a paragraph. Prefer questions whose answer is in the text over`,
          `general knowledge. No trivia about the book as an object (page counts, publishers).`,
          `Write the questions in ${languageName(opts.lang)} and the answers in ${languageName(opts.answer_lang)}.`,
          `Use "cloze" for a card where one key term in a sentence is what should be recalled: the question is the`,
          `sentence with that term wrapped in ==double equals==, and the answer is the term.`,
        ];

  return [
    `Here is ${what}.`,
    ...highlights,
    "",
    ...task,
    ...(opts.hint ? ["", `Additional instruction from the reader: ${opts.hint}`] : []),
    "",
    `Return a JSON array and nothing else: [{"q": "...", "a": "...", "type": "basic" | "reversed" | "cloze"}, …].`,
    "",
    "---",
    "",
    text.text,
  ].join("\n");
}

async function callModel(prompt: string): Promise<string> {
  const { apiKey } = getHouseholdConfig();
  if (!apiKey) throw new FlashcardError("no Anthropic API key configured for this household", 422);
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: CARDS_MODEL,
      max_tokens: 16_000,
      output_config: { effort: "medium" },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok) throw new FlashcardError(`Anthropic API error: ${response.status} ${await response.text()}`, 502);
  const result = (await response.json()) as { stop_reason?: string; content: Array<{ type: string; text?: string }> };
  if (result.stop_reason === "refusal") throw new FlashcardError("model declined to make cards", 422);
  return result.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
}

export function parseDrafts(raw: string): Draft[] {
  const json = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = json.indexOf("[");
  const end = json.lastIndexOf("]");
  if (start < 0 || end < start) throw new FlashcardError("model did not return a JSON array of cards", 502);
  let arr: unknown;
  try {
    arr = JSON.parse(json.slice(start, end + 1));
  } catch {
    throw new FlashcardError("model returned malformed JSON", 502);
  }
  if (!Array.isArray(arr)) throw new FlashcardError("model did not return a JSON array of cards", 502);
  return arr
    .filter((d: any) => d && typeof d.q === "string" && typeof d.a === "string" && d.q.trim() && d.a.trim())
    .map((d: any) => ({
      q: String(d.q).trim(),
      a: String(d.a).trim(),
      type: d.type === "reversed" || d.type === "cloze" ? d.type : "basic",
    }));
}

/**
 * Generate (or regenerate) the cards of one source.
 *
 * On a regeneration, cards the reader edited or wrote by hand are kept as they
 * are, schedule included; generated cards are replaced, and a regenerated card
 * with the same question keeps its id and therefore its schedule.
 */
export async function generateCards(
  memberId: string,
  source: CardSource,
  opts: GenerateOptions = {},
): Promise<CardFileStatus> {
  const garden = gardenFor(memberId);
  if (!garden) throw new FlashcardError("No garden for this member", 404);
  const { text, home } = await resolveSource(memberId, garden, source);
  if (!text.text.trim()) throw new FlashcardError("The source has no text to make cards from", 422);
  if (text.text.length > MAX_TEXT_CHARS) throw new FlashcardError(`The source is ${text.text.length} characters, above the ${MAX_TEXT_CHARS} guard`, 422);

  // Language: the call, then the fiche's `cards_lang`, then the household default.
  const ficheLang = ficheCardsLang(home.ficheFile);
  const lang = (opts.lang ?? ficheLang ?? DEFAULT_LANG).toLowerCase();
  const answer_lang = (opts.answer_lang ?? (opts.mode === "vocabulary" ? DEFAULT_LANG : lang)).toLowerCase();
  const mode: CardMode = opts.mode ?? "comprehension";
  const count = opts.count && opts.count > 0 ? Math.min(60, opts.count) : defaultCount(source.kind);

  const prompt = buildCardsPrompt(source, text, { lang, answer_lang, mode, count, hint: opts.hint });
  const drafts = parseDrafts(await (opts.generator ?? callModel)(prompt));
  if (!drafts.length) throw new FlashcardError("model returned no cards", 502);

  ensureCardsIgnored(garden);
  const dir = cardsDir(home.ficheFile);
  fs.mkdirSync(dir, { recursive: true });
  const absFile = path.join(dir, `${unitFor(source)}.md`);
  const previous = parseCardFile(garden, absFile);

  // What survives from the previous pass: hand-written and edited cards as they
  // are, and the schedule of any generated card whose question comes back.
  const kept: Card[] = previous ? previous.cards.filter((c) => c.manual || c.edited) : [];
  const keptIds = new Set(kept.map((c) => c.id));
  const oldSchedule = new Map<string, Schedule | null>(previous ? previous.cards.map((c) => [c.id, c.schedule]) : []);

  const fresh: Card[] = [];
  for (const d of drafts) {
    const id = cardId(d.q);
    if (keptIds.has(id) || fresh.some((c) => c.id === id)) continue;
    fresh.push({
      id,
      question: d.q,
      answer: d.a,
      reversed: d.type === "reversed",
      cloze: d.type === "cloze",
      schedule: oldSchedule.get(id) ?? null,
      edited: false,
      manual: false,
    });
  }

  const meta: CardFileMeta = {
    source,
    source_hash: fingerprintSource(text),
    generated_at: new Date().toISOString().slice(0, 10),
    model: opts.generator ? "test" : CARDS_MODEL,
    lang,
    answer_lang,
    mode,
    // An edited card keeps the fingerprint the pass that made it wrote, so it
    // goes on reading as edited; writeCardFile computes every other one.
    cards: Object.fromEntries(kept.filter((c) => c.edited).map((c) => [c.id, previous!.meta.cards[c.id]!])),
    hint: opts.hint || undefined,
  };
  const deck = deckTag(source, home.entry);
  writeCardFile(absFile, meta, deck, [...fresh, ...kept]);

  const written = parseCardFile(garden, absFile)!;
  return { ...written, stale: false, due: countDue(written.cards), total: written.cards.length };
}

/** `cards_lang` on the fiche's frontmatter, when the reader set one. */
function ficheCardsLang(ficheFile: string): string | undefined {
  try {
    const parsed = parseFiche(fs.readFileSync(ficheFile, "utf-8"));
    const v = parsed?.frontmatter.cards_lang;
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

// ── Status ──

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isDue(card: Card, on = today()): boolean {
  return !card.schedule || card.schedule.due <= on;
}

export function countDue(cards: Card[], on = today()): number {
  return cards.filter((c) => isDue(c, on)).length;
}

/** Every card file of an entry, with staleness recomputed against the source. */
export async function listCardFiles(memberId: string, garden: GardenRef, entry: GardenEntry): Promise<CardFileStatus[]> {
  if (!entry.fiche) return [];
  const dir = cardsDir(path.join(garden.root, entry.fiche.file));
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const out: CardFileStatus[] = [];
  for (const name of names) {
    const cf = parseCardFile(garden, path.join(dir, name));
    if (!cf) continue;
    let stale: boolean | null = null;
    try {
      const { text } = await resolveSource(memberId, garden, cf.meta.source);
      stale = fingerprintSource(text) !== cf.meta.source_hash;
    } catch {
      stale = null;
    }
    out.push({ ...cf, stale, due: countDue(cf.cards), total: cf.cards.length });
  }
  return out;
}

/** The cheap face for the entries list: counts only, no source re-read. */
export interface CardsFace {
  files: number;
  total: number;
  due: number;
  generated_at: string | null;
}

export function cardsFace(garden: GardenRef, ficheRelFile: string): CardsFace | null {
  const dir = cardsDir(path.join(garden.root, ficheRelFile));
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return null;
  }
  const face: CardsFace = { files: 0, total: 0, due: 0, generated_at: null };
  const on = today();
  for (const name of names) {
    const cf = parseCardFile(garden, path.join(dir, name));
    if (!cf) continue;
    face.files++;
    face.total += cf.cards.length;
    face.due += countDue(cf.cards, on);
    if (!face.generated_at || cf.meta.generated_at > face.generated_at) face.generated_at = cf.meta.generated_at;
  }
  return face.files ? face : null;
}

export interface DueCard extends Card {
  file: string;
  unit: string;
  deck: string;
  source: CardSource;
  entry: { collection: string; locale: string; slug: string; title: string };
}

/** Every due card in the garden, oldest due first, new cards last. */
export function listDueCards(garden: GardenRef, on = today()): DueCard[] {
  const out: DueCard[] = [];
  for (const entry of listGardenEntries(garden)) {
    if (!entry.fiche) continue;
    const dir = cardsDir(path.join(garden.root, entry.fiche.file));
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const cf = parseCardFile(garden, path.join(dir, name));
      if (!cf) continue;
      for (const c of cf.cards) {
        if (!isDue(c, on)) continue;
        out.push({
          ...c,
          file: cf.file,
          unit: cf.unit,
          deck: cf.deck,
          source: cf.meta.source,
          entry: { collection: entry.collection, locale: entry.locale, slug: entry.slug, title: entry.title },
        });
      }
    }
  }
  return out.sort((a, b) => {
    const da = a.schedule?.due ?? "9999", db = b.schedule?.due ?? "9999";
    return da < db ? -1 : da > db ? 1 : 0;
  });
}

// ── Review (the plugin's SM-2) ──
//
// Mirrors the plugin's defaults so a card reviewed here and one reviewed in
// the vault follow the same curve: base ease 250, easy bonus 1.3, a hard
// answer halves the interval and costs 20 ease, an easy one earns 20.

const BASE_EASE = 250;
const MIN_EASE = 130;
const EASY_BONUS = 1.3;
const MAX_INTERVAL = 36_500;

export function nextSchedule(current: Schedule | null, rating: Rating, on = today()): Schedule {
  let ease = current?.ease ?? BASE_EASE;
  let interval = current?.interval ?? 1;
  const fresh = !current;
  if (rating === "hard") {
    ease = Math.max(MIN_EASE, ease - 20);
    interval = fresh ? 1 : Math.max(1, interval * 0.5);
  } else if (rating === "good") {
    interval = fresh ? 1 : (interval * ease) / 100;
  } else {
    ease += 20;
    interval = fresh ? 4 : (interval * ease * EASY_BONUS) / 100;
  }
  interval = Math.min(MAX_INTERVAL, Math.max(1, Math.round(interval)));
  const due = new Date(`${on}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() + interval);
  return { due: due.toISOString().slice(0, 10), interval, ease };
}

/** Record one answer: rewrite the card's SR comment in its file. */
export function reviewCard(garden: GardenRef, relFile: string, id: string, rating: Rating, on = today()): Card {
  const absFile = safeCardsPath(garden, relFile);
  const cf = parseCardFile(garden, absFile);
  if (!cf) throw new FlashcardError(`Card file not found: ${relFile}`, 404);
  const card = cf.cards.find((c) => c.id === id);
  if (!card) throw new FlashcardError(`Card not found: ${id}`, 404);
  card.schedule = nextSchedule(card.schedule, rating, on);
  writeCardFile(absFile, cf.meta, cf.deck, cf.cards);
  return card;
}

/** Replace the body (deck line + cards) with what the reader edited, keeping
 *  the pass's metadata. Fingerprints are left as they were, so edited cards
 *  read as edited afterwards. */
export function saveCardFileBody(garden: GardenRef, relFile: string, body: string): CardFile {
  const absFile = safeCardsPath(garden, relFile);
  const cf = parseCardFile(garden, absFile);
  if (!cf) throw new FlashcardError(`Card file not found: ${relFile}`, 404);
  atomicWrite(absFile, `---\n${dumpFrontmatter(cf.meta as any)}\n---\n\n${body.trim()}\n`);
  return parseCardFile(garden, absFile)!;
}

export function readCardFile(garden: GardenRef, relFile: string): CardFile & { body: string } {
  const absFile = safeCardsPath(garden, relFile);
  const cf = parseCardFile(garden, absFile);
  if (!cf) throw new FlashcardError(`Card file not found: ${relFile}`, 404);
  const body = parseFiche(fs.readFileSync(absFile, "utf-8"))?.body.trim() ?? "";
  return { ...cf, body };
}

/** A garden-relative `…/_cards/<unit>.md` path, or an error. */
function safeCardsPath(garden: GardenRef, relFile: string): string {
  const abs = path.resolve(garden.root, relFile);
  const root = path.resolve(garden.root);
  if (!abs.startsWith(root + path.sep)) throw new FlashcardError("path escapes the garden", 400);
  if (path.basename(path.dirname(abs)) !== "_cards" || !abs.endsWith(".md")) {
    throw new FlashcardError("not a card file", 400);
  }
  return abs;
}

// ── Validating a source from the wire ──

export function parseSource(input: any): CardSource {
  if (!input || typeof input !== "object") throw new FlashcardError("source is required", 400);
  const kind = input.kind;
  if (kind === "chapter" || kind === "book") {
    const book_id = Number(input.book_id);
    if (!Number.isInteger(book_id) || book_id <= 0) throw new FlashcardError("book_id must be a positive integer", 400);
    if (kind === "book") return { kind, book_id };
    const chapter = String(input.chapter ?? "");
    if (!chapter) throw new FlashcardError("chapter is required", 400);
    return { kind, book_id, chapter };
  }
  if (kind === "fiche" || kind === "fragment") {
    const collection = String(input.collection ?? "");
    if (!(RESOURCE_COLLECTIONS as readonly string[]).includes(collection)) {
      throw new FlashcardError(`collection must be one of: ${RESOURCE_COLLECTIONS.join(", ")}`, 400);
    }
    let locale: string, slug: string;
    try {
      locale = assertLocale(String(input.locale ?? DEFAULT_LOCALE));
      slug = assertSlug(String(input.slug ?? ""));
    } catch (e) {
      throw new FlashcardError((e as Error).message, 400);
    }
    if (kind === "fiche") return { kind, collection: collection as ResourceCollection, locale, slug };
    const fragment = String(input.fragment ?? "");
    if (!/^[0-9a-z-]+$/i.test(fragment)) throw new FlashcardError("fragment must name a .frag file (e.g. 001)", 400);
    return { kind, collection: collection as ResourceCollection, locale, slug, fragment };
  }
  throw new FlashcardError("source.kind must be chapter, book, fiche or fragment", 400);
}
