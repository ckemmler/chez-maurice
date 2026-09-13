import { createHash } from "node:crypto";
import db from "../../db";
import { ancillaryComplete, ancillaryModel } from "../ancillary";
import { estimateTokens } from "./notes";

// A conversation loaded into the composer as context. Short ones are pasted
// as a transcript; past SUMMARY_THRESHOLD tokens the composer summarises them
// instead, and caches the summary against a hash of the transcript it read.
//
// The hash is the whole contract. A conversation is a living thing — if it is
// continued after the summary was made, the transcript's hash moves and the
// stored summary is *stale*: still usable (it covers a prefix of the thread),
// but the messages after it are appended verbatim until a fresh summary lands.
// Generation is asynchronous and never blocks a save or a prompt: the resolver
// falls back to whatever is best right now and the next turn gets the summary.

/** Transcript weight (chars/4 tokens) above which a conversation is summarised. */
export const SUMMARY_THRESHOLD = 8_000;

/** Runaway guard — a thread this long is not summarised in one pass. */
const MAX_TRANSCRIPT_CHARS = 1_500_000;


// ── Transcript ───────────────────────────────────────────────────────────────

export interface TranscriptRow {
  id: string;
  role: string;
  content: string;
  display_name: string | null;
}

export function transcriptRows(conversationId: string): TranscriptRow[] {
  return (
    db
      .query(
        `SELECT m.id, m.role, m.content, u.display_name
         FROM messages m LEFT JOIN users u ON u.id = m.author_id
         WHERE m.conversation_id = ? AND m.role != 'system'
         ORDER BY m.created_at, m.rowid`,
      )
      .all(conversationId) as TranscriptRow[]
  );
}

export function transcriptText(rows: TranscriptRow[]): string {
  return rows
    .map((r) => `${r.role === "assistant" ? "Maurice" : r.display_name || "User"}: ${r.content}`)
    .join("\n\n");
}

/** What the summary is keyed on: the transcript as the model would read it. */
export function transcriptHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ── Cache ────────────────────────────────────────────────────────────────────

export interface SummaryRow {
  conversation_id: string;
  content_hash: string;
  summary: string;
  model: string | null;
  message_count: number;
  source_tokens: number;
  created_at: string;
}

export function getStoredSummary(conversationId: string): SummaryRow | null {
  return db
    .query(`SELECT * FROM conversation_summaries WHERE conversation_id = ?`)
    .get(conversationId) as SummaryRow | null;
}

function storeSummary(row: Omit<SummaryRow, "created_at">): void {
  db.run(
    `INSERT INTO conversation_summaries
       (conversation_id, content_hash, summary, model, message_count, source_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(conversation_id) DO UPDATE SET
       content_hash = excluded.content_hash, summary = excluded.summary,
       model = excluded.model, message_count = excluded.message_count,
       source_tokens = excluded.source_tokens, created_at = datetime('now')`,
    [row.conversation_id, row.content_hash, row.summary, row.model, row.message_count, row.source_tokens],
  );
}

// ── Generation ───────────────────────────────────────────────────────────────

export type SummaryGenerator = (input: { title: string; transcript: string }) => Promise<string>;

function buildPrompt(title: string, transcript: string): string {
  return [
    `Here is the full transcript of a conversation titled "${title}" between one or more people and Maurice, an assistant.`,
    "",
    "Write a summary of it that another assistant could rely on as background, without the transcript.",
    "Write it in the language the conversation is mostly held in.",
    "Cover, in this order and only when present: what was being asked or worked on; the facts, figures,",
    "names and decisions that came out of it; what was left open or planned next. Keep the concrete",
    "details — a summary that says \"they discussed options\" is useless; one that says which options",
    "and which was chosen is what is wanted.",
    "Use short paragraphs and, where it helps, a bulleted list. At most 500 words.",
    "Do not add a title, a preamble, or any closing remark. Return the summary and nothing else.",
    "",
    "---",
    "",
    transcript,
  ].join("\n");
}

/** Through the ancillary door: the admin's model for `conversation_summary`,
 *  on whichever provider it belongs to. */
const modelGenerator: SummaryGenerator = async ({ title, transcript }) => {
  const r = await ancillaryComplete({
    invocation: "conversation_summary",
    prompt: buildPrompt(title, transcript),
    maxTokens: 6000,
    effort: "low",
  });
  if (r.stop === "refusal") throw new Error("model declined to summarise");
  if (!r.text) throw new Error("model returned an empty summary");
  if (r.stop === "max_tokens") throw new Error("the summary hit the token ceiling");
  return r.text;
};

let generator: SummaryGenerator = modelGenerator;
/** Tests swap the model call for a stub. */
export function setSummaryGenerator(g: SummaryGenerator | null): void {
  generator = g ?? modelGenerator;
}

// One generation per conversation at a time: the composer weighs, saves and
// resolves in quick succession, and each of those may notice the summary is
// missing. They all wait on the same promise.
const inFlight = new Map<string, Promise<SummaryRow | null>>();

/** Make sure a summary for the transcript as it stands exists, generating one
 *  if the stored row is missing or keyed on an older hash. Resolves to the
 *  fresh row, or null when generation failed (logged, never thrown). */
export function ensureSummary(conversationId: string): Promise<SummaryRow | null> {
  const rows = transcriptRows(conversationId);
  const text = transcriptText(rows);
  const hash = transcriptHash(text);
  const stored = getStoredSummary(conversationId);
  if (stored && stored.content_hash === hash) return Promise.resolve(stored);
  const running = inFlight.get(conversationId);
  if (running) return running;

  const task = (async () => {
    try {
      if (text.length > MAX_TRANSCRIPT_CHARS) {
        throw new Error(`transcript is ${text.length} characters, above the ${MAX_TRANSCRIPT_CHARS} guard`);
      }
      const convo = db.query(`SELECT title FROM conversations WHERE id = ?`).get(conversationId) as
        | { title: string | null }
        | null;
      const summary = await generator({ title: convo?.title || "Untitled conversation", transcript: text });
      storeSummary({
        conversation_id: conversationId,
        content_hash: hash,
        summary,
        model: ancillaryModel("conversation_summary"),
        message_count: rows.length,
        source_tokens: estimateTokens(text),
      });
      console.log(`[composer] summarised conversation ${conversationId} (${rows.length} messages)`);
      return getStoredSummary(conversationId);
    } catch (err) {
      console.warn(`[composer] could not summarise ${conversationId}:`, (err as Error).message);
      return null;
    } finally {
      inFlight.delete(conversationId);
    }
  })();
  inFlight.set(conversationId, task);
  return task;
}

/** Fire-and-forget: a weigh or a save noticed the summary is missing. */
export function scheduleSummary(conversationId: string): void {
  void ensureSummary(conversationId);
}

/** Await every generation in flight. For tests and a clean shutdown. */
export async function whenSummariesSettled(): Promise<void> {
  while (inFlight.size) await Promise.allSettled([...inFlight.values()]);
}

// ── What the composer loads ──────────────────────────────────────────────────

export type SummaryStatus = "ready" | "stale" | "pending" | "none";

export interface ConversationContext {
  /** What is actually loaded: the summary (fresh or stale + tail) or the transcript. */
  representation: "summary" | "full";
  text: string;
  weight: number;
  /** The transcript's own weight, whatever is loaded. */
  fullWeight: number;
  count: number;
  hash: string;
  /** Whether the transcript is long enough to be summarised at all. */
  summarisable: boolean;
  /** ready = the summary matches the transcript; stale = it covers a prefix
   *  (the rest rides along verbatim, a fresh one is on its way); pending =
   *  nothing stored yet, generating; none = the item asked for the full text. */
  summary: SummaryStatus;
  /** stale only: how many messages the loaded summary does not cover. */
  uncovered?: number;
}

/**
 * Resolve a conversation item the way the composer will load it. `wantFull`
 * is the item's `representation: "full"` — the one option a conversation
 * takes — and pins the transcript regardless of length. Otherwise a long
 * transcript is replaced by its summary when one is stored, patched with the
 * tail when the summary is stale, and a generation is scheduled in either
 * missing case.
 */
export function conversationContext(conversationId: string, wantFull = false): ConversationContext {
  const rows = transcriptRows(conversationId);
  const text = transcriptText(rows);
  const fullWeight = estimateTokens(text);
  const hash = transcriptHash(text);
  const summarisable = fullWeight > SUMMARY_THRESHOLD;
  const base = { fullWeight, count: rows.length, hash, summarisable };

  if (wantFull || !summarisable) {
    return { ...base, representation: "full", text, weight: fullWeight, summary: "none" };
  }

  const stored = getStoredSummary(conversationId);
  if (!stored) {
    scheduleSummary(conversationId);
    return { ...base, representation: "full", text, weight: fullWeight, summary: "pending" };
  }
  if (stored.content_hash === hash) {
    return { ...base, representation: "summary", text: stored.summary, weight: estimateTokens(stored.summary), summary: "ready" };
  }
  // Stale: the thread moved on. Load the summary for the part it covers and
  // the messages since, verbatim, while a fresh one is generated.
  scheduleSummary(conversationId);
  const tailRows = rows.slice(stored.message_count);
  const tail = transcriptText(tailRows);
  const combined = tail
    ? `${stored.summary}\n\n— The conversation continued after this summary was written: —\n\n${tail}`
    : stored.summary;
  return {
    ...base,
    representation: "summary",
    text: combined,
    weight: estimateTokens(combined),
    summary: "stale",
    uncovered: tailRows.length,
  };
}
