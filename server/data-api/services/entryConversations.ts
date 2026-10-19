/**
 * The conversations about one garden entry, and what each came to.
 *
 * An entry can be talked about many times, in different settings: from
 * Carnet's page (the conversation is *held from* the entry — `entry_ref`), or
 * in the Maurice app with the entry's fiche loaded into the composer. Both
 * count; a conversation that merely mentions the work does not.
 *
 * What a conversation came to lives in the fiche, as a fragment of its own —
 * written only when the member asks to see it, and keyed on the hash of the
 * transcript it read. Asked again after the conversation went on, the hash has
 * moved and the fragment is rewritten in place; asked again without, it is
 * read back as it is. One fragment per conversation, so an entry discussed
 * three times carries three.
 *
 *   ---
 *   summary: "Conversation avec Maurice — <title>"
 *   conversation: <id>
 *   transcript_hash: <sha256 of the transcript>
 *   written_at: 2026-10-19
 *   ---
 *   <what came out of it>
 *
 *   *([Conversation avec Maurice : « <title> »](maurice://conversations/<id>))*
 *
 * The last line is the way back for whoever reads the fiche elsewhere — the
 * garden site, Obsidian; the app shows the summary without it.
 */

import fs from "node:fs";
import path from "node:path";
import db from "../../src/db";
import { ancillaryComplete } from "../../src/services/ancillary";
import { recordSpend } from "../../src/services/budget";
import { getConversation, isParticipant } from "../../src/services/conversations";
import { transcriptHash, transcriptRows, transcriptText } from "../../src/services/composer/conversationSummary";
import type { TurnUsage } from "../../src/services/pricing";
import { getUser } from "../../src/services/users";
import {
  autoCommit, fragmentsDir, gardenFor, markOpened, parseFiche, writeFiche, type GardenRef,
} from "./gardenFiche";
import { listGardenEntries } from "./gardenEntries";
import { indexGardenPaths } from "./gardenIndex";

export class EntryConversationError extends Error {
  constructor(message: string, public readonly status: 404 | 409 | 422 | 502 = 404) {
    super(message);
  }
}

export interface EntryRef { collection: string; locale: string; slug: string }

export interface ConversationSummaryFragment {
  /** `f:NNN`, the fragment's id on the entry's page. */
  id: string;
  text: string;
  written_at: string | null;
  /** The conversation went on after it was written. */
  stale: boolean;
}

export interface EntryConversation {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
  /** How it is about the entry: held from its page, or with its fiche in context. */
  via: "entry" | "context";
  /** The specialised Maurice it was held with — its setting; null for the everyday one. */
  maurice: { id: string; name: string } | null;
  summary: ConversationSummaryFragment | null;
}

const refString = (r: EntryRef) => `${r.collection}/${r.locale}/${r.slug}`;

/** The entry's fiche, as an absolute path, or null when it has none. */
function ficheFile(garden: GardenRef, ref: EntryRef): string | null {
  const e = listGardenEntries(garden).find(
    (x) => x.collection === ref.collection && x.locale === ref.locale && x.slug === ref.slug,
  );
  return e?.fiche ? path.join(garden.root, e.fiche.file) : null;
}

// ── Which conversations ──

interface Row {
  id: string; title: string | null; created_at: string; updated_at: string;
  entry_ref: string | null; maurice_id: string | null; maurice_name: string | null; message_count: number;
}

/**
 * The member's conversations about this entry, newest first. A conversation
 * with nothing said in it yet is left out: Carnet creates one on the tap that
 * opens the Maurice app, and it is about the entry only once someone spoke.
 */
export function conversationsAbout(memberId: string, ref: EntryRef): EntryConversation[] {
  const entry = refString(ref);
  const rows = db
    .query(
      `SELECT c.id, c.title, c.created_at, c.updated_at, c.entry_ref, c.maurice_id,
              mr.name AS maurice_name,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role != 'system') AS message_count
       FROM conversations c
       JOIN conversation_participants p ON p.conversation_id = c.id AND p.member_id = ?
       LEFT JOIN maurices mr ON mr.id = c.maurice_id
       WHERE c.entry_ref = ?
          OR EXISTS (
            SELECT 1 FROM composer_specs s, json_each(s.spec_json, '$.items') j
            WHERE s.conversation_id = c.id AND s.account_id = ?
              AND json_extract(j.value, '$.type') = 'fiche'
              AND json_extract(j.value, '$.id') = ?)
       ORDER BY c.updated_at DESC, c.id DESC`,
    )
    .all(memberId, entry, memberId, `${entry}-fiche`) as Row[];

  const garden = gardenFor(memberId);
  const fiche = garden ? ficheFile(garden, ref) : null;
  const written = fiche ? summaryFragments(fiche) : new Map<string, StoredFragment>();

  return rows
    .filter((r) => r.message_count > 0)
    .map((r) => {
      const stored = written.get(r.id);
      return {
        id: r.id,
        title: r.title,
        created_at: r.created_at,
        updated_at: r.updated_at,
        message_count: r.message_count,
        via: r.entry_ref === entry ? "entry" : "context",
        maurice: r.maurice_id && r.maurice_name ? { id: r.maurice_id, name: r.maurice_name } : null,
        summary: stored ? describe(stored, currentHash(r.id)) : null,
      };
    });
}

/** Is this conversation one of the entry's? */
function isAbout(memberId: string, ref: EntryRef, conversationId: string): boolean {
  return conversationsAbout(memberId, ref).some((c) => c.id === conversationId);
}

// ── The fragments ──

interface StoredFragment { file: string; num: string; hash: string; writtenAt: string | null; body: string }

const PROVENANCE = /\n*\*\(\[[^\]]*\]\(maurice:\/\/conversations\/[A-Za-z0-9_-]+\)\)\*\s*$/;

/** The fiche's conversation summaries, by conversation id. */
function summaryFragments(ficheFile: string): Map<string, StoredFragment> {
  const out = new Map<string, StoredFragment>();
  const dir = fragmentsDir(ficheFile);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".frag")).sort();
  } catch {
    return out;
  }
  for (const f of files) {
    const file = path.join(dir, f);
    const parsed = parseFiche(fs.readFileSync(file, "utf-8"));
    const id = parsed?.frontmatter.conversation;
    if (!parsed || !id) continue;
    out.set(String(id), {
      file, num: path.basename(f, ".frag"),
      hash: String(parsed.frontmatter.transcript_hash ?? ""),
      writtenAt: parsed.frontmatter.written_at ? String(parsed.frontmatter.written_at) : null,
      body: parsed.body.trim(),
    });
  }
  return out;
}

/** Is this fragment a conversation's summary? The shelf lists those apart. */
export function isConversationFragment(frontmatter: Record<string, any>): boolean {
  return !!frontmatter.conversation;
}

function describe(stored: StoredFragment, hash: string): ConversationSummaryFragment {
  return {
    id: `f:${stored.num}`,
    text: stored.body.replace(PROVENANCE, "").trim(),
    written_at: stored.writtenAt,
    stale: stored.hash !== hash,
  };
}

function currentHash(conversationId: string): string {
  return transcriptHash(transcriptText(transcriptRows(conversationId)));
}

// ── Writing one ──

export interface EntryConversationSummaryInput {
  entryTitle: string;
  conversationTitle: string;
  memberName: string;
  transcript: string;
}
export type EntryConversationSummarizer = (
  input: EntryConversationSummaryInput,
) => Promise<{ text: string; usage: TurnUsage | null }>;

/** Runaway guard: past this a thread is not summarised in one pass. */
const MAX_TRANSCRIPT_CHARS = 1_500_000;

/**
 * How long the summary may run, in words: about a third of the conversation,
 * between 60 and 300. Asked for "at most 400" alone, DeepSeek wrote 560 words
 * on a 770-word thread — nearly the thread again.
 */
export function conversationWordBudget(transcript: string): number {
  const words = transcript.split(/\s+/).filter(Boolean).length;
  return Math.min(300, Math.max(60, Math.round(words / 3 / 10) * 10));
}

export function entryConversationPrompt(input: EntryConversationSummaryInput): string {
  const budget = conversationWordBudget(input.transcript);
  return [
    `Here is a conversation between ${input.memberName} and Maurice, an assistant, about "${input.entryTitle}"`,
    `(titled "${input.conversationTitle}"). It will be kept in ${input.memberName}'s notes on "${input.entryTitle}",`,
    "beside what they already know of the work itself.",
    "",
    `Write what came out of the conversation, for ${input.memberName} to reread later instead of the transcript:`,
    "the questions that were explored, and for each what was found or concluded; the ideas, connections,",
    "references and figures worth keeping; what stayed open. A disagreement only if one was actually voiced —",
    "never infer one. Keep the concrete",
    "details — \"they discussed the author's method\" is useless; which method, and what was made of it, is",
    "what is wanted. Do not restate the work itself beyond what the conversation added to it.",
    "",
    `Hard limit: ${budget} words — fewer when the conversation produced less. Keep what was found and`,
    "concluded; drop how the exchange went. Plain paragraphs; a short bulleted list only where it genuinely helps.",
    "Write it in the language the conversation is mostly held in. Speak of the member by name or as",
    "\"you\" — never \"the user\". No title, no preamble, no closing remark. Return the text and nothing else.",
    "",
    "---",
    "",
    input.transcript,
  ].join("\n");
}

const modelSummarizer: EntryConversationSummarizer = async (input) => {
  const r = await ancillaryComplete({
    invocation: "entry_conversation_summary",
    prompt: entryConversationPrompt(input),
    maxTokens: 6000,
    effort: "low",
  });
  if (r.stop === "refusal") throw new EntryConversationError("the model declined to summarise", 502);
  if (!r.text) throw new EntryConversationError("the model returned an empty summary", 502);
  if (r.stop === "max_tokens") throw new EntryConversationError("the summary hit the token ceiling", 502);
  return { text: r.text, usage: r.usage };
};

/** The text alone, nothing written — what the fiche would get. */
export const summarizeEntryConversation: EntryConversationSummarizer = (input) => summarizer(input);

let summarizer: EntryConversationSummarizer = modelSummarizer;
/** Tests swap the model call for a stub. */
export function setEntryConversationSummarizer(s: EntryConversationSummarizer | null): void {
  summarizer = s ?? modelSummarizer;
}

/** One pass per conversation and fiche at a time; a second ask waits on it. */
const inFlight = new Map<string, Promise<ConversationSummaryFragment>>();

/**
 * The summary of one of the entry's conversations, as the fiche holds it —
 * written now when it is missing or the conversation went on since.
 */
export function summaryFor(
  memberId: string, ref: EntryRef, conversationId: string,
): Promise<ConversationSummaryFragment> {
  const key = `${memberId}:${refString(ref)}:${conversationId}`;
  const running = inFlight.get(key);
  if (running) return running;
  const task = writeSummary(memberId, ref, conversationId).finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

async function writeSummary(
  memberId: string, ref: EntryRef, conversationId: string,
): Promise<ConversationSummaryFragment> {
  const garden = gardenFor(memberId);
  if (!garden) throw new EntryConversationError("No garden for this member");
  if (!isParticipant(conversationId, memberId) || !isAbout(memberId, ref, conversationId)) {
    throw new EntryConversationError("No such conversation about this entry");
  }
  const fiche = ficheFile(garden, ref);
  if (!fiche) throw new EntryConversationError("This entry has no fiche to keep it in", 409);

  const rows = transcriptRows(conversationId);
  const transcript = transcriptText(rows);
  const hash = transcriptHash(transcript);
  const existing = summaryFragments(fiche).get(conversationId);
  if (existing && existing.hash === hash) return describe(existing, hash);
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    throw new EntryConversationError("This conversation is too long to summarise in one pass", 422);
  }

  const parsedFiche = parseFiche(fs.readFileSync(fiche, "utf-8"));
  if (!parsedFiche) throw new EntryConversationError("Could not read the fiche", 422);
  const entryTitle = String(parsedFiche.frontmatter.title ?? ref.slug).replace(/\s*[—-]\s*fiche$/i, "");
  const conversationTitle = getConversation(conversationId, memberId)?.title?.trim() || entryTitle;
  const member = getUser(memberId);

  const made = await summarizer({
    entryTitle, conversationTitle, transcript,
    memberName: member?.display_name || member?.username || "the member",
  });
  recordSpend(made.usage, memberId);

  // Where it goes: over its own previous version, so a conversation keeps one
  // fragment however often it is summarised; otherwise after the last one.
  const target = existing?.file ?? nextFragmentFile(fiche, ref.collection);
  const writtenAt = new Date().toISOString().slice(0, 10);
  const link = `*([Conversation avec Maurice : « ${conversationTitle.replace(/[\[\]]/g, "")} »](maurice://conversations/${conversationId}))*`;
  writeFiche(target, {
    summary: `Conversation avec Maurice — ${conversationTitle}`,
    conversation: conversationId,
    transcript_hash: hash,
    written_at: writtenAt,
  }, `${made.text.trim()}\n\n${link}`);

  // A fiche that holds a conversation's result has the member's attention.
  const paths = [target];
  const fresh = parseFiche(fs.readFileSync(fiche, "utf-8"));
  if (fresh && markOpened(fresh.frontmatter)) {
    writeFiche(fiche, fresh.frontmatter, fresh.body);
    paths.push(fiche);
  }
  autoCommit(garden, paths, `${existing ? "Update" : "Keep"} conversation summary: ${refString(ref)}`);
  indexGardenPaths(memberId, paths);

  const written = summaryFragments(fiche).get(conversationId);
  if (!written) throw new EntryConversationError("The summary could not be written", 502);
  return describe(written, hash);
}

/** An article's first fragment is its text — kept free even on a bookmark,
 *  which has none yet: a summary filed as 001 would be read as the article. */
function nextFragmentFile(ficheFile: string, collection: string): string {
  const dir = fragmentsDir(ficheFile);
  fs.mkdirSync(dir, { recursive: true });
  const nums = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".frag"))
    .map((f) => Number(path.basename(f, ".frag")))
    .filter((n) => Number.isInteger(n));
  const floor = collection === "articles" ? 2 : 1;
  const next = String(Math.max(floor, (nums.length ? Math.max(...nums) : 0) + 1)).padStart(3, "0");
  return path.join(dir, `${next}.frag`);
}
