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
  try { candidates = row.candidates ? JSON.parse(row.candidates) : []; } catch {}
  return { ...row, public: !!row.public, candidates };
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
- "note": one to three sentences, in the language of the exchange, stating what the person now knows about the subject from THIS exchange. Only what the reply said; add nothing of your own. Written as a note to oneself: the facts themselves, with the names and dates that make them worth rereading in a year. Never "the exchange confirms", "the reply says", "the conversation" — the note is read without them.

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
  const tool = SEARCH_TOOL[named.kind];
  if (!tool) return [];
  const card = await gardenCall(memberId, tool, args);
  const rows = Array.isArray(card?.results) ? card.results : [];
  return rows.slice(0, MAX_CANDIDATES).map((r: any) => ({
    id: String(r?.id ?? ""),
    title: String(r?.title ?? ""),
    year: Number.isInteger(Number(r?.year)) && Number(r?.year) > 0 ? Number(r.year) : null,
    subtitle: String(r?.subtitle ?? ""),
    image: String(r?.image ?? ""),
  })).filter((c: Candidate) => c.id && c.title);
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
export async function keepSuggestion(memberId: string, id: string, candidateId?: string | null): Promise<EntrySuggestion> {
  const s = own(memberId, id);
  if (!s) throw new SuggestionError("not found", 404);
  if (s.state === "kept") return s;
  const garden = gardenFor(memberId);
  if (!garden) throw new SuggestionError("No garden for this member", 404);

  const locale = gardenLocale(memberId);
  let ref = s.existing;
  let picked: Candidate | undefined;
  if (!ref) {
    picked = candidateId ? s.candidates.find((c) => c.id === candidateId) : s.candidates.length === 1 ? s.candidates[0] : undefined;
    if (candidateId && !picked) throw new SuggestionError("unknown candidate", 400);
    if (!picked && s.candidates.length > 1) throw new SuggestionError("a candidate must be picked", 409);
    const args: Record<string, unknown> = { resource_collection: s.kind, title: picked?.title ?? s.title, locale };
    if (s.year) args.year = picked?.year ?? s.year;
    if (s.kind === "books" && s.subtitle) args.author = picked?.subtitle || s.subtitle;
    const idArg = ID_ARG[s.kind];
    if (picked && idArg) args[idArg.name] = idArg.integer ? Number(picked.id) : picked.id;
    // Nothing to look up: someone from the member's life, or a subject no
    // provider knew. The fiche is a name and what was said.
    if (!picked) args.skip_metadata = true;
    let card: any;
    try {
      card = await gardenCall(memberId, "open_fiche", args);
    } catch (err) {
      throw new SuggestionError(`The fiche could not be opened: ${(err as Error).message}`, 502);
    }
    if (!card?.resource_id) throw new SuggestionError("The fiche could not be opened", 502);
    ref = `${s.kind}/${card.locale ?? locale}/${card.resource_id}`;
  }

  const convo = getConversation(s.conversation_id, memberId);
  noteOnFiche(memberId, garden, ref, noteText(s, convo?.title ?? null, locale));

  // Kept from a conversation held on another entry: the two are linked, by a
  // résonance on that entry — a [[wiki-link]] to this one, under what was said.
  const bound = boundEntry(memberId, s.conversation_id);
  if (bound && refOf(bound) !== ref) {
    const [, , slug] = ref.split("/") as [string, string, string];
    try {
      appendResonance(memberId, garden, {
        to: { collection: bound.collection, locale: bound.locale, slug: bound.slug },
        comment: `${s.note.trim()} ${provenance(s.conversation_id, convo?.title ?? null, locale)}`,
        source: { label: picked?.title ?? s.title, basename: `${slug}-fiche` },
      });
    } catch (err) {
      // The entry is kept; a link that could not be written is not worth losing it.
      console.warn(`[suggest] résonance on ${refOf(bound)} failed (${(err as Error).message})`);
    }
  }

  db.run(
    `UPDATE entry_suggestions SET state = 'kept', kept_path = ?, existing = ?, title = ?, year = ?, image = COALESCE(?, image),
            candidates = NULL, decided_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    [ref, ref, picked?.title ?? s.title, picked?.year ?? s.year, picked?.image || null, id],
  );
  // From now on the garden answers for this subject, under its path: the row
  // takes that key, so a later mention finds it instead of making a twin.
  try { db.run(`UPDATE entry_suggestions SET key = ? WHERE id = ?`, [ref, id]); } catch {}
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
