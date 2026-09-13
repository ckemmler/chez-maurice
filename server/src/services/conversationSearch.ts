import db from "../db";
import { getParticipants, type Conversation } from "./conversations";
import { blockedIdsFor } from "./safety";

// Full-text search across a member's conversations, over the FTS5 index that
// db.ts keeps in step with `messages`. Scoped to the rooms the member sits in;
// turns by members they have blocked are never matched. A title match counts
// too, so a conversation you remember by name is found even when the words
// never appear in a message.

export interface ConversationSearchHit {
  conversation: Conversation & {
    message_count: number;
    last_message_at: string | null;
    participants: ReturnType<typeof getParticipants>;
  };
  /** The best-matching passage, with the matched words wrapped in ⟦ ⟧. */
  snippet: string;
  /** The message the snippet comes from; null for a title-only match. */
  message_id: string | null;
  /** How many messages matched in this conversation. */
  hits: number;
}

/** FTS5 has a query language of its own (AND, OR, NEAR, quotes, columns). A
 *  search box wants plain words, so every term is quoted and made a prefix:
 *  `bon mon` → `"bon"* "mon"*` (implicit AND). Empty when nothing usable. */
export function ftsQuery(q: string): string {
  return q
    .split(/\s+/)
    .map((t) => t.replace(/"/g, "").trim())
    .filter(Boolean)
    .map((t) => `"${t}"*`)
    .join(" ");
}

export const SNIPPET_OPEN = "⟦";
export const SNIPPET_CLOSE = "⟧";

interface MessageHit {
  conversation_id: string;
  message_id: string;
  snippet: string;
  rank: number;
}

export function searchConversations(
  memberId: string,
  q: string,
  opts: { limit?: number } = {},
): ConversationSearchHit[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 30, 100));
  const match = ftsQuery(q);
  if (!match) return [];
  const blocked = blockedIdsFor(memberId);

  // Best passages first. The row cap keeps a very common word from dragging
  // the whole archive through; the grouping below keeps one entry per room.
  const rows = db
    .query(
      `SELECT m.conversation_id, m.id AS message_id, m.author_id,
              snippet(messages_fts, 0, ?, ?, '…', 14) AS snippet,
              bm25(messages_fts) AS rank
       FROM messages_fts
       JOIN messages m ON m.rowid = messages_fts.rowid
       JOIN conversation_participants p
         ON p.conversation_id = m.conversation_id AND p.member_id = ?
       WHERE messages_fts MATCH ? AND m.role != 'system'
       ORDER BY rank
       LIMIT 600`,
    )
    .all(SNIPPET_OPEN, SNIPPET_CLOSE, memberId, match) as Array<MessageHit & { author_id: string | null }>;

  const byConvo = new Map<string, { best: MessageHit; hits: number }>();
  for (const r of rows) {
    if (r.author_id && blocked.has(r.author_id)) continue;
    const cur = byConvo.get(r.conversation_id);
    if (cur) cur.hits += 1;
    else byConvo.set(r.conversation_id, { best: r, hits: 1 });
  }

  // Title matches ride along, ranked after any content match they duplicate.
  const like = `%${q.trim().replace(/[%_]/g, (ch) => "\\" + ch)}%`;
  const titled = db
    .query(
      `SELECT c.id, c.title FROM conversations c
       JOIN conversation_participants p ON p.conversation_id = c.id AND p.member_id = ?
       WHERE c.title LIKE ? ESCAPE '\\'
       ORDER BY c.updated_at DESC LIMIT 50`,
    )
    .all(memberId, like) as Array<{ id: string; title: string }>;

  const ids: string[] = [...byConvo.keys()];
  for (const t of titled) if (!byConvo.has(t.id)) ids.push(t.id);

  const out: ConversationSearchHit[] = [];
  for (const id of ids.slice(0, limit)) {
    const c = db
      .query(
        `SELECT c.id, c.user_id, c.title, c.maurice_id, c.origin, c.created_at, c.updated_at,
                (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
                (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = c.id) AS last_message_at
         FROM conversations c WHERE c.id = ?`,
      )
      .get(id) as (Conversation & { message_count: number; last_message_at: string | null }) | null;
    if (!c) continue;
    const m = byConvo.get(id);
    out.push({
      conversation: { ...c, participants: getParticipants(id) },
      snippet: m ? m.best.snippet : c.title ?? "",
      message_id: m ? m.best.message_id : null,
      hits: m ? m.hits : 0,
    });
  }
  return out;
}
