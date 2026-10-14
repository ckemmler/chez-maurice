/**
 * Carnet suggestions — what a conversation is worth keeping
 * (specs/carnet-suggestions.md, 9 October 2026).
 *
 * A member asks who plays Moira in Schitt's Creek. Nothing of that reaches
 * their garden unless they think to ask. So, after each reply of a
 * conversation they have alone with Maurice, a pass of its own — never on the
 * reply's path — names the works and people the exchange was about, and what
 * it said of each. Each is then resolved without a model: the member's garden
 * first, a provider for what the garden does not hold. The app shows them
 * behind the Carnet mark in the conversation's header.
 *
 * The rule is the life facts' one: Maurice proposes, the member decides.
 * Nothing is written in the garden until they keep a suggestion; keeping one
 * is the deliberate gesture that opens a fiche, and the note it files is on
 * the fiche — the member's side — never on the card.
 */

import fs from "node:fs";
import path from "node:path";
import db from "../db";
import { ancillaryComplete, type AncillaryRequest, type AncillaryResult } from "./ancillary";
import { recordSpend } from "./budget";
import { countParticipants, getConversation } from "./conversations";
import { McpSession } from "./mcpClient";
import { publishToUser } from "./roomBus";
import { getUser, isGuest } from "./users";
import {
  autoCommit, fichePath, gardenFor, markOpened, parseFiche, writeFiche, type GardenRef, type ResourceCollection,
} from "../../data-api/services/gardenFiche";
import { listGardenEntries, type GardenEntry } from "../../data-api/services/gardenEntries";
import { indexGardenPaths } from "../../data-api/services/gardenIndex";
import { noteBlock, withNote } from "../../data-api/services/gardenNote";
import { appendResonance } from "../../data-api/services/gardenLinks";
import { userLocale } from "./i18n";

// ── Shapes ───────────────────────────────────────────────────────────────────

/** What the pass may name: a garden collection each. */
export const SUGGESTION_KINDS = ["movies", "series", "books", "music", "podcasts", "games", "people"] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

const MAX_PER_TURN = 3;
// Room for the three sentences asked for, in French, with their names and
// dates: at 500 a note for the entry was cut in the middle of a word.
const NOTE_MAX_CHARS = 900;
const MAX_CANDIDATES = 5;

export interface Candidate {
  id: string;
  title: string;
  year: number | null;
  subtitle: string;
  image: string;
}

export interface EntrySuggestion {
  id: string;
  member_id: string;
  conversation_id: string;
  message_id: string | null;
  /** A garden collection: one of SUGGESTION_KINDS, or the bound entry's own. */
  kind: string;
  key: string;
  title: string;
  year: number | null;
  subtitle: string | null;
  image: string | null;
  public: boolean;
  /** More than one possible identity: the member picks before keeping. */
  candidates: Candidate[];
  /** `<collection>/<locale>/<slug>` of the garden entry this is, when there is one. */
  existing: string | null;
  note: string;
  state: "proposed" | "kept" | "dismissed";
  kept_path: string | null;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
  /** The last term searched for it, once the member asked for another look. */
  query: string | null;
  /** Every candidate id already shown: a new look does not bring them back. */
  seen: string[];
}

/** What the pass says of one subject, before anything is resolved. */
export interface Named {
  kind: string;
  title: string;
  year?: number | null;
  creator?: string;
  public?: boolean;
  note: string;
}

function hydrate(row: any): EntrySuggestion {
  let candidates: Candidate[] = [];
  let seen: string[] = [];
  try { candidates = row.candidates ? JSON.parse(row.candidates) : []; } catch {}
  try { seen = row.seen ? JSON.parse(row.seen) : []; } catch {}
  // Rows filed before the copies were folded (14 October 2026) fold on read.
  return { ...row, public: !!row.public, candidates: distinct(candidates), query: row.query ?? null, seen };
}

// ── A conversation held from an entry ───────────────────────────────────────

/** The caller's own entry under this ref, as `<collection>/<locale>/<slug>` —
 *  or null: malformed, not a kind that is kept here, or not in their garden. */
export function ownEntryRef(memberId: string, ref: string): string | null {
  const [collection, locale, slug, ...rest] = ref.split("/");
  if (rest.length || !collection || !locale || !slug) return null;
  const garden = gardenFor(memberId);
  if (!garden) return null;
  const entry = listGardenEntries(garden).find((e) => e.collection === collection && e.locale === locale && e.slug === slug);
  return entry ? `${entry.collection}/${entry.locale}/${entry.slug}` : null;
}

/** The entry a conversation is held from, when it is and the entry is still there. */
function boundEntry(memberId: string, conversationId: string): GardenEntry | null {
  const ref = getConversation(conversationId, memberId)?.entry_ref;
  const garden = ref ? gardenFor(memberId) : null;
  if (!ref || !garden) return null;
  const [collection, locale, slug] = ref.split("/");
  return listGardenEntries(garden).find((e) => e.collection === collection && e.locale === locale && e.slug === slug) ?? null;
}

const refOf = (e: GardenEntry) => `${e.collection}/${e.locale}/${e.slug}`;

// ── The pass ─────────────────────────────────────────────────────────────────

const SYSTEM = `You read one exchange between a person and their assistant, and decide whether it named anything worth an entry in that person's notebook.

An entry is a WORK or a PERSON, named in the exchange:
- movies, series, books, music (an album), podcasts, games
- people: someone public (an actor, an author) or someone the person knows, named by first and last name

Answer with JSON only: {"subjects": [...]}, at most ${MAX_PER_TURN}, most often none.

Each subject: {"kind": "movies|series|books|music|podcasts|games|people", "title": "...", "year": 2015, "creator": "...", "public": true, "note": "..."}
- "title": the work's usual title, or the person's full name. Never a first name alone.
- "year": the work's first release, when you are sure. Omit otherwise.
- "creator": the author, the artist, the director — when the exchange or common knowledge gives it. Omit for people.
- "public": for people only. true for a public figure, false for someone from the person's own life.
- "note": one to three sentences, in the language the person wrote in (French if they wrote French, whatever the language of these instructions), addressed to them: "you" in English; in French "tu" or "vous", as the assistant addresses them. Never "the person", "the user", "they".
  The note keeps what will be worth rereading in a year:
  - When the person brings something of their own to the subject — a work they read, watched or listened to, someone they met — and says what it stirred in them, the note says that first: why it struck them, what it brought back or made them think about, in their own terms and with the particulars they gave — their work, their practice, the people in their life they mentioned; then what the exchange made of it. Not a summary of the work: they know what it is about. For someone who wrote that a novel about a cook made them think of their grandmother's kitchen and of quitting their office job: "Tu as lu ce roman en pensant à la cuisine de ta grand-mère et à ton envie de quitter le bureau ; …" — not "This novel tells the story of a cook".
  - When they asked for facts, the facts the reply gave, with the names and dates that make them worth rereading.
  Only what the exchange holds; add nothing of your own. Never "the exchange confirms", "the reply says", "the conversation" — the note is read without them.

What deserves an entry: what the exchange is ABOUT, and a person or work it gives a real fact on. Not every name passing through a list, not a company, a place, a product, a concept, a piece of software, a news event, a politician cited in passing.
The person asking about their own code, health, mail, money, schedule or plans: nothing.
A subject listed under "Already suggested" comes back only if this exchange says something new about it.
When in doubt, {"subjects": []}.`;

let completeWith: (req: AncillaryRequest) => Promise<AncillaryResult> = ancillaryComplete;
/** Tests replace the model. */
export function setSuggestionModel(fn: ((req: AncillaryRequest) => Promise<AncillaryResult>) | null): void {
  completeWith = fn ?? ancillaryComplete;
}

/** A note within its length, ending where a sentence does: one that runs
 *  over loses its last sentence, never the end of a word. */
export function clipNote(note: string, max = NOTE_MAX_CHARS): string {
  const text = note.trim();
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const stops = [...head.matchAll(/[.!?…](?=\s|$)/g)];
  const last = stops.at(-1);
  if (last && last.index! >= max / 2) return head.slice(0, last.index! + 1);
  return `${head.slice(0, head.lastIndexOf(" ")).replace(/[\s,;:]+$/, "")}…`;
}

/** The first JSON object in a model's answer — fenced, prefixed, or bare. */
export function parseNamed(text: string, alsoKind: string | null = null): Named[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed: any;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { return []; }
  const list = Array.isArray(parsed?.subjects) ? parsed.subjects : [];
  const out: Named[] = [];
  for (const s of list) {
    const kind = String(s?.kind ?? "");
    const title = String(s?.title ?? "").replace(/\s+/g, " ").trim();
    const note = clipNote(String(s?.note ?? ""));
    if (!((SUGGESTION_KINDS as readonly string[]).includes(kind) || kind === alsoKind) || !title || !note) continue;
    // A first name alone is nobody in particular.
    if (kind === "people" && title.split(" ").length < 2) continue;
    const year = Number.isInteger(s?.year) && s.year > 1000 && s.year < 2200 ? (s.year as number) : null;
    out.push({
      kind, title, year, note,
      creator: typeof s?.creator === "string" ? s.creator.trim() : "",
      public: kind === "people" ? s?.public !== false : true,
    });
    if (out.length === MAX_PER_TURN) break;
  }
  return out;
}

async function nameSubjects(
  memberId: string, conversationId: string, question: string, reply: string, bound: GardenEntry | null,
): Promise<Named[]> {
  const already = (db
    .query(`SELECT title FROM entry_suggestions WHERE conversation_id = ? ORDER BY created_at`)
    .all(conversationId) as Array<{ title: string }>).map((r) => r.title);
  // Held from an entry of their notebook: what the exchange establishes about
  // it is the first thing worth keeping — the result that goes back on it.
  const about = bound
    ? `This exchange is held from the person's notebook entry "${bound.title}" (kind: ${bound.collection}). ` +
      `Name it FIRST, under exactly that title and kind, even if a note on it was already suggested. ` +
      `Its note is the result of the exchange for that entry: the answer to what the person asked, in substance, ` +
      `as they would want to find it on that entry later — not a restatement of what the entry already is. ` +
      `Leave it out only when the exchange taught nothing about it.\n\n`
    : "";
  const prompt =
    about +
    (already.length ? `Already suggested: ${already.join("; ")}\n\n` : "") +
    `THE PERSON:\n${question.slice(0, 2000)}\n\nTHE ASSISTANT:\n${reply.slice(0, 6000)}`;
  const result = await completeWith({
    invocation: "entry_suggest",
    system: SYSTEM,
    prompt,
    maxTokens: 1200,
    temperature: 0,
    reasoning: "none",
  });
  recordSpend(result.usage, memberId);
  return parseNamed(result.text, bound?.collection ?? null);
}

// ── Resolution ───────────────────────────────────────────────────────────────

/** Accents, case, punctuation and a leading article aside. */
export function normalise(title: string): string {
  return title
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^(the|a|an|le|la|les|l|un|une) /, "");
}

/** Two words at least, either order — the rule the people index applies. */
function sameName(a: string, b: string): boolean {
  const ta = normalise(a).split(" ").filter(Boolean).sort();
  const tb = normalise(b).split(" ").filter(Boolean).sort();
  return ta.length >= 2 && ta.length === tb.length && ta.every((t, i) => t === tb[i]);
}

function entryYear(garden: GardenRef, e: GardenEntry): number | null {
  const file = e.fiche?.file ?? e.card?.file;
  if (!file) return null;
  try {
    const fm = parseFiche(fs.readFileSync(path.join(garden.root, file), "utf-8"))?.frontmatter ?? {};
    const y = Number(fm.meta?.year ?? fm.year);
    return Number.isInteger(y) ? y : null;
  } catch { return null; }
}

/** The member's own entry on this subject, if they have one. */
export function findInGarden(garden: GardenRef, named: Named): GardenEntry | null {
  const entries = listGardenEntries(garden).filter((e) => e.collection === named.kind);
  const hits = named.kind === "people"
    ? entries.filter((e) => sameName(e.title, named.title))
    : entries.filter((e) => normalise(e.title) === normalise(named.title));
  if (hits.length <= 1 || !named.year) return hits[0] ?? null;
  // Two entries under one title (a film and its remake): the year decides.
  return hits.find((e) => entryYear(garden, e) === named.year) ?? hits[0]!;
}

/** The garden's authenticated image path as the open twin an AsyncImage can load. */
function openImage(garden: GardenRef, image: string | null): string | null {
  if (!image) return null;
  const prefix = `/images/${garden.username}/resources/`;
  if (!image.startsWith(prefix)) return /^https?:\/\//.test(image) ? image : null;
  const rest = image.slice(prefix.length);
  if (!fs.existsSync(path.join(garden.root, "images", "resources", rest))) return null;
  return `/api/garden-images/${garden.username}/${rest}`;
}

const SEARCH_TOOL: Record<string, string> = {
  movies: "search_movie", series: "search_series", books: "search_book", music: "search_album",
  podcasts: "search_podcast", games: "search_game", people: "search_person",
};

/** The argument `open_fiche` pins the exact work with, per collection. */
const ID_ARG: Record<string, { name: string; integer: boolean } | undefined> = {
  movies: { name: "tmdb_id", integer: true },
  series: { name: "tmdb_id", integer: true },
  books: { name: "google_books_id", integer: false },
  podcasts: { name: "podcastindex_id", integer: true },
  games: { name: "igdb_id", integer: true },
  music: { name: "musicbrainz_id", integer: false },
};

type GardenCall = (memberId: string, tool: string, args: Record<string, unknown>) => Promise<any>;

async function gatewayCall(memberId: string, tool: string, args: Record<string, unknown>): Promise<any> {
  const session = await McpSession.open(memberId);
  const { text, isError } = await session.callTool(`garden__${tool}`, args);
  if (isError) throw new Error(text || `${tool} failed`);
  const parsed = JSON.parse(text);
  if (parsed?.error) throw new Error(String(parsed.error));
  return parsed;
}

let gardenCall: GardenCall = gatewayCall;
/** Tests replace the garden tool. */
export function setGardenCall(fn: GardenCall | null): void {
  gardenCall = fn ?? gatewayCall;
}

async function searchProvider(memberId: string, named: Named, locale: string): Promise<Candidate[]> {
  const args: Record<string, unknown> = named.kind === "people"
    ? { name: named.title, limit: MAX_CANDIDATES }
    : { title: named.title, limit: MAX_CANDIDATES };
  if (named.year && ["movies", "series", "games", "music"].includes(named.kind)) args.year = named.year;
  if (named.creator && named.kind === "books") { args.author = named.creator; args.locale = locale; }
  if (named.creator && named.kind === "music") args.artist = named.creator;
  // Podcast Index takes one term: "The Daily" alone is a page of sports
  // dailies, "The Daily The New York Times" is the show.
  if (named.creator && named.kind === "podcasts") {
    const found = await searchCall(memberId, named.kind, { ...args, title: `${named.title} ${named.creator}` }, MAX_CANDIDATES);
    if (found.length) return found;
  }
  return searchCall(memberId, named.kind, args, MAX_CANDIDATES);
}

/** A free term, as the member typed it or Maurice rephrased it: no year, no
 *  author — the term says what it says. */
function searchTerm(memberId: string, kind: string, term: string, locale: string, limit: number): Promise<Candidate[]> {
  const args: Record<string, unknown> = kind === "people" ? { name: term, limit } : { title: term, limit };
  if (kind === "books") args.locale = locale;
  return searchCall(memberId, kind, args, limit);
}

async function searchCall(memberId: string, kind: string, args: Record<string, unknown>, limit: number): Promise<Candidate[]> {
  const tool = SEARCH_TOOL[kind];
  if (!tool) return [];
  const card = await gardenCall(memberId, tool, args);
  const rows = Array.isArray(card?.results) ? card.results : [];
  return rows.slice(0, limit).map((r: any) => ({
    id: String(r?.id ?? ""),
    title: String(r?.title ?? ""),
    year: Number.isInteger(Number(r?.year)) && Number(r?.year) > 0 ? Number(r.year) : null,
    subtitle: String(r?.subtitle ?? ""),
    image: String(r?.image ?? ""),
  })).filter((c: Candidate) => c.id && c.title);
}

/**
 * One row per work: a catalogue lists the copies of a feed or the reprints of
 * a book under the same title and maker, which read as a list of identical
 * lines (three "The Daily · The New York Times"). The first stands for all.
 */
const workKey = (c: Candidate) => `${normalise(c.title)}|${normalise(c.subtitle)}|${c.year ?? ""}`;

export function distinct(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = workKey(c);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The candidates as offered: one per work, and only the first when it is
 *  surely the one named. */
function settle(named: Named, found: Candidate[]): Candidate[] {
  const list = distinct(found);
  return confident(named, list) ? [list[0]!] : list;
}

/**
 * Is the first candidate the subject, without asking? Its title is the one
 * named, and nothing else in the list could be it too: the year agrees when
 * one was named, and no other candidate carries the same title otherwise.
 */
export function confident(named: Named, candidates: Candidate[]): boolean {
  const top = candidates[0];
  if (!top) return false;
  const same = (c: Candidate) => named.kind === "people" ? sameName(c.title, named.title) : normalise(c.title) === normalise(named.title);
  if (!same(top)) return false;
  if (named.year && top.year) return Math.abs(named.year - top.year) <= 1;
  // The maker named agrees: the copies of a feed or the editions of a book
  // that follow it under the same title are the same work.
  const maker = named.creator ? normalise(named.creator) : "";
  if (maker && top.subtitle && normalise(top.subtitle).includes(maker)) return true;
  return candidates.filter(same).length === 1;
}

interface Resolved {
  key: string;
  title: string;
  year: number | null;
  subtitle: string | null;
  image: string | null;
  existing: string | null;
  candidates: Candidate[];
}

async function resolve(
  memberId: string, garden: GardenRef, named: Named, locale: string, bound: GardenEntry | null,
): Promise<Resolved> {
  // 0. The entry the conversation is held from, named by its own title.
  const isBound = bound && bound.collection === named.kind &&
    (named.kind === "people" ? sameName(bound.title, named.title) : normalise(bound.title) === normalise(named.title));
  // 1. The member's garden. A hit asks no provider anything.
  const entry = isBound ? bound : findInGarden(garden, named);
  if (entry) {
    const ref = `${entry.collection}/${entry.locale}/${entry.slug}`;
    return {
      key: ref, title: entry.title, year: entryYear(garden, entry), subtitle: named.creator || null,
      image: openImage(garden, entry.image), existing: ref, candidates: [],
    };
  }
  const plain: Resolved = {
    key: `title:${normalise(named.title)}`, title: named.title, year: named.year ?? null,
    subtitle: named.creator || null, image: null, existing: null, candidates: [],
  };
  // 3. Someone from the member's own life: no lookup. A homonym on Wikidata
  //    is worse than a fiche with a name and nothing else.
  if (named.kind === "people" && !named.public) return plain;
  // 2. The provider.
  let candidates: Candidate[] = [];
  try {
    candidates = await searchProvider(memberId, named, locale);
  } catch (err) {
    // No key, a provider down: the suggestion stands on its title alone.
    console.warn(`[suggest] ${named.kind} lookup failed for "${named.title}" (${(err as Error).message})`);
    return plain;
  }
  if (!candidates.length) return plain;
  candidates = distinct(candidates);
  if (confident(named, candidates)) {
    const top = candidates[0]!;
    return {
      key: `id:${top.id}`, title: top.title, year: top.year, subtitle: top.subtitle || named.creator || null,
      image: top.image || null, existing: null, candidates: [top],
    };
  }
  return { ...plain, image: candidates[0]!.image || null, candidates };
}

// ── The store ────────────────────────────────────────────────────────────────

function decidedElsewhere(memberId: string, kind: string, key: string, state: "dismissed" | "kept"): boolean {
  return !!db
    .query(`SELECT 1 FROM entry_suggestions WHERE member_id = ? AND kind = ? AND key = ? AND state = ? LIMIT 1`)
    .get(memberId, kind, key, state);
}

/**
 * File what the pass named. Returns true when the conversation's list changed.
 * - Dismissed anywhere by this member: never again.
 * - Already in this conversation: the note moves on; a kept row comes back
 *   as a note to add, since the pass only names it again for something new.
 */
function record(memberId: string, conversationId: string, messageId: string | null, named: Named, r: Resolved): boolean {
  // A refusal is of a subject. A note turned down on an entry they already
  // have says nothing about the next note on it.
  if (!r.existing && decidedElsewhere(memberId, named.kind, r.key, "dismissed")) return false;
  const here = db
    .query(`SELECT id, state, note FROM entry_suggestions WHERE conversation_id = ? AND kind = ? AND key = ?`)
    .get(conversationId, named.kind, r.key) as { id: string; state: string; note: string } | null;
  if (here) {
    if (here.note === named.note) return false;
    // A kept entry is in the garden now: the row turns into a note for it.
    const existing = db.query(`SELECT kept_path, existing FROM entry_suggestions WHERE id = ?`).get(here.id) as any;
    db.run(
      `UPDATE entry_suggestions SET note = ?, message_id = ?, state = 'proposed', existing = ?, decided_at = NULL, updated_at = datetime('now') WHERE id = ?`,
      [named.note, messageId, existing?.kept_path ?? existing?.existing ?? null, here.id],
    );
    return true;
  }
  db.run(
    `INSERT INTO entry_suggestions (id, member_id, conversation_id, message_id, kind, key, title, year, subtitle, image, public, candidates, existing, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(), memberId, conversationId, messageId, named.kind, r.key, r.title, r.year, r.subtitle, r.image,
      named.public === false ? 0 : 1, r.candidates.length ? JSON.stringify(r.candidates) : null, r.existing, named.note,
    ],
  );
  return true;
}

export function suggestionsFor(memberId: string, conversationId: string): EntrySuggestion[] {
  return (db
    .query(
      `SELECT * FROM entry_suggestions WHERE member_id = ? AND conversation_id = ? AND state != 'dismissed'
       ORDER BY CASE state WHEN 'proposed' THEN 0 ELSE 1 END, updated_at DESC, rowid DESC`,
    )
    .all(memberId, conversationId) as any[]).map(hydrate);
}

function countIn(memberId: string, conversationId: string, state: "proposed" | "kept"): number {
  const row = db
    .query(`SELECT COUNT(*) AS n FROM entry_suggestions WHERE member_id = ? AND conversation_id = ? AND state = ?`)
    .get(memberId, conversationId, state) as { n: number };
  return row.n;
}

export function pendingCount(memberId: string, conversationId: string): number {
  return countIn(memberId, conversationId, "proposed");
}

export function keptCount(memberId: string, conversationId: string): number {
  return countIn(memberId, conversationId, "kept");
}

/** Tell the member's devices the conversation's list moved: how many wait,
 *  how many were kept — what the header's mark draws. */
function announce(memberId: string, conversationId: string): void {
  publishToUser(memberId, {
    type: "suggestions",
    conversationId,
    count: pendingCount(memberId, conversationId),
    kept: keptCount(memberId, conversationId),
  });
}

function own(memberId: string, id: string): EntrySuggestion | null {
  const row = db.query(`SELECT * FROM entry_suggestions WHERE id = ? AND member_id = ?`).get(id, memberId);
  return row ? hydrate(row) : null;
}

// ── After a turn ─────────────────────────────────────────────────────────────

/** Who gets suggestions: a member, alone with Maurice, in a conversation of
 *  their own making, with a garden to keep things in. */
export function eligible(memberId: string, conversationId: string): boolean {
  if (isGuest(memberId) || getUser(memberId)?.is_child) return false;
  if (countParticipants(conversationId) > 1) return false;
  const convo = getConversation(conversationId, memberId);
  if (!convo || convo.opened_by === "maurice") return false;
  const garden = gardenFor(memberId);
  return !!garden && fs.existsSync(garden.root);
}

/** The side of the garden a new fiche is filed on: the member's language,
 *  of the two the garden has. */
function gardenLocale(memberId: string): string {
  return userLocale(memberId) === "fr" ? "fr" : "en";
}

/** The whole pass for one turn. Exported for tests; the route calls the
 *  fire-and-forget wrapper below. Returns how many rows changed. */
export async function suggestForTurn(
  memberId: string, conversationId: string, messageId: string | null, question: string, reply: string,
): Promise<number> {
  if (!question.trim() || !reply.trim() || !eligible(memberId, conversationId)) return 0;
  const bound = boundEntry(memberId, conversationId);
  const named = await nameSubjects(memberId, conversationId, question, reply, bound);
  if (!named.length) return 0;
  const garden = gardenFor(memberId)!;
  const locale = gardenLocale(memberId);
  let changed = 0;
  for (const n of named) {
    const r = await resolve(memberId, garden, n, locale, bound);
    if (record(memberId, conversationId, messageId, n, r)) changed++;
  }
  if (changed) announce(memberId, conversationId);
  return changed;
}

/** Never on the reply's path, never throwing into it. */
export function suggestInBackground(
  memberId: string, conversationId: string, messageId: string | null, question: string, reply: string,
): void {
  const pass = suggestForTurn(memberId, conversationId, messageId, question, reply)
    .then((n) => { if (n) console.log(`[suggest] ${n} for conversation ${conversationId}`); })
    .catch((err) => console.warn(`[suggest] pass failed (${(err as Error).message})`))
    .finally(() => { if (inFlight.get(conversationId) === pass) inFlight.delete(conversationId); });
  inFlight.set(conversationId, pass);
}

/** The pass running for a conversation, if one is. Carnet keeps no socket: it
 *  asks for the list once the reply is in, and waits here for the pass that
 *  reply started rather than polling. */
const inFlight = new Map<string, Promise<void>>();

/** Resolve when the conversation's pass is done, or after `ms` at most. */
export async function settled(conversationId: string, ms = 20_000): Promise<void> {
  const pass = inFlight.get(conversationId);
  if (!pass) return;
  await Promise.race([pass, new Promise<void>((r) => setTimeout(r, ms))]);
}

// ── The member's decision ────────────────────────────────────────────────────

export class SuggestionError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

/** One dated block under `## Commentaire` of a fiche — any collection, people
 *  included, which the shelf's own `addNote` does not write on. */
function noteOnFiche(memberId: string, garden: GardenRef, ref: string, text: string): void {
  const [collection, locale, slug] = ref.split("/") as [ResourceCollection, string, string];
  const file = fichePath(garden, collection, locale, slug);
  if (!fs.existsSync(file)) {
    // An entry that only has a card: its member's side starts here.
    const entry = listGardenEntries(garden).find((e) => e.collection === collection && e.locale === locale && e.slug === slug);
    if (!entry) throw new SuggestionError(`No such entry: ${ref}`, 404);
    writeFiche(file, {
      title: entry.title, resource_collection: collection, resource_id: slug,
      date: new Date().toISOString().slice(0, 10), tags: [], locale, meta: { title: entry.title },
    }, "");
  }
  const parsed = parseFiche(fs.readFileSync(file, "utf-8"));
  if (!parsed) throw new SuggestionError(`Could not parse: ${ref}`, 422);
  const block = noteBlock(new Date().toISOString().slice(0, 10), { text });
  const body = parsed.body.includes(block) ? parsed.body : withNote(parsed.body, block);
  // Kept by the member's own hand: read, and theirs.
  markOpened(parsed.frontmatter);
  if (collection === "people" && !parsed.frontmatter.status) parsed.frontmatter.status = "confirmed";
  writeFiche(file, parsed.frontmatter, body);
  autoCommit(garden, [file], `Note on ${collection}/${slug}`);
  indexGardenPaths(memberId, [file]);
}

/** The note as it lands on the fiche: what was said, and where it was said. */
export function noteText(s: EntrySuggestion, conversationTitle: string | null, locale: string): string {
  return `${s.note.trim()} ${provenance(s.conversation_id, conversationTitle, locale)}`;
}

/**
 * Where a kept note came from: a link to the conversation, so the result on
 * the fiche can be traced back to how it was arrived at. The conversation is
 * rarely worth keeping; this is what is kept of it. `maurice://conversations/
 * <id>` is what both apps open.
 */
export function provenance(conversationId: string, conversationTitle: string | null, locale: string): string {
  const from = locale === "fr" ? "Conversation avec Maurice" : "Conversation with Maurice";
  // Brackets in a title would close the link's label.
  const title = (conversationTitle ?? "").replace(/[\[\]]/g, "").replace(/\s+/g, " ").trim();
  return `*([${from}${title ? ` : « ${title} »` : ""}](maurice://conversations/${conversationId}))*`;
}

/**
 * Keep it: the fiche is opened when the garden has none, and the note filed
 * on it. `candidateId` is the member's pick when the row had several.
 */
export async function keepSuggestion(
  memberId: string, id: string, candidateId?: string | null, episodeIds: string[] = [],
): Promise<EntrySuggestion> {
  const s = own(memberId, id);
  if (!s) throw new SuggestionError("not found", 404);
  if (s.state === "kept") return s;
  const garden = gardenFor(memberId);
  if (!garden) throw new SuggestionError("No garden for this member", 404);
  const episodes = [...new Set(episodeIds.map(String).filter(Boolean))];
  if (episodes.length && s.kind !== "podcasts") throw new SuggestionError("only a podcast has episodes", 400);

  const locale = gardenLocale(memberId);
  const open = async (args: Record<string, unknown>): Promise<any> => {
    let card: any;
    try {
      card = await gardenCall(memberId, "open_fiche", args);
    } catch (err) {
      throw new SuggestionError(`The fiche could not be opened: ${(err as Error).message}`, 502);
    }
    if (!card?.resource_id) throw new SuggestionError("The fiche could not be opened", 502);
    return card;
  };

  let picked: Candidate | undefined;
  if (!s.existing) {
    picked = candidateId ? s.candidates.find((c) => c.id === candidateId) : s.candidates.length === 1 ? s.candidates[0] : undefined;
    if (candidateId && !picked) throw new SuggestionError("unknown candidate", 400);
    if (!picked && s.candidates.length > 1) throw new SuggestionError("a candidate must be picked", 409);
  }

  // Where the note goes: the entry, or — for a podcast — each episode picked,
  // every one its own fiche, `<show>--<episode>`.
  const refs: Array<{ ref: string; title: string; image: string | null }> = [];
  if (episodes.length) {
    const feed = picked?.id ?? (await feedOf(memberId, garden, s));
    if (!feed) throw new SuggestionError("the show's feed is not known", 409);
    const listed = episodeCache.get(`${s.id}:${feed}`)?.episodes ?? [];
    for (const episode of episodes) {
      const card = await open({
        resource_collection: s.kind, title: picked?.title ?? s.title, locale,
        podcastindex_id: Number(feed), podcast_episode_id: Number(episode),
      });
      refs.push({
        ref: `${s.kind}/${card.locale ?? locale}/${card.resource_id}`,
        title: String(card.title ?? s.title),
        image: listed.find((e) => e.id === episode)?.image || null,
      });
    }
  } else if (s.existing) {
    refs.push({ ref: s.existing, title: s.title, image: null });
  } else {
    const args: Record<string, unknown> = { resource_collection: s.kind, title: picked?.title ?? s.title, locale };
    if (s.year) args.year = picked?.year ?? s.year;
    if (s.kind === "books" && s.subtitle) args.author = picked?.subtitle || s.subtitle;
    const idArg = ID_ARG[s.kind];
    if (picked && idArg) args[idArg.name] = idArg.integer ? Number(picked.id) : picked.id;
    // Nothing to look up: someone from the member's life, or a subject no
    // provider knew. The fiche is a name and what was said.
    if (!picked) args.skip_metadata = true;
    const card = await open(args);
    refs.push({ ref: `${s.kind}/${card.locale ?? locale}/${card.resource_id}`, title: picked?.title ?? s.title, image: picked?.image || null });
  }

  const convo = getConversation(s.conversation_id, memberId);
  const bound = boundEntry(memberId, s.conversation_id);
  for (const { ref, title } of refs) {
    noteOnFiche(memberId, garden, ref, noteText(s, convo?.title ?? null, locale));

    // Kept from a conversation held on another entry: the two are linked, by a
    // résonance on that entry — a [[wiki-link]] to this one, under what was said.
    if (bound && refOf(bound) !== ref) {
      const [, , slug] = ref.split("/") as [string, string, string];
      try {
        appendResonance(memberId, garden, {
          to: { collection: bound.collection, locale: bound.locale, slug: bound.slug },
          comment: `${s.note.trim()} ${provenance(s.conversation_id, convo?.title ?? null, locale)}`,
          source: { label: title, basename: `${slug}-fiche` },
        });
      } catch (err) {
        // The entry is kept; a link that could not be written is not worth losing it.
        console.warn(`[suggest] résonance on ${refOf(bound)} failed (${(err as Error).message})`);
      }
    }
  }

  // The row reads as the first entry kept, and says how many others came with it.
  const first = refs[0]!;
  const title = refs.length > 1 ? `${first.title} (+${refs.length - 1})` : first.title;
  db.run(
    `UPDATE entry_suggestions SET state = 'kept', kept_path = ?, existing = ?, title = ?, year = ?, image = COALESCE(?, image),
            candidates = NULL, decided_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    [first.ref, first.ref, title, episodes.length ? null : picked?.year ?? s.year, first.image, id],
  );
  // From now on the garden answers for this subject, under its path: the row
  // takes that key, so a later mention finds it instead of making a twin.
  try { db.run(`UPDATE entry_suggestions SET key = ? WHERE id = ?`, [first.ref, id]); } catch {}
  announce(memberId, s.conversation_id);
  return own(memberId, id)!;
}

/** Not this one — here or in any conversation to come. */
export function dismissSuggestion(memberId: string, id: string): EntrySuggestion | null {
  const s = own(memberId, id);
  if (!s) return null;
  if (s.state !== "kept") {
    db.run(`UPDATE entry_suggestions SET state = 'dismissed', decided_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`, [id]);
    announce(memberId, s.conversation_id);
  }
  return own(memberId, id);
}

// ── A podcast's episodes ─────────────────────────────────────────────────────
//
// What was listened to is most often one episode, not the show (14 October
// 2026): the drawer lists the show's recent episodes as a podcast app does —
// art, day, title, what it is about, length — with the one the conversation
// was about picked in advance, and keeping it opens that episode's fiche.

export interface Episode {
  id: string;
  title: string;
  /** When it came out, ISO-8601. */
  date: string | null;
  description: string;
  image: string;
  /** Seconds. */
  duration: number | null;
}

export interface EpisodeList {
  feed: string;
  episodes: Episode[];
  /** The episode the conversation was about, as Maurice reads it. */
  suggested: string | null;
}

const MAX_EPISODES = 50;
/** One read per row and show: the list and Maurice's pick hold for the drawer's
 *  reopenings, and a restart costs one more. */
const episodeCache = new Map<string, EpisodeList>();

/** The show's Podcast Index feed: the one candidate, else the garden entry's
 *  own — its fiche keeps the id; a card does not, and is looked up by title. */
async function feedOf(memberId: string, garden: GardenRef, s: EntrySuggestion): Promise<string | null> {
  if (!s.existing) return s.candidates.length === 1 ? s.candidates[0]!.id : null;
  const [collection, locale, slug] = s.existing.split("/");
  const entry = listGardenEntries(garden).find((e) => e.collection === collection && e.locale === locale && e.slug === slug);
  for (const file of [entry?.fiche?.file, entry?.card?.file]) {
    if (!file) continue;
    try {
      const fm = parseFiche(fs.readFileSync(path.join(garden.root, file), "utf-8"))?.frontmatter as any;
      const id = fm?.meta?.podcastindex_id ?? fm?.podcastindex_id;
      if (id) return String(id);
    } catch {}
  }
  const title = entry?.title ?? s.title;
  const found = await searchCall(memberId, "podcasts", { title, limit: MAX_CANDIDATES }, MAX_CANDIDATES).catch(() => []);
  return found.find((c) => normalise(c.title) === normalise(title))?.id ?? null;
}

const PICK_EPISODE = `A person told their assistant about a podcast episode. Below are what was said, and the show's recent episodes.

Which episode was it? Answer with JSON only: {"episode": "<id>"} — or {"episode": null} when nothing said points to one of them. Titles change after release: judge on what the episode is about as much as on its title.`;

async function pickEpisode(memberId: string, s: EntrySuggestion, episodes: Episode[]): Promise<string | null> {
  if (!episodes.length) return null;
  const list = episodes
    .map((e) => `- id ${e.id} · ${e.date?.slice(0, 10) ?? "?"} · ${e.title} — ${e.description.slice(0, 240)}`)
    .join("\n");
  const prompt = `What was said of it: ${s.note}\n\nTHE PERSON SAID:\n${questionOf(s).slice(0, 2000)}\n\nEPISODES:\n${list}`;
  try {
    const result = await completeWith({
      invocation: "entry_suggest_episode", system: PICK_EPISODE, prompt, maxTokens: 100, temperature: 0, reasoning: "none",
    });
    recordSpend(result.usage, memberId);
    const start = result.text.indexOf("{");
    const end = result.text.lastIndexOf("}");
    const id = start >= 0 && end > start ? JSON.parse(result.text.slice(start, end + 1))?.episode : null;
    return id != null && episodes.some((e) => e.id === String(id)) ? String(id) : null;
  } catch (err) {
    console.warn(`[suggest] episode pick failed (${(err as Error).message})`);
    return null;
  }
}

/** The show's recent episodes, newest first, and the one Maurice would pick.
 *  `feed` is one of the row's candidates; without it, the show is the one
 *  the row already settled on. */
export async function episodesFor(memberId: string, id: string, feed?: string | null): Promise<EpisodeList> {
  const s = own(memberId, id);
  if (!s) throw new SuggestionError("not found", 404);
  if (s.kind !== "podcasts") throw new SuggestionError("only a podcast has episodes", 400);
  const garden = gardenFor(memberId);
  if (!garden) throw new SuggestionError("No garden for this member", 404);
  if (feed && !s.candidates.some((c) => c.id === feed)) throw new SuggestionError("unknown candidate", 400);
  const show = feed ?? (await feedOf(memberId, garden, s));
  if (!show) throw new SuggestionError("the show's feed is not known", 409);

  const key = `${s.id}:${show}`;
  const cached = episodeCache.get(key);
  if (cached) return cached;
  let card: any;
  try {
    card = await gardenCall(memberId, "search_podcast_episodes", { podcastindex_id: Number(show), limit: MAX_EPISODES });
  } catch (err) {
    throw new SuggestionError(`The episodes could not be read: ${(err as Error).message}`, 502);
  }
  const episodes: Episode[] = (Array.isArray(card?.episodes) ? card.episodes : [])
    .filter((e: any) => e?.id && e?.title)
    .map((e: any) => ({
      id: String(e.id),
      title: String(e.title),
      date: Number(e.datePublished) > 0 ? new Date(Number(e.datePublished) * 1000).toISOString() : null,
      description: String(e.description ?? ""),
      image: String(e.image ?? ""),
      duration: Number(e.duration) > 0 ? Number(e.duration) : null,
    }));
  const list = { feed: show, episodes, suggested: await pickEpisode(memberId, s, episodes) };
  // A drawer's worth at a time; the oldest go first.
  if (episodeCache.size >= 200) episodeCache.delete(episodeCache.keys().next().value!);
  episodeCache.set(key, list);
  return list;
}

/** Tests start from an empty cache. */
export function forgetEpisodes(): void {
  episodeCache.clear();
}

// ── Another look ─────────────────────────────────────────────────────────────

const REFINE = `A person's assistant named a work or a person from their conversation, and looked it up in a catalogue. The person says the results are not it.

Write the one search term most likely to find the right one in that catalogue: the usual title (in the catalogue's language, often the original one), followed by the maker's name when that tells it apart from works of the same title. The catalogue matches words: just the words, no "by", no "from", no punctuation, not a sentence, not the results already tried.

Answer with JSON only: {"query": "..."}`;

const CATALOGUE: Record<string, string> = {
  movies: "TMDB (films)", series: "TMDB (TV series)", books: "Google Books", music: "MusicBrainz (albums)",
  podcasts: "Podcast Index (podcast feeds)", games: "IGDB (video games)", people: "Wikidata (people)",
};

/** What the person asked in the turn the row came from. */
function questionOf(s: EntrySuggestion): string {
  const row = (s.message_id
    ? db.query(
        `SELECT content FROM messages WHERE conversation_id = ? AND role = 'user'
           AND created_at <= (SELECT created_at FROM messages WHERE id = ?)
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      ).get(s.conversation_id, s.message_id)
    : null) as { content: string } | null;
  return row?.content ?? "";
}

/** Maurice's own second try at a term, from what was said and what was wrong. */
async function refineQuery(memberId: string, s: EntrySuggestion): Promise<string | null> {
  const tried = [s.title, s.query].filter(Boolean).map((q) => `"${q}"`).join(", ");
  const wrong = s.candidates.map((c) => `- ${c.title}${c.subtitle ? ` (${c.subtitle})` : ""}`).join("\n");
  const prompt =
    `Catalogue: ${CATALOGUE[s.kind] ?? s.kind}\n` +
    `Named: "${s.title}"${s.year ? `, ${s.year}` : ""}${s.subtitle ? `, by ${s.subtitle}` : ""}\n` +
    `Terms already tried: ${tried}\n` +
    (wrong ? `Results that are not it:\n${wrong}\n` : "") +
    `What was said of it: ${s.note}\n\nTHE PERSON SAID:\n${questionOf(s).slice(0, 2000)}`;
  try {
    const result = await completeWith({
      invocation: "entry_suggest_refine", system: REFINE, prompt, maxTokens: 200, temperature: 0, reasoning: "none",
    });
    recordSpend(result.usage, memberId);
    const start = result.text.indexOf("{");
    const end = result.text.lastIndexOf("}");
    const q = start >= 0 && end > start ? String(JSON.parse(result.text.slice(start, end + 1))?.query ?? "") : "";
    return q.replace(/\s+/g, " ").trim().slice(0, 200) || null;
  } catch (err) {
    console.warn(`[suggest] refine failed (${(err as Error).message})`);
    return null;
  }
}

/**
 * Not the right one: look again. With the member's own `query`, that term,
 * and every result it gives. Without one, Maurice rephrases the search from
 * what was said, and what was already shown is not shown again. The garden
 * is asked first, as for the pass. Returns the row and how many it found —
 * none leaves the row as it was.
 */
export async function searchAgain(
  memberId: string, id: string, query?: string | null,
): Promise<{ suggestion: EntrySuggestion; found: number }> {
  const s = own(memberId, id);
  if (!s) throw new SuggestionError("not found", 404);
  if (s.state !== "proposed") throw new SuggestionError("already decided", 409);
  const bound = boundEntry(memberId, s.conversation_id);
  if (bound && s.existing === refOf(bound)) throw new SuggestionError("this is the conversation's own entry", 409);
  if (s.kind === "people" && !s.public) throw new SuggestionError("someone from the member's life is not looked up", 409);
  const garden = gardenFor(memberId);
  if (!garden) throw new SuggestionError("No garden for this member", 404);

  const typed = query?.replace(/\s+/g, " ").trim().slice(0, 200) || null;
  // Asked to look again without a word: Maurice's term first, then what the
  // pass named with its maker, then the title alone. A catalogue reads its
  // term literally — "The Daily by The New York Times" finds nothing where
  // "The Daily The New York Times" finds the show — so one that comes back
  // empty is not the end of the look.
  // The fallbacks look for what was named, so only what bears its title
  // counts: "The Daily" alone also finds "Locked On 49ers – Daily Podcast".
  const refined = typed ? null : await refineQuery(memberId, s);
  const terms: Array<{ term: string; exact: boolean }> = typed
    ? [{ term: typed, exact: false }]
    : [
        ...(refined ? [{ term: refined, exact: false }] : []),
        { term: [s.title, s.subtitle].filter(Boolean).join(" "), exact: true },
        { term: s.title, exact: true },
      ].filter((t, i, all) => t.term && all.findIndex((u) => u.term === t.term) === i);
  const seen = new Set([...s.seen, ...s.candidates.map((c) => c.id)]);
  const named: Named = { kind: s.kind, title: s.title, year: s.year, creator: s.subtitle ?? "", note: s.note };
  const sameTitle = (c: Candidate) =>
    s.kind === "people" ? sameName(c.title, s.title) : normalise(c.title) === normalise(s.title);

  for (const { term, exact } of terms) {
    // Their own entry under that name: nothing to look up.
    const entry = findInGarden(garden, { kind: s.kind, title: term, note: s.note });
    if (entry && refOf(entry) !== s.existing) {
      db.run(
        `UPDATE entry_suggestions SET existing = ?, title = ?, year = ?, image = ?, candidates = NULL, query = ?, seen = ?,
                updated_at = datetime('now') WHERE id = ?`,
        [refOf(entry), entry.title, entryYear(garden, entry), openImage(garden, entry.image), term, JSON.stringify([...seen]), id],
      );
      return { suggestion: own(memberId, id)!, found: 1 };
    }

    let found: Candidate[];
    try {
      found = await searchTerm(memberId, s.kind, term, gardenLocale(memberId), MAX_CANDIDATES * 3);
    } catch (err) {
      throw new SuggestionError(`The search failed: ${(err as Error).message}`, 502);
    }
    // Their own term shows all it finds; another look, only what is new.
    if (!typed) found = found.filter((c) => !seen.has(c.id));
    if (exact) found = found.filter(sameTitle);
    const fetched = found;
    found = settle(named, found).slice(0, MAX_CANDIDATES);
    if (!found.length) continue;
    // What is shown is seen, and so are its copies, folded into it.
    const shown = new Set(found.map(workKey));
    for (const c of fetched) if (shown.has(workKey(c))) seen.add(c.id);
    db.run(
      `UPDATE entry_suggestions SET candidates = ?, existing = NULL, image = ?, query = ?, seen = ?,
              updated_at = datetime('now') WHERE id = ?`,
      [JSON.stringify(found), found[0]!.image || null, term, JSON.stringify([...seen]), id],
    );
    return { suggestion: own(memberId, id)!, found: found.length };
  }
  // Nothing: the term is kept, for the field to show what was tried.
  db.run(`UPDATE entry_suggestions SET query = ?, updated_at = datetime('now') WHERE id = ?`, [terms[0]?.term ?? null, id]);
  return { suggestion: own(memberId, id)!, found: 0 };
}

/** The entry the conversation is held from, as a ref — what a row is compared
 *  with to say "this is the entry you are on" or "this will be linked to it". */
export function boundRef(memberId: string, conversationId: string): string | null {
  const bound = boundEntry(memberId, conversationId);
  return bound ? refOf(bound) : null;
}

/** Where the kept entry reads in the member's garden, for a client to open. */
export function keptWebPath(memberId: string, s: EntrySuggestion): string | null {
  const ref = s.kept_path ?? s.existing;
  const garden = gardenFor(memberId);
  if (!ref || !garden) return null;
  const [collection, locale, slug] = ref.split("/");
  const entry = listGardenEntries(garden).find((e) => e.collection === collection && e.locale === locale && e.slug === slug);
  // Already the full path, `/g/<member>/…` included.
  return entry?.fiche?.web_path ?? entry?.card?.web_path ?? null;
}
