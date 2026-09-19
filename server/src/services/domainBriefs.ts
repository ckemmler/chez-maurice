import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAppDir } from "../../lib/appDir";
import db from "../db";
import { ancillaryComplete, ancillaryModel, type AncillaryRequest, type AncillaryResult } from "./ancillary";
import { SYSTEM_SPENDER, recordSpend, verdict } from "./budget";
import { getStoredSummary, transcriptHash, transcriptRows, transcriptText } from "./composer/conversationSummary";
import { CHARS_PER_TOKEN, estimateText } from "./contextWindow";
import { searchConversations } from "./conversationSearch";
import { isDue } from "./corpusNightly";
import { userLocale } from "./i18n";
import { isDomain, listMaurices, type Maurice } from "./maurices";
import { corpusCall } from "./mcpClient";
import { getModel } from "./models";
import { listUsers } from "./users";

// The domain briefs — the night's work on what Maurice knows of a member.
//
// A domain (a row of `maurices`: a name, a prompt, a bound context) has a
// *brief*: a short text Maurice keeps on that part of the member's life, the
// working memory the design of 19 September 2026 makes visible — the member
// reads it, corrects it, erases it. This file writes it.
//
// Incremental, always. The first brief is written from the recent
// conversations that belong to the domain; every later one is a rewrite of
// the previous brief from the conversations that touched the domain *since*
// (`domain_briefs.read_until` is the newest message the last rewrite saw). A
// night with nothing new writes nothing and calls no model. One exception to
// the timestamp: a conversation *imported* since the last brief carries the
// dates of its export, older than `read_until`, so `conversations.imported_at`
// is compared with the brief's `updated_at` instead and the conversation is
// read whole, once (P4, 19 September 2026).
//
// What belongs to a domain is found three ways, strongest first: the
// conversations bound to it (`conversations.maurice_id`), the corpus's
// semantic search on the domain's name and tagline (the same store the chat
// searches, scoped to the member), and the full-text search on its name. A
// conversation bound to another domain is never read here.
//
// Every model call runs on the `domain_brief` invocation — DeepSeek V4 Flash
// by default, chosen in P0 bis — is checked against the night's own cap
// before it is made, and is charged to the ledger's "system" spender, so the
// admin sees what the night costs and can stop it.

// ── Sizes ────────────────────────────────────────────────────────────────────

/** Conversations read for one rewrite. Beyond this the oldest wait: a domain
 *  touched by more than eight conversations in one night is an import, and
 *  the first brief reads what is recent rather than everything. */
export const MAX_CONVERSATIONS = 8;
/** Characters of excerpt per conversation — about four hundred tokens. */
export const EXCERPT_CHARS = 1800;
/** The brief's length, in words: P0 bis found the first one deserved more
 *  room than the incremental (~450 tokens against ~300). */
export const FIRST_WORDS = 300;
export const INCREMENTAL_WORDS = 200;
/** Past twice the asked length the text is cut at a paragraph or sentence:
 *  the cap on the *output*, which `max_tokens` cannot be alone — DeepSeek
 *  bills its reasoning as output, up to 2 700 tokens for 190 words. */
const HARD_FACTOR = 2;
/** Room for the reasoning tokens; the text itself is capped above. */
const MAX_TOKENS = 4000;
/** Corpus hits asked for, before grouping by conversation. */
const SEMANTIC_LIMIT = 40;

// ── Rows ─────────────────────────────────────────────────────────────────────

export interface BriefRow {
  maurice_id: string;
  member_id: string;
  text: string;
  updated_at: string;
  /** The conversations the last rewrite read. */
  sources: string[];
  /** The newest message the last rewrite saw (ISO); the next reads after it. */
  read_until: string | null;
  model: string | null;
}

export function getBrief(domainId: string, memberId: string): BriefRow | null {
  const row = db
    .query(`SELECT * FROM domain_briefs WHERE maurice_id = ? AND member_id = ?`)
    .get(domainId, memberId) as (Omit<BriefRow, "sources"> & { sources_json: string }) | null;
  if (!row) return null;
  let sources: string[] = [];
  try {
    const v = JSON.parse(row.sources_json);
    if (Array.isArray(v)) sources = v.map(String);
  } catch {}
  const { sources_json: _, ...rest } = row;
  return { ...rest, sources };
}

function storeBrief(row: Omit<BriefRow, "updated_at">): void {
  db.run(
    `INSERT INTO domain_briefs (maurice_id, member_id, text, updated_at, sources_json, read_until, model)
     VALUES (?, ?, ?, datetime('now'), ?, ?, ?)
     ON CONFLICT(maurice_id, member_id) DO UPDATE SET
       text = excluded.text, updated_at = datetime('now'), sources_json = excluded.sources_json,
       read_until = excluded.read_until, model = excluded.model`,
    [row.maurice_id, row.member_id, row.text, JSON.stringify(row.sources), row.read_until, row.model],
  );
}

/** A member's domains: the rows of kind `domain` they made. A domain shared
 *  with a guest is the creator's, not the guest's. */
export function domainsOf(memberId: string): Maurice[] {
  // Kind `domain` only: a reading companion (a book followed at the reading
  // position) is an activity, not a part of a life, and gets no brief.
  return listMaurices().filter((m) => m.created_by === memberId && isDomain(m));
}

/** The model a brief carries when the member wrote it themselves: a correction
 *  in the app replaces the text and is what Maurice reads from the next turn;
 *  the night's next rewrite starts from it and is told whose words they are. */
export const MEMBER_AUTHOR = "member";

/** The member corrected (or wrote) the brief by hand. What the night knew —
 *  the conversations read and how far — is kept, so the next rewrite still
 *  reads only what came after. An empty text is a deletion. */
export function setBriefText(domainId: string, memberId: string, text: string): BriefRow | null {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) {
    deleteBrief(domainId, memberId);
    return null;
  }
  const previous = getBrief(domainId, memberId);
  storeBrief({
    maurice_id: domainId,
    member_id: memberId,
    text: clean,
    sources: previous?.sources ?? [],
    read_until: previous?.read_until ?? null,
    model: MEMBER_AUTHOR,
  });
  return getBrief(domainId, memberId);
}

/** Erase the brief: Maurice forgets what he kept on the domain, and the next
 *  night writes a first brief again, from the whole domain. */
export function deleteBrief(domainId: string, memberId: string): boolean {
  const before = db.query(`SELECT 1 FROM domain_briefs WHERE maurice_id = ? AND member_id = ?`).get(domainId, memberId);
  if (!before) return false;
  db.run(`DELETE FROM domain_briefs WHERE maurice_id = ? AND member_id = ?`, [domainId, memberId]);
  return true;
}

// ── What the everyday Maurice reads ──────────────────────────────────────────
//
// Every brief of the member's domains rides in the system prompt of their own
// conversations — after the persona and the loaded context, so the cached
// prefix only moves when a brief does (once a night, or on a correction) —
// under one global budget. Never in a room, never for another member: the
// caller (services/claude.ts) holds those two rules; this side only knows
// whose briefs to fetch.

/** The global budget of the briefs section, in estimated tokens. */
export const BRIEFS_BUDGET_TOKENS = 3000;

export interface PromptBrief {
  name: string;
  text: string;
  updated_at: string;
  model: string | null;
}

/** The section of the system prompt, or "" when the member has no brief. The
 *  briefs are taken most recently rewritten first; one that does not fit whole
 *  is cut at a paragraph (never mid-sentence) and closes the section, and the
 *  domains left out are named so Maurice knows they exist. */
export function briefsSection(briefs: PromptBrief[], memberName: string, budgetTokens = BRIEFS_BUDGET_TOKENS): string {
  const live = briefs.filter((b) => b.text.trim()).sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
  if (!live.length) return "";
  const head =
    `\n\n## Your briefs on ${memberName}'s domains\n` +
    `A domain is a part of ${memberName}'s life you follow. On each you keep a brief: your working memory, written from past conversations and read, corrected or erased by ${memberName} — a brief marked "in their own words" is theirs and prevails over anything you remember otherwise. ` +
    `Draw on these when a question falls into a domain, without reciting them or claiming more than they say; ` +
    `${memberName} can read and edit every brief in the app, so when they ask what you know of a domain, this is it.`;
  let used = estimateText(head);
  const parts: string[] = [];
  const left: string[] = [];
  for (const b of live) {
    if (left.length) { left.push(b.name); continue; }
    const day = b.updated_at.slice(0, 10);
    const by = b.model === MEMBER_AUTHOR ? ", in their own words" : "";
    const title = `\n\n### ${b.name} (brief of ${day}${by})\n`;
    const room = budgetTokens - used - estimateText(title);
    const whole = estimateText(b.text.trim());
    if (whole <= room) {
      parts.push(title + b.text.trim());
      used += estimateText(title) + whole;
      continue;
    }
    // Cut at a paragraph if at least a third of the room is left for it.
    const cut = cutToTokens(b.text.trim(), room);
    if (cut && estimateText(cut) >= Math.min(whole, 120)) {
      parts.push(title + cut + "\n(…cut short for room.)");
      used = budgetTokens;
    }
    left.push(b.name);
  }
  // A brief cut short is also listed as left out — the list names what
  // Maurice does not have in full, which is the useful fact.
  const tail = left.length ? `\n\nNot loaded in full, for room: ${left.join(", ")}.` : "";
  return head + parts.join("") + tail;
}

/** The longest prefix of `text` under `tokens`, ending on a paragraph break,
 *  else on a sentence end; "" when no sentence fits. */
function cutToTokens(text: string, tokens: number): string {
  if (tokens <= 0) return "";
  const chars = tokens * CHARS_PER_TOKEN;
  if (text.length <= chars) return text;
  const head = text.slice(0, chars);
  const para = head.lastIndexOf("\n\n");
  if (para > 0) return head.slice(0, para).trim();
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf(".\n"), head.lastIndexOf("! "), head.lastIndexOf("? "));
  if (sentence > 0) return head.slice(0, sentence + 1).trim();
  return "";
}

/** The briefs section for a member's own conversation: every brief on the
 *  domains they made. The caller decides whether this conversation is one. */
export function briefsForPrompt(memberId: string, memberName: string, budgetTokens = BRIEFS_BUDGET_TOKENS): string {
  const rows = db
    .query(
      `SELECT m.name, b.text, b.updated_at, b.model FROM domain_briefs b
       JOIN maurices m ON m.id = b.maurice_id
       WHERE b.member_id = ? AND m.created_by = ?
         AND (m.kind IS NULL OR m.kind = 'domain')`,
    )
    .all(memberId, memberId) as PromptBrief[];
  return briefsSection(rows, memberName, budgetTokens);
}

// ── What the model reads ─────────────────────────────────────────────────────

export interface Turn {
  role: string;
  content: string;
  created_at: string;
}

export interface Material {
  conversation_id: string;
  title: string;
  /** How the conversation was found; `bound` outranks the two searches. */
  how: "bound" | "semantic" | "search";
  score: number;
  /** The turns read — after `since` when there is one. */
  turns: Turn[];
  /** What the prompt carries for this conversation. */
  excerpt: string;
}

function squash(text: string): string {
  return (text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cut(text: string, n: number): string {
  const s = squash(text);
  if (s.length <= n) return s;
  const head = s.slice(0, n - 1);
  const sp = head.lastIndexOf(" ");
  return (sp > n / 2 ? head.slice(0, sp) : head) + "…";
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

/** The excerpt P0 bis settled on: the first turn nearly whole, the rest cut
 *  short, up to the character budget. */
export function excerptOf(turns: Turn[], title: string, who: string): string {
  const lines = [`— ${day(turns[turns.length - 1]!.created_at)} — "${title || "(untitled)"}"`];
  let used = 0;
  turns.forEach((t, i) => {
    const cap = i === 0 ? 500 : t.role === "user" ? 280 : 380;
    const piece = cut(t.content, cap);
    if (!piece) return;
    const line = `  ${t.role === "user" ? who : "Maurice"}: ${piece}`;
    if (used + line.length > EXCERPT_CHARS) return;
    lines.push(line);
    used += line.length;
  });
  return lines.join("\n");
}

export function turnsOf(conversationId: string, since: string | null): Turn[] {
  const rows = (
    since
      ? db
          .query(
            `SELECT role, content, created_at FROM messages
             WHERE conversation_id = ? AND role IN ('user', 'assistant') AND created_at > ?
             ORDER BY created_at, rowid`,
          )
          .all(conversationId, since)
      : db
          .query(
            `SELECT role, content, created_at FROM messages
             WHERE conversation_id = ? AND role IN ('user', 'assistant')
             ORDER BY created_at, rowid`,
          )
          .all(conversationId)
  ) as Turn[];
  return rows.filter((r) => (r.content || "").trim());
}

/** What the run needs from the world, replaceable by a test. */
export interface BriefDeps {
  /** The model call: `ancillaryComplete` in the server. */
  write: (req: AncillaryRequest) => Promise<AncillaryResult>;
  /** The corpus's semantic search, scoped to the member: conversation ids
   *  with their best score. Empty when the corpus is unreachable. */
  search: (memberId: string, query: string) => Promise<Array<{ conversation_id: string; score: number }>>;
  members: () => Array<{ id: string; role: string }>;
  now?: () => Date;
}

async function corpusSearch(memberId: string, query: string): Promise<Array<{ conversation_id: string; score: number }>> {
  const r = await corpusCall(memberId, "search", {
    query,
    limit: SEMANTIC_LIMIT,
    filters: { source_type: "conversation" },
  });
  const best = new Map<string, number>();
  for (const hit of (r?.results ?? []) as Array<{ conversation_id?: string; score?: number }>) {
    if (!hit.conversation_id) continue;
    const s = Number(hit.score ?? 0);
    if (s > (best.get(hit.conversation_id) ?? -Infinity)) best.set(hit.conversation_id, s);
  }
  return [...best].map(([conversation_id, score]) => ({ conversation_id, score }));
}

const defaultDeps: BriefDeps = {
  write: ancillaryComplete,
  search: corpusSearch,
  members: () => listUsers(),
};

let deps: BriefDeps = defaultDeps;
/** Tests swap the model call and the corpus for stubs. */
export function setBriefDeps(d: Partial<BriefDeps> | null): void {
  deps = d ? { ...defaultDeps, ...d } : defaultDeps;
}

/** The conversations of a domain with something new since `since`, ranked,
 *  capped, then in chronological order for the prompt. `importedAfter` is the
 *  wall-clock of the previous brief (`updated_at`): a conversation imported
 *  after it carries the dates of its export, older than `since`, and is read
 *  whole this once — the next rewrite's `updated_at` will be past its import. */
export async function findMaterial(
  memberId: string,
  domain: Maurice,
  since: string | null,
  who: string,
  importedAfter: string | null = null,
): Promise<Material[]> {
  type Cand = { how: Material["how"]; score: number };
  const cands = new Map<string, Cand>();
  const offer = (id: string, c: Cand) => {
    const cur = cands.get(id);
    if (!cur || rank(c) > rank(cur)) cands.set(id, c);
  };
  const rank = (c: Cand) => (c.how === "bound" ? 3 : c.how === "semantic" ? 2 : 1) * 1000 + c.score;

  const bound = db
    .query(
      `SELECT c.id FROM conversations c
       JOIN conversation_participants p ON p.conversation_id = c.id AND p.member_id = ?
       WHERE c.maurice_id = ? ORDER BY c.updated_at DESC LIMIT 100`,
    )
    .all(memberId, domain.id) as Array<{ id: string }>;
  for (const b of bound) offer(b.id, { how: "bound", score: 1 });

  // The query is the domain's name and tagline, plus the opening of its
  // prompt when it has one: what the member wrote it is about. A name alone
  // ("Yi Jing") pulls in neighbours; a sentence of intent narrows the search.
  const query = [domain.name, domain.tagline, domainStatement(domain, 300)].filter((s) => s && s.trim()).join(". ");
  try {
    for (const hit of await deps.search(memberId, query)) {
      offer(hit.conversation_id, { how: "semantic", score: hit.score });
    }
  } catch (err) {
    console.warn(`[briefs] corpus search failed for "${domain.name}": ${(err as Error).message}`);
  }
  try {
    for (const hit of searchConversations(memberId, domain.name, { limit: 15 })) {
      offer(hit.conversation.id, { how: "search", score: hit.hits });
    }
  } catch (err) {
    console.warn(`[briefs] text search failed for "${domain.name}": ${(err as Error).message}`);
  }

  const out: Material[] = [];
  for (const [id, c] of cands) {
    const convo = db
      .query(
        `SELECT c.title, c.maurice_id, c.imported_at FROM conversations c
         JOIN conversation_participants p ON p.conversation_id = c.id AND p.member_id = ?
         WHERE c.id = ?`,
      )
      .get(memberId, id) as { title: string | null; maurice_id: string | null; imported_at: string | null } | null;
    if (!convo) continue; // not the member's: the corpus said so, the database decides
    if (convo.maurice_id && convo.maurice_id !== domain.id) continue; // another domain's
    // Imported since the last brief: its messages predate `since`, read it whole.
    const fresh = !!(since && importedAfter && convo.imported_at && convo.imported_at > importedAfter);
    const turns = turnsOf(id, fresh ? null : since);
    // Nothing the member said since: Maurice's own reply is not new matter.
    if (!turns.some((t) => t.role === "user")) continue;
    const title = convo.title ?? "";
    out.push({ conversation_id: id, title, how: c.how, score: c.score, turns, excerpt: "" });
  }
  out.sort((a, b) => {
    const r = rank({ how: b.how, score: b.score }) - rank({ how: a.how, score: a.score });
    return r !== 0 ? r : b.turns[b.turns.length - 1]!.created_at.localeCompare(a.turns[a.turns.length - 1]!.created_at);
  });
  const kept = out.slice(0, MAX_CONVERSATIONS);
  for (const m of kept) {
    // A first reading of a long, already summarised conversation reads the
    // summary the composer keeps rather than the transcript's head.
    const stored = since ? null : getStoredSummary(m.conversation_id);
    if (stored && stored.content_hash === transcriptHash(transcriptText(transcriptRows(m.conversation_id)))) {
      m.excerpt = `— ${day(m.turns[m.turns.length - 1]!.created_at)} — "${m.title || "(untitled)"}" (summary)\n  ${cut(stored.summary, EXCERPT_CHARS)}`;
    } else {
      m.excerpt = excerptOf(m.turns, m.title, who);
    }
  }
  kept.sort((a, b) => a.turns[a.turns.length - 1]!.created_at.localeCompare(b.turns[b.turns.length - 1]!.created_at));
  return kept;
}

// ── The prompt ───────────────────────────────────────────────────────────────

export const LANGUAGE: Record<string, string> = {
  en: "English", fr: "French", it: "Italian", de: "German", es: "Spanish", pt: "Portuguese", nl: "Dutch",
};

/** The language the night writes to a member in: their own locale when the
 *  app has set one, else the household's — the first admin's locale — else
 *  English. A member who never opened the settings (Paola, on the first
 *  mapping of 19 September 2026) would otherwise be written to in English in
 *  a French household. */
export function memberLanguage(memberId: string): string {
  return LANGUAGE[memberLocale(memberId)] ?? "English";
}

/** The locale code behind `memberLanguage`: the member's own when set, else
 *  the household's (the first admin's), else `en`. */
export function memberLocale(memberId: string): string {
  const own = userLocale(memberId);
  const ownRow = db.query(`SELECT locale FROM user_preferences WHERE user_id = ?`).get(memberId) as { locale: string | null } | null;
  if (ownRow?.locale?.trim() && LANGUAGE[own]) return own;
  const admin = db
    .query(`SELECT p.locale FROM users u JOIN user_preferences p ON p.user_id = u.id WHERE u.role = 'admin' AND p.locale IS NOT NULL AND p.locale != '' ORDER BY u.created_at LIMIT 1`)
    .get() as { locale: string } | null;
  return LANGUAGE[admin?.locale ?? ""] ? admin!.locale : LANGUAGE[own] ? own : "en";
}

export function systemPrompt(name: string, language: string, words: number): string {
  return [
    `You are Maurice, ${name}'s personal assistant. For each part of their life you keep a brief: your working memory on that domain, made visible. ${name} will read it, correct it or throw it away.`,
    `Write in ${language}, addressing ${name} as "you", plainly, without flattery or filler. No title, no preamble, no closing line, no bullet points: two or three short paragraphs, ${words} words at most. Dates and concrete facts rather than generalities; what is under way and the open threads rather than a summary of everything. When it was you who answered in a conversation, you may say so in the first person.`,
    `Two rules. Never lend ${name} a position, a decision or a feeling they did not state — what they asked about is not what they think. And ask no question: a brief is a note, not a conversation.`,
  ].join("\n\n");
}

/** What the domain is about, in the member's words: the opening of its
 *  prompt, cut on a sentence. "" when it has none. */
export function domainStatement(domain: Maurice, chars: number): string {
  const p = (domain.prompt ?? "").replace(/\s+/g, " ").trim();
  if (!p) return "";
  if (p.length <= chars) return p;
  const head = p.slice(0, chars);
  const end = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  return end > chars / 3 ? head.slice(0, end + 1) : head.trim() + "…";
}

function aboutLine(domain: Maurice, name: string): string {
  const st = domainStatement(domain, 800);
  return st ? ` ${name} describes it so: "${st}" Take that as the statement of what the domain is about — the brief covers this, not the rest.` : "";
}

export function firstPrompt(domain: Maurice, name: string, excerpts: string): string {
  const tag = domain.tagline?.trim() ? ` (${domain.tagline.trim()})` : "";
  return [
    `The domain is called "${domain.name}"${tag}.${aboutLine(domain, name)} Here are excerpts from ${name}'s conversations that belong to it, oldest first:`,
    excerpts,
    `Write the brief of this domain: what you know of this part of their life, where it stands, what remains open.`,
  ].join("\n\n");
}

export function incrementalPrompt(
  domain: Maurice,
  previous: string,
  excerpts: string,
  words: number,
  opts: { name?: string; byMember?: boolean } = {},
): string {
  const name = opts.name ?? "the member";
  const kept = opts.byMember
    ? `Here is the brief as ${name} rewrote it by hand — their wording is right by definition: keep it unless the conversations below moved things on:`
    : `Here is the brief you kept until now:`;
  return [
    `The domain is called "${domain.name}".${aboutLine(domain, name)} ${kept}`,
    previous,
    `And here are excerpts from conversations since then, oldest first:`,
    excerpts,
    `Rewrite the brief: keep what is still true, update what moved, drop what is out of date, add what is new. One brief, same rules, ${words} words at most.`,
  ].join("\n\n");
}

/** The output cap: past `factor` times the asked length, cut at the last
 *  paragraph break, else the last sentence end, before the limit. */
export function capWords(text: string, words: number, factor = HARD_FACTOR): string {
  const t = text.trim();
  const all = t.split(/\s+/);
  const max = words * factor;
  if (all.length <= max) return t;
  // The character position of the max-th word.
  let pos = 0;
  let n = 0;
  for (const m of t.matchAll(/\S+/g)) {
    n++;
    if (n > max) { pos = m.index!; break; }
  }
  const head = t.slice(0, pos);
  const para = head.lastIndexOf("\n\n");
  if (para > head.length / 3) return head.slice(0, para).trim();
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf(".\n"), head.lastIndexOf("! "), head.lastIndexOf("? "));
  if (sentence > head.length / 3) return head.slice(0, sentence + 1).trim();
  return head.trim();
}

// ── One rewrite ──────────────────────────────────────────────────────────────

export type RefreshOutcome = "written" | "unchanged" | "failed" | "capped";

export interface RefreshResult {
  outcome: RefreshOutcome;
  brief: BriefRow | null;
  /** Conversations read this time. */
  sources: number;
  cost_usd: number | null;
  error?: string;
}

const inFlight = new Map<string, Promise<RefreshResult>>();

/**
 * Rewrite one domain's brief for its member, if anything touched the domain
 * since the last one. Never throws: a failure is the outcome, logged. One
 * rewrite per (domain, member) at a time — the admin's button during the
 * night's run joins it.
 */
export function refreshBrief(domain: Maurice, memberId: string): Promise<RefreshResult> {
  const key = `${domain.id}:${memberId}`;
  const running = inFlight.get(key);
  if (running) return running;
  const task = doRefresh(domain, memberId).finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

async function doRefresh(domain: Maurice, memberId: string): Promise<RefreshResult> {
  const previous = getBrief(domain.id, memberId);
  const since = previous?.read_until ?? null;
  const member = db.query(`SELECT display_name FROM users WHERE id = ?`).get(memberId) as { display_name: string } | null;
  const name = member?.display_name || "the member";
  const language = memberLanguage(memberId);

  let material: Material[];
  try {
    material = await findMaterial(memberId, domain, since, name, previous?.updated_at ?? null);
  } catch (err) {
    const error = (err as Error).message;
    console.warn(`[briefs] "${domain.name}": could not gather material: ${error}`);
    return { outcome: "failed", brief: previous, sources: 0, cost_usd: null, error };
  }
  if (!material.length) return { outcome: "unchanged", brief: previous, sources: 0, cost_usd: null };

  // The night's cap, checked before the call rather than after the bill.
  const modelId = ancillaryModel("domain_brief");
  const provider = getModel(modelId)?.provider ?? null;
  const v = verdict(provider, modelId, 0, SYSTEM_SPENDER);
  if (!v.ok) {
    console.warn(`[briefs] "${domain.name}": ${v.reason}`);
    return { outcome: "capped", brief: previous, sources: material.length, cost_usd: null, error: v.reason };
  }

  const words = previous?.text.trim() ? INCREMENTAL_WORDS : FIRST_WORDS;
  const excerpts = material.map((m) => m.excerpt).join("\n\n");
  const prompt = previous?.text.trim()
    ? incrementalPrompt(domain, previous.text.trim(), excerpts, words, { name, byMember: previous.model === MEMBER_AUTHOR })
    : firstPrompt(domain, name, excerpts);

  let result: AncillaryResult;
  try {
    result = await deps.write({
      invocation: "domain_brief",
      system: systemPrompt(name, language, words),
      prompt,
      maxTokens: MAX_TOKENS,
      temperature: 0.4,
    });
  } catch (err) {
    const error = (err as Error).message;
    console.warn(`[briefs] "${domain.name}": model call failed: ${error}`);
    return { outcome: "failed", brief: previous, sources: material.length, cost_usd: null, error };
  }
  // What it cost is the household's, on nobody's turn.
  recordSpend(result.usage, SYSTEM_SPENDER);
  const cost = result.usage?.cost ?? null;

  if (result.stop === "refusal" || result.stop === "max_tokens" || !result.text.trim()) {
    const error = result.stop === "max_tokens" ? "the brief hit the token ceiling" : `the model returned nothing usable (${result.stop})`;
    console.warn(`[briefs] "${domain.name}": ${error}`);
    return { outcome: "failed", brief: previous, sources: material.length, cost_usd: cost, error };
  }

  const text = capWords(result.text, words);
  const readUntil = material
    .flatMap((m) => m.turns.map((t) => t.created_at))
    .reduce((a, b) => (b > a ? b : a), since ?? "");
  storeBrief({
    maurice_id: domain.id,
    member_id: memberId,
    text,
    sources: material.map((m) => m.conversation_id),
    read_until: readUntil || null,
    model: result.model,
  });
  console.log(
    `[briefs] "${domain.name}" for ${name}: ${previous?.text.trim() ? "rewritten" : "written"} from ${material.length} conversation(s)` +
      (cost != null ? ` for $${cost.toFixed(4)}` : ""),
  );
  return { outcome: "written", brief: getBrief(domain.id, memberId), sources: material.length, cost_usd: cost };
}

// ── The night ────────────────────────────────────────────────────────────────
//
// An hour after the corpus has reconciled (services/corpusNightly.ts, 03:00):
// the semantic search should see last evening's conversations before the
// briefs read them. Same shape: a tick every ten minutes, once per local day
// from the hour on, the last run in a small file on the app dir, a run in
// flight shared rather than doubled. A cap that blows stops the whole night —
// there is no point trying the next domain against the same allowance.

const HOUR = 4;
const TICK_MS = 10 * 60 * 1000;
const FIRST_TICK_MS = 45_000;

export type BriefsNightlyOutcome = "done" | "capped" | "failed" | "no_domains";

export interface BriefsNightlyStats {
  members: number;
  domains: number;
  written: number;
  unchanged: number;
  failed: number;
  cost_usd: number;
}

export interface BriefsNightlyState {
  last_run_at: string | null;
  last_outcome: BriefsNightlyOutcome | null;
  last_error: string | null;
  last_stats: BriefsNightlyStats | null;
  duration_ms: number | null;
}

let nightly: Promise<BriefsNightlyOutcome> | null = null;
let state: BriefsNightlyState | null = null;

export function briefsNightlyOn(): boolean {
  if (process.env.MAURICE_DOMAIN_BRIEFS?.trim() === "off") return false;
  if (process.env.NODE_ENV === "test") return false;
  return true;
}

function stateFile(): string {
  return join(getAppDir(), "domain-briefs-nightly.json");
}

function loadState(): BriefsNightlyState {
  if (state) return state;
  try {
    if (existsSync(stateFile())) {
      state = JSON.parse(readFileSync(stateFile(), "utf8"));
      return state!;
    }
  } catch {
    // A corrupt state file costs one extra run, nothing more.
  }
  state = { last_run_at: null, last_outcome: null, last_error: null, last_stats: null, duration_ms: null };
  return state;
}

function saveState(next: BriefsNightlyState): void {
  state = next;
  try {
    mkdirSync(dirname(stateFile()), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify(next, null, 2) + "\n");
  } catch (err) {
    console.warn(`[briefs] nightly: could not save state: ${(err as Error).message}`);
  }
}

export function briefsNightlyStatus(): BriefsNightlyState & { on: boolean; running: boolean } {
  return { ...loadState(), on: briefsNightlyOn(), running: nightly !== null };
}

async function doNight(): Promise<BriefsNightlyOutcome> {
  const now = deps.now ?? (() => new Date());
  const started = now();
  const finish = (outcome: BriefsNightlyOutcome, error: string | null, stats: BriefsNightlyStats | null) => {
    saveState({
      last_run_at: started.toISOString(),
      last_outcome: outcome,
      last_error: error,
      last_stats: stats,
      duration_ms: now().getTime() - started.getTime(),
    });
    return outcome;
  };
  // Guests are visitors, not members whose life Maurice follows.
  const members = deps.members().filter((m) => m.role !== "guest");
  const work = members.flatMap((m) => domainsOf(m.id).map((d) => ({ member: m.id, domain: d })));
  const stats: BriefsNightlyStats = { members: members.length, domains: work.length, written: 0, unchanged: 0, failed: 0, cost_usd: 0 };
  if (!work.length) {
    console.log("[briefs] nightly: no domains, nothing to write");
    return finish("no_domains", null, stats);
  }
  let lastError: string | null = null;
  for (const { member, domain } of work) {
    const r = await refreshBrief(domain, member);
    stats.cost_usd += r.cost_usd ?? 0;
    if (r.outcome === "capped") {
      console.warn(`[briefs] nightly: stopped — ${r.error}`);
      return finish("capped", r.error ?? "capped", stats);
    }
    if (r.outcome === "written") stats.written++;
    else if (r.outcome === "unchanged") stats.unchanged++;
    else {
      stats.failed++;
      lastError = `${domain.name}: ${r.error ?? "failed"}`;
    }
  }
  const ms = now().getTime() - started.getTime();
  console.log(
    `[briefs] nightly: ${stats.written} brief(s) written, ${stats.unchanged} unchanged, ${stats.failed} failed ` +
      `across ${stats.domains} domain(s) of ${stats.members} member(s) for $${stats.cost_usd.toFixed(4)} in ${Math.round(ms / 1000)}s`,
  );
  return finish(stats.failed ? "failed" : "done", lastError, stats);
}

/** Rewrite every member's briefs now. Never throws; a run already going is
 *  shared rather than doubled. */
export function runDomainBriefs(): Promise<BriefsNightlyOutcome> {
  if (!nightly) {
    nightly = doNight().finally(() => {
      nightly = null;
    });
  }
  return nightly;
}

/** Tick every ten minutes; run once per local day from HOUR on. */
export function scheduleDomainBriefsNightly(): void {
  if (!briefsNightlyOn()) {
    console.log("[briefs] nightly briefs off");
    return;
  }
  const tick = () => {
    if (nightly) return;
    if (!isDue(new Date(), loadState().last_run_at, HOUR)) return;
    runDomainBriefs().catch((err) => console.error(`[briefs] nightly: ${(err as Error).message}`));
  };
  setTimeout(() => {
    tick();
    setInterval(tick, TICK_MS).unref();
  }, FIRST_TICK_MS).unref();
}
