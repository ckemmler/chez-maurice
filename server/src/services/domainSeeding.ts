import fs from "node:fs";
import path from "node:path";
import db from "../db";
import { atomicWrite, autoCommit, dumpFrontmatter, gardenFor, type GardenRef } from "../../data-api/services/gardenFiche";
import { slugify } from "../../data-api/services/articleExtract";
import { ancillaryComplete, ancillaryModel, type AncillaryRequest, type AncillaryResult } from "./ancillary";
import { recordSpend, verdict } from "./budget";
import { invalidateNotes, scanNotes } from "./composer/notes";
import { LANGUAGE, excerptOf, getBrief, memberLocale, turnsOf, type Turn } from "./domainBriefs";
import { parseJsonObject } from "./domainMapping";
import { getModel } from "./models";
import type { Maurice } from "./maurices";

// Seeding the garden — P2-C of the domains design (19 September 2026, 4d).
//
// When a member adopts a domain, Maurice offers to write a few notes on it
// in their garden: one *hub* note for the domain — what he understood, the
// open threads, where it comes from — and, when the conversations hold
// distinct subjects, a note per salient topic under it. The hub is a MOC and
// the topics its children (`parent`, wiki-links): the domain's sub-tree.
//
// Two rules hold everything here. **Nothing is written without the member's
// yes to the notes themselves** — the tool that calls `seedDomain` exists only
// in the conversation Maurice opened to propose, and its description and the
// prompt section say an adoption is not that yes (services/domainProposals.ts).
// And **every note carries its provenance and the mark of not having been
// reviewed**: `meta.opened: false`, the convention the articles pipeline
// uses for a fiche a share wrote automatically (data-api/services/gardenFiche.ts,
// `isOpened`); `meta.author: maurice`, the domain, the model, the
// conversations read, in the frontmatter; and a *where it comes from*
// section in the body, in the member's language. The mark goes when the
// member keeps the note (the garden's toolbar, `reviewNote` in
// services/gardenTools.ts) or rewrites it through Maurice; throwing it away
// is deleting it. The garden is git: nothing here is irreversible.
//
// Who pays. The seeding runs inside the member's own turn — their yes is a
// tool call the model makes on that turn — so it is charged to the member,
// like the documentation tool's sub-turn (services/mauriceDocsTool.ts), under
// their own fuse: the night's `system` allowance is for what runs when nobody
// is typing. The model is the night's (`domain_seed` invocation, DeepSeek V4
// Flash by default): the notes are written from the same material the brief
// reads, and the cost is a few cents at most.

// ── Sizes ────────────────────────────────────────────────────────────────────

/** Conversations read: the most recent bound to the domain. Sixteen excerpts
 *  of ~1 800 characters is about eight thousand tokens, the design's
 *  estimate for one seeding. */
export const SEED_CONVERSATIONS = 16;
/** Topic notes at most; the hub is always one. */
export const MAX_TOPICS = 3;
/** Room for the model's reasoning, which DeepSeek bills as output. */
const MAX_TOKENS = 8000;
export const SEED_INVOCATION = "domain_seed";

// ── What the member reads, in their language ─────────────────────────────────

interface Words {
  understood: string;
  threads: string;
  provenance: string;
  notes: string;
  /** "Written by Maurice on {date} from {n} conversations, with {model}." */
  written: (date: string, n: number, model: string) => string;
  /** The line that says what the mark means. */
  unreviewed: string;
}

const WORDS: Record<string, Words> = {
  en: {
    understood: "What I understood", threads: "Open threads", provenance: "Where it comes from", notes: "Notes",
    written: (d, n, m) => `Written by Maurice on ${d} from ${n} conversation${n === 1 ? "" : "s"}, with ${m}.`,
    unreviewed: "Not reviewed yet: keep it, correct it, or throw it away.",
  },
  fr: {
    understood: "Ce que j'ai compris", threads: "Les fils ouverts", provenance: "D'où ça vient", notes: "Notes",
    written: (d, n, m) => `Écrite par Maurice le ${d} à partir de ${n} conversation${n === 1 ? "" : "s"}, avec ${m}.`,
    unreviewed: "Pas encore relue : à garder, corriger ou jeter.",
  },
  it: {
    understood: "Quello che ho capito", threads: "I fili aperti", provenance: "Da dove viene", notes: "Note",
    written: (d, n, m) => `Scritta da Maurice il ${d} a partire da ${n} conversazion${n === 1 ? "e" : "i"}, con ${m}.`,
    unreviewed: "Non ancora riletta: da tenere, correggere o buttare.",
  },
  de: {
    understood: "Was ich verstanden habe", threads: "Offene Fäden", provenance: "Woher es kommt", notes: "Notizen",
    written: (d, n, m) => `Von Maurice am ${d} aus ${n} Gespräch${n === 1 ? "" : "en"} geschrieben, mit ${m}.`,
    unreviewed: "Noch nicht durchgesehen: behalten, korrigieren oder verwerfen.",
  },
  es: {
    understood: "Lo que entendí", threads: "Hilos abiertos", provenance: "De dónde viene", notes: "Notas",
    written: (d, n, m) => `Escrita por Maurice el ${d} a partir de ${n} conversaci${n === 1 ? "ón" : "ones"}, con ${m}.`,
    unreviewed: "Aún sin revisar: guardar, corregir o tirar.",
  },
  pt: {
    understood: "O que entendi", threads: "Fios em aberto", provenance: "De onde vem", notes: "Notas",
    written: (d, n, m) => `Escrita pelo Maurice em ${d} a partir de ${n} conversa${n === 1 ? "" : "s"}, com ${m}.`,
    unreviewed: "Ainda não revista: guardar, corrigir ou deitar fora.",
  },
  nl: {
    understood: "Wat ik begrepen heb", threads: "Open draden", provenance: "Waar het vandaan komt", notes: "Notities",
    written: (d, n, m) => `Door Maurice geschreven op ${d} uit ${n} gesprek${n === 1 ? "" : "ken"}, met ${m}.`,
    unreviewed: "Nog niet nagelezen: bewaren, verbeteren of weggooien.",
  },
};

function wordsFor(locale: string): Words {
  return WORDS[locale] ?? WORDS.en!;
}

function longDate(d: Date, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

// ── The material ─────────────────────────────────────────────────────────────

export interface SeedSource {
  conversation_id: string;
  title: string;
  first: string;
  last: string;
  turns: Turn[];
  excerpt: string;
}

/** The conversations bound to the domain, most recent first, capped, then in
 *  chronological order for the prompt — the same excerpts the brief reads. */
export function seedMaterial(memberId: string, domain: Maurice, who: string, limit = SEED_CONVERSATIONS): SeedSource[] {
  const rows = db
    .query(
      `SELECT c.id, COALESCE(c.title, '') AS title FROM conversations c
       WHERE c.maurice_id = ? AND c.user_id = ? ORDER BY c.updated_at DESC, c.created_at DESC LIMIT ?`,
    )
    .all(domain.id, memberId, limit) as Array<{ id: string; title: string }>;
  const out: SeedSource[] = [];
  for (const r of rows) {
    const turns = turnsOf(r.id, null);
    if (!turns.some((t) => t.role === "user")) continue;
    out.push({
      conversation_id: r.id,
      title: r.title,
      first: turns[0]!.created_at,
      last: turns[turns.length - 1]!.created_at,
      turns,
      excerpt: excerptOf(turns, r.title, who),
    });
  }
  out.sort((a, b) => a.last.localeCompare(b.last));
  return out;
}

// ── The prompt ───────────────────────────────────────────────────────────────

export function seedSystemPrompt(name: string, language: string): string {
  return [
    `You are Maurice, ${name}'s personal assistant. ${name} has just adopted a domain — a part of their life you follow — and asked you to write a few notes on it in their garden, a folder of Markdown notes they own. They will read every note, keep it, correct it, or throw it away: write what is worth keeping.`,
    `Write in ${language}, addressing ${name} as "you", plainly, without flattery or filler. Dates and concrete facts rather than generalities. Markdown inside the texts (paragraphs, short lists) is fine; no headings, no title — the notes get theirs.`,
    `Two rules. Never lend ${name} a position, a decision or a feeling they did not state — what they asked about is not what they think. And ask no question: a note is not a conversation.`,
    `Answer with one JSON object and nothing else.`,
  ].join("\n\n");
}

export function seedPrompt(domain: Maurice, name: string, sources: SeedSource[], brief: string | null): string {
  const numbered = sources.map((s, i) => `[${i + 1}] ${s.excerpt}`).join("\n\n");
  const statement = (domain.prompt ?? "").replace(/\s+/g, " ").trim();
  return [
    `The domain is called "${domain.name}".${statement ? ` ${name} says it is about: ${statement}` : ""}`,
    brief ? `Your brief on it, as it stands:\n${brief}` : "",
    `The conversations bound to it, numbered, oldest first (${name}'s turns and yours, cut short):\n\n${numbered}`,
    `Write the notes. Return a JSON object with these keys:\n` +
      `- "description": one line on what the domain is, for the note's subtitle (no final period).\n` +
      `- "understood": what you understood of this domain — two to four short paragraphs, ${Math.min(400, 120 + sources.length * 20)} words at most: what it is for ${name}, how it has moved over time, what is under way.\n` +
      `- "open_threads": the threads left open — questions ${name} raised and did not settle, things they meant to do, decisions pending — as a Markdown list of three to eight short items, each with a date when the conversations give one. An empty string when there is none.\n` +
      `- "topics": zero to ${MAX_TOPICS} distinct subjects inside the domain that deserve a note of their own (a recurring question, a project, a thing being learned) — only when the conversations really carry them — a subject seen in one conversation is not salient; an empty list is a fine answer. Each: {"title": a short title, "body": 150 to 300 words on that subject, "sources": the numbers of the conversations it draws on, at least two}.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface SeedText {
  description: string;
  understood: string;
  open_threads: string;
  topics: Array<{ title: string; body: string; sources: number[] }>;
}

/** Conversations a topic must draw on to get a note of its own: a subject
 *  seen once is not salient (the first trial wrote a topic from one 2023
 *  conversation). */
export const MIN_TOPIC_SOURCES = 2;

/** The model's answer, read leniently; null when nothing usable came back.
 *  A topic short of `MIN_TOPIC_SOURCES` cited conversations is dropped. */
export function parseSeed(text: string, n: number): SeedText | null {
  const d = parseJsonObject(text);
  if (!d || typeof d.understood !== "string" || !d.understood.trim()) return null;
  const topics: SeedText["topics"] = [];
  for (const t of Array.isArray(d.topics) ? d.topics : []) {
    if (!t || typeof t.title !== "string" || !t.title.trim() || typeof t.body !== "string" || !t.body.trim()) continue;
    const sources = [...new Set((Array.isArray(t.sources) ? t.sources : []).map(Number).filter((x: number) => Number.isInteger(x) && x >= 1 && x <= n))] as number[];
    if (sources.length < MIN_TOPIC_SOURCES) continue;
    topics.push({ title: t.title.trim().slice(0, 120), body: t.body.trim(), sources });
    if (topics.length >= MAX_TOPICS) break;
  }
  return {
    description: typeof d.description === "string" ? d.description.trim().replace(/\.$/, "").slice(0, 200) : "",
    understood: d.understood.trim(),
    open_threads: typeof d.open_threads === "string" ? d.open_threads.trim() : "",
    topics,
  };
}

// ── The notes ────────────────────────────────────────────────────────────────

export interface SeededNote {
  slug: string;
  locale: string;
  title: string;
  file: string;
  web_path: string;
  /** `hub` (the domain's note, a MOC) or `topic` (a child). */
  role: "hub" | "topic";
}

function noteWebPath(username: string, locale: string, slug: string): string {
  return `/g/${username}${locale === "en" ? "" : `/${locale}`}/notes/${slug}`;
}

/** A slug no note of the garden holds yet, in any locale. */
export function freeSlug(garden: GardenRef, base: string, taken: Set<string>): string {
  const exists = (slug: string) => {
    if (taken.has(slug)) return true;
    const notes = path.join(garden.root, "notes");
    if (!fs.existsSync(notes)) return false;
    for (const locale of fs.readdirSync(notes)) {
      for (const ext of [".md", ".mdx"]) if (fs.existsSync(path.join(notes, locale, slug + ext))) return true;
    }
    return false;
  };
  let slug = base || "domaine";
  for (let i = 2; exists(slug); i++) slug = `${base}-${i}`;
  taken.add(slug);
  return slug;
}

function provenanceSection(w: Words, sources: SeedSource[], model: string, locale: string, now: Date): string {
  const lines = sources.map((s) => `- ${s.last.slice(0, 10)} — ${s.title || "(untitled)"}`);
  return `## ${w.provenance}\n\n${w.written(longDate(now, locale), sources.length, model)} ${w.unreviewed}\n\n${lines.join("\n")}`;
}

/**
 * Write the notes into the member's garden: the hub (a MOC with the three
 * sections and the topics as wiki-links) and one note per topic under it,
 * every one marked `meta.opened: false` with its provenance. One commit.
 */
export function writeSeedNotes(
  memberId: string,
  domain: Maurice,
  seed: SeedText,
  sources: SeedSource[],
  model: string,
  now = new Date(),
): SeededNote[] {
  const garden = gardenFor(memberId);
  if (!garden) throw new Error("the member has no garden");
  const locale = memberLocale(memberId);
  const w = wordsFor(locale);
  const dir = path.join(garden.root, "notes", locale);
  fs.mkdirSync(dir, { recursive: true });
  const day = now.toISOString().slice(0, 10);
  const taken = new Set<string>();
  const hubSlug = freeSlug(garden, slugify(domain.name), taken);
  const written: SeededNote[] = [];
  const files: string[] = [];

  const meta = (ids: string[], role: "hub" | "topic") => ({
    opened: false,
    author: "maurice",
    domain: domain.id,
    domain_name: domain.name,
    role,
    model,
    written_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    sources: ids,
  });

  // The topics first, so the hub can link them.
  const topicNotes: Array<{ slug: string; title: string }> = [];
  for (const t of seed.topics) {
    const slug = freeSlug(garden, slugify(t.title) || `${hubSlug}-note`, taken);
    const its = t.sources.map((i) => sources[i - 1]!).filter(Boolean);
    const fm = {
      title: t.title,
      date: day,
      flags: [] as string[],
      locale,
      parent: hubSlug,
      meta: meta(its.map((s) => s.conversation_id), "topic"),
    };
    const body = `\n${t.body.trim()}\n\n${provenanceSection(w, its, model, locale, now)}\n`;
    const file = path.join(dir, `${slug}.md`);
    atomicWrite(file, `---\n${dumpFrontmatter(fm)}\n---\n${body}`);
    files.push(file);
    topicNotes.push({ slug, title: t.title });
    written.push({ slug, locale, title: t.title, file, web_path: noteWebPath(garden.username, locale, slug), role: "topic" });
  }

  const hubFm: Record<string, unknown> = {
    title: domain.name,
    date: day,
    flags: ["moc"],
    locale,
    ...(seed.description ? { description: seed.description } : {}),
    meta: meta(sources.map((s) => s.conversation_id), "hub"),
  };
  const hubBody = [
    `## ${w.understood}\n\n${seed.understood.trim()}`,
    seed.open_threads.trim() ? `## ${w.threads}\n\n${seed.open_threads.trim()}` : "",
    topicNotes.length ? `## ${w.notes}\n\n${topicNotes.map((t) => `[[${t.slug}|${t.title}]]`).join("\n\n")}` : "",
    provenanceSection(w, sources, model, locale, now),
  ]
    .filter(Boolean)
    .join("\n\n");
  const hubFile = path.join(dir, `${hubSlug}.md`);
  atomicWrite(hubFile, `---\n${dumpFrontmatter(hubFm as any)}\n---\n\n${hubBody}\n`);
  files.push(hubFile);
  written.unshift({ slug: hubSlug, locale, title: domain.name, file: hubFile, web_path: noteWebPath(garden.username, locale, hubSlug), role: "hub" });

  autoCommit(garden, files, `Seed domain notes: ${domain.name}`);
  invalidateNotes(memberId);
  return written;
}

// ── One seeding ──────────────────────────────────────────────────────────────

export interface SeedDeps {
  write: (req: AncillaryRequest) => Promise<AncillaryResult>;
  now?: () => Date;
}
const defaultDeps: SeedDeps = { write: ancillaryComplete };
let deps: SeedDeps = defaultDeps;
/** Tests swap the model call for a stub. */
export function setSeedDeps(d: Partial<SeedDeps> | null): void {
  deps = d ? { ...defaultDeps, ...d } : defaultDeps;
}

export type SeedOutcome = "written" | "nothing_to_read" | "capped" | "failed";

export interface SeedResult {
  outcome: SeedOutcome;
  notes: SeededNote[];
  sources: number;
  cost_usd: number | null;
  model?: string;
  error?: string;
}

/**
 * Write the notes of a domain for its member, on the member's turn and
 * account. Never throws: a failure is the outcome. The caller has made sure
 * of the yes; this only makes sure of the fuse and the material.
 */
export async function seedDomain(domain: Maurice, memberId: string): Promise<SeedResult> {
  const member = db.query(`SELECT display_name FROM users WHERE id = ?`).get(memberId) as { display_name: string } | null;
  const name = member?.display_name || "the member";
  const locale = memberLocale(memberId);
  const language = LANGUAGE[locale] ?? "English";

  const sources = seedMaterial(memberId, domain, name);
  if (!sources.length) return { outcome: "nothing_to_read", notes: [], sources: 0, cost_usd: null };

  // The member's own fuse, checked before the call: their yes is a turn of
  // theirs, and a second billed request must not walk through a cap the
  // first was checked against.
  const modelId = ancillaryModel(SEED_INVOCATION);
  const provider = getModel(modelId)?.provider ?? null;
  const fuse = verdict(provider, modelId, 0, memberId);
  if (!fuse.ok) {
    console.warn(`[seeding] "${domain.name}" for ${name}: ${fuse.reason}`);
    return { outcome: "capped", notes: [], sources: sources.length, cost_usd: null, error: fuse.reason };
  }

  const brief = getBrief(domain.id, memberId)?.text?.trim() || null;
  let r: AncillaryResult;
  try {
    r = await deps.write({
      invocation: SEED_INVOCATION,
      system: seedSystemPrompt(name, language),
      prompt: seedPrompt(domain, name, sources, brief),
      maxTokens: MAX_TOKENS,
      temperature: 0.4,
    });
  } catch (err) {
    const error = (err as Error).message;
    console.warn(`[seeding] "${domain.name}": model call failed: ${error}`);
    return { outcome: "failed", notes: [], sources: sources.length, cost_usd: null, error };
  }
  recordSpend(r.usage, memberId);
  const cost = r.usage?.cost ?? null;

  const seed = r.stop === "refusal" ? null : parseSeed(r.text, sources.length);
  if (!seed) {
    const error = r.stop === "max_tokens" ? "the notes hit the token ceiling" : `the model returned nothing usable (${r.stop})`;
    console.warn(`[seeding] "${domain.name}": ${error}`);
    return { outcome: "failed", notes: [], sources: sources.length, cost_usd: cost, model: r.model, error };
  }

  let notes: SeededNote[];
  try {
    notes = writeSeedNotes(memberId, domain, seed, sources, r.model, deps.now?.() ?? new Date());
  } catch (err) {
    const error = (err as Error).message;
    console.warn(`[seeding] "${domain.name}": could not write the notes: ${error}`);
    return { outcome: "failed", notes: [], sources: sources.length, cost_usd: cost, model: r.model, error };
  }
  console.log(
    `[seeding] "${domain.name}" for ${name}: ${notes.length} note(s) written from ${sources.length} conversation(s)` +
      (cost != null ? ` for $${cost.toFixed(4)}` : ""),
  );
  return { outcome: "written", notes, sources: sources.length, cost_usd: cost, model: r.model };
}

// ── What a garden holds of a domain ──────────────────────────────────────────

/** The notes of a member's garden that Maurice seeded for a domain, from
 *  their frontmatter: how many, how many still unreviewed, and the hub's web
 *  path. Null when there is none. */
export function seededNotesOf(memberId: string, domainId: string): { total: number; unreviewed: number; web_path: string | null } | null {
  const garden = gardenFor(memberId);
  if (!garden) return null;
  let total = 0;
  let unreviewed = 0;
  let hub: string | null = null;
  let first: string | null = null;
  for (const n of scanNotes(memberId).values()) {
    if (n.domain !== domainId) continue;
    total++;
    if (n.unreviewed) unreviewed++;
    const p = noteWebPath(garden.username, n.locale, n.slug);
    if (n.isMoc && !hub) hub = p;
    if (!first) first = p;
  }
  return total ? { total, unreviewed, web_path: hub ?? first } : null;
}

/** For the tool's answer: what the member should hear. */
export function describeSeeding(r: SeedResult): string {
  switch (r.outcome) {
    case "written": return `${r.notes.length} note(s) written in the garden, marked as written by Maurice and not yet reviewed`;
    case "nothing_to_read": return "no conversation of the member's is bound to this domain, so there is nothing to write from";
    case "capped": return `not written: ${r.error ?? "spending limit reached"}`;
    default: return `not written: ${r.error ?? "failed"}`;
  }
}
