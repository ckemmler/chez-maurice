import db from "../db";
import { addMessage, createConversation, getConversation, type Conversation, type Message } from "./conversations";
import { publishToUser, userHasSocket } from "./roomBus";
import { pushToUser } from "./push";
import { getUser } from "./users";

// A conversation Maurice opens on his own — the new brick of the domains
// design (19 September 2026, section 4b): until now a conversation always
// began with a human. Here Maurice creates one for a single member, writes
// its first message himself, leaves it unread, and tells the member the way
// a room does — on their live socket, or by push when they have none. From
// the member's first reply on, it is a conversation like any other.
//
// This file does not decide *what* Maurice says: the night (P2-B) composes
// the message that proposes domains; the admin route and the script hand a
// text in. No model is called here, so nothing is charged to the ledger.
//
// The guard: never for a child, never for a guest (their life is in another
// household), and never twice within `households.maurice_opens_min_days`
// (fifteen by default, set in the console) for one member. A proposal left
// unanswered waits; it is not repeated.

export const OPENED_BY_MAURICE = "maurice";
/** Days between two conversations Maurice opens for one member, unless the
 *  household says otherwise. */
export const DEFAULT_MIN_DAYS = 15;

export type GuardRefusal = "unknown" | "child" | "guest" | "too_soon";

export type GuardVerdict =
  | { ok: true; last_opened_at: string | null }
  | { ok: false; reason: GuardRefusal; last_opened_at: string | null; next_at: string | null };

/** The household's guard, in days (the default when unset). */
export function opensMinDays(): number {
  const row = db
    .query<{ d: number | null }, []>(`SELECT maurice_opens_min_days AS d FROM households WHERE id = 'default'`)
    .get();
  const d = row?.d;
  return typeof d === "number" && Number.isFinite(d) && d >= 0 ? d : DEFAULT_MIN_DAYS;
}

/** Set the guard (null = back to the default). */
export function setOpensMinDays(days: number | null): void {
  const stored = days == null ? null : Math.max(0, Math.floor(days));
  db.run(`UPDATE households SET maurice_opens_min_days = ? WHERE id = 'default'`, [stored]);
}

/** When Maurice last opened a conversation for this member (ISO, UTC), or null. */
export function lastOpenedAt(memberId: string): string | null {
  const row = db
    .query<{ at: string | null }, [string, string]>(
      `SELECT MAX(created_at) AS at FROM conversations WHERE user_id = ? AND opened_by = ?`,
    )
    .get(memberId, OPENED_BY_MAURICE);
  return row?.at ?? null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** SQLite's `datetime('now')` is "YYYY-MM-DD HH:MM:SS" in UTC; read it as such. */
function parseSqlite(at: string): number {
  return Date.parse(at.includes("T") ? at : at.replace(" ", "T") + "Z");
}

/** May Maurice open a conversation for this member now? */
export function openingGuard(memberId: string, now: Date = new Date()): GuardVerdict {
  const user = getUser(memberId);
  const last = lastOpenedAt(memberId);
  if (!user) return { ok: false, reason: "unknown", last_opened_at: last, next_at: null };
  if (user.is_child) return { ok: false, reason: "child", last_opened_at: last, next_at: null };
  if (user.role === "guest") return { ok: false, reason: "guest", last_opened_at: last, next_at: null };
  if (last) {
    const nextMs = parseSqlite(last) + opensMinDays() * DAY_MS;
    if (Number.isFinite(nextMs) && nextMs > now.getTime()) {
      return { ok: false, reason: "too_soon", last_opened_at: last, next_at: new Date(nextMs).toISOString() };
    }
  }
  return { ok: true, last_opened_at: last };
}

export interface OpenRequest {
  memberId: string;
  /** Maurice's first message, markdown; what the member reads first. */
  text: string;
  /** The conversation's title; the first line of the text when omitted. */
  title?: string | null;
  /** A domain (a row of `maurices`) to bind the conversation to, or null for
   *  the everyday Maurice. */
  mauriceId?: string | null;
  /** Skip the guard — the admin's hand, and one night's: the mailbox
   *  numbers (services/mailScan.ts), opened once per member when the header
   *  walk is done, settled 26 September 2026. */
  force?: boolean;
}

export type OpenResult =
  | { ok: true; conversation: Conversation; message: Message }
  | { ok: false; reason: GuardRefusal | "empty"; last_opened_at?: string | null; next_at?: string | null };

/** A short, image-stripped preview for the notification. */
export function preview(content: string): string {
  const t = content.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  return t.length > 140 ? t.slice(0, 140) + "…" : t;
}

/** A title from the message when none is given: its first line, without
 *  markdown heading marks, cut like autoTitle cuts a member's first message. */
export function titleFrom(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").replace(/[*_`]/g, "").trim())
    .find((l) => l.length > 0);
  return (line || "Maurice").slice(0, 80);
}

/**
 * Open a conversation for a member, with Maurice's first message. The
 * conversation is unread until the member opens it (its participant row
 * keeps `last_read_at` null); the member's global socket learns of it as
 * `conversation_opened`, and a member with no socket gets a push.
 */
export async function openConversation(req: OpenRequest): Promise<OpenResult> {
  const text = req.text.replace(/\r\n/g, "\n").trim();
  if (!text) return { ok: false, reason: "empty" };
  if (!req.force) {
    const verdict = openingGuard(req.memberId);
    if (!verdict.ok) return verdict;
  } else if (!getUser(req.memberId)) {
    return { ok: false, reason: "unknown" };
  }

  const created = createConversation(req.memberId, req.mauriceId ?? null, { openedBy: OPENED_BY_MAURICE });
  const title = (req.title ?? "").trim() || titleFrom(text);
  db.run(`UPDATE conversations SET title = ? WHERE id = ?`, [title, created.id]);
  // The first message is Maurice's: no author, no usage — nothing was
  // generated here — and the domain it speaks for, when there is one.
  const message = addMessage(created.id, "assistant", text, { mauriceId: req.mauriceId ?? null });
  const conversation = getConversation(created.id, req.memberId)!;

  const body = preview(text);
  publishToUser(req.memberId, {
    type: "conversation_opened",
    conversationId: conversation.id,
    title,
    author: "Maurice",
    preview: body,
  });
  if (!userHasSocket(req.memberId)) {
    void pushToUser(req.memberId, { title, body: `Maurice: ${body}`, conversationId: conversation.id });
  }
  console.log(`[opened] Maurice opened ${conversation.id} for ${req.memberId} ("${title}")`);
  return { ok: true, conversation, message };
}

/** The lead a provider needs when the history starts with Maurice's own
 *  message: the Messages API refuses a first message in the assistant role
 *  (and the OpenAI-style ones read a bare assistant opener oddly). One
 *  constant user turn, so the cached prefix does not move. */
export const OPENER_LEAD = "[Maurice opened this conversation on his own. His first message follows.]";

/** Make sure the history sent to the model starts with a user turn. */
export function ensureUserFirst<T extends { role: string }>(messages: T[]): T[] {
  if (messages.length === 0 || messages[0]!.role !== "assistant") return messages;
  return [{ role: "user", content: [{ type: "text", text: OPENER_LEAD }] } as unknown as T, ...messages];
}
