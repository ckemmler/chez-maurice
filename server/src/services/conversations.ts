import db from "../db";

export interface Conversation {
  id: string;
  user_id: string;
  title: string | null;
  /** the specialized Maurice this conversation uses; null = everyday Maurice */
  maurice_id: string | null;
  /** provenance; null = native, 'anthropic' = imported from a Claude.ai export */
  origin: string | null;
  created_at: string;
  updated_at: string;
  message_count?: number;
  last_message_at?: string | null;
  /** the room's members — drives the sidebar/header avatar stack */
  participants?: Participant[];
  /** specialist Maurices that have answered in this thread (for the cluster) */
  maurice_ids?: string[];
  /** whether the everyday Maurice (no specialist) has answered here */
  has_everyday_maurice?: boolean;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  model: string | null;
  author_id: string | null;
  /** which Maurice produced this turn (assistant rows; null = everyday) */
  maurice_id: string | null;
  /** structured tool results for this turn, [{ tool, data }], or null —
   *  rendered by the client beside the prose. Stored as a JSON TEXT column;
   *  exposed here already parsed (see hydrateMessage). */
  data: { tool: string; data: unknown }[] | null;
  created_at: string;
}

/** Rows come back with `data` as a JSON string (or null); parse it once here so
 *  every consumer (REST detail, WS publish, the done path) gets real objects. */
function hydrateMessage(m: any): Message {
  if (typeof m?.data === "string") {
    try {
      m.data = JSON.parse(m.data);
    } catch {
      m.data = null;
    }
  } else if (m && m.data == null) {
    m.data = null;
  }
  return m as Message;
}

export interface Participant {
  member_id: string;
  role: "owner" | "member";
  joined_at: string;
  username: string;
  display_name: string;
  avatar_color: string;
  avatar_url: string | null;
}

// ── Conversations ───────────────────────────────────────────────

// A member sees every room they participate in (1:1 chats included — the owner
// is always a participant).
export interface ListConversationsOptions {
  /** page size (default 40, capped 100) */
  limit?: number;
  /** keyset cursor: only rows older than (updated_at, id) of the last seen row */
  beforeAt?: string;
  beforeId?: string;
}

// Keyset pagination on (updated_at DESC, id DESC) — stable as the list reorders
// (new messages bump updated_at), unlike offset. Bounds the per-row enrichment
// (participants + maurice participation) to a single page, which matters once a
// member has thousands of imported conversations.
export function listConversations(userId: string, opts: ListConversationsOptions = {}): Conversation[] {
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 100);
  const params: any[] = [userId];
  let cursor = "";
  if (opts.beforeAt && opts.beforeId) {
    cursor = "AND (c.updated_at < ? OR (c.updated_at = ? AND c.id < ?))";
    params.push(opts.beforeAt, opts.beforeAt, opts.beforeId);
  }
  const rows = db
    .query(
      `SELECT c.id, c.user_id, c.title, c.maurice_id, c.origin, c.created_at, c.updated_at,
              COUNT(m.id) as message_count,
              MAX(m.created_at) as last_message_at
       FROM conversations c
       JOIN conversation_participants p
         ON p.conversation_id = c.id AND p.member_id = ?
       LEFT JOIN messages m ON m.conversation_id = c.id
       WHERE 1=1 ${cursor}
       GROUP BY c.id
       ORDER BY c.updated_at DESC, c.id DESC
       LIMIT ?`
    )
    .all(...params, limit) as Conversation[];
  // Attach each room's members + the Maurices that have participated so the
  // sidebar can render one avatar cluster (humans + hatted Maurices).
  for (const c of rows) {
    c.participants = getParticipants(c.id);
    const m = mauriceParticipation(c.id);
    c.maurice_ids = m.ids;
    c.has_everyday_maurice = m.everyday;
  }
  return rows;
}

/** The distinct Maurices that have answered in a thread: specialist ids + a
 *  flag for whether the everyday (no-specialist) Maurice answered. */
export function mauriceParticipation(conversationId: string): { ids: string[]; everyday: boolean } {
  const rows = db
    .query(
      `SELECT DISTINCT maurice_id FROM messages
       WHERE conversation_id = ? AND role = 'assistant'`
    )
    .all(conversationId) as { maurice_id: string | null }[];
  const ids = rows.map((r) => r.maurice_id).filter((x): x is string => !!x);
  const everyday = rows.some((r) => r.maurice_id == null);
  return { ids, everyday };
}

// Access is participant-based: the viewer must be a participant of the room.
export function getConversation(
  id: string,
  viewerId: string
): Conversation | null {
  return db
    .query(
      `SELECT c.id, c.user_id, c.title, c.maurice_id, c.origin, c.created_at, c.updated_at
       FROM conversations c
       JOIN conversation_participants p
         ON p.conversation_id = c.id AND p.member_id = ?
       WHERE c.id = ?`
    )
    .get(viewerId, id) as Conversation | null;
}

export function createConversation(
  userId: string,
  mauriceId?: string | null,
): Conversation {
  const id = crypto.randomUUID();
  db.run(`INSERT INTO conversations (id, user_id, maurice_id) VALUES (?, ?, ?)`, [
    id,
    userId,
    mauriceId ?? null,
  ]);
  db.run(
    `INSERT OR IGNORE INTO conversation_participants (conversation_id, member_id, role)
     VALUES (?, ?, 'owner')`,
    [id, userId]
  );
  return getConversation(id, userId)!;
}

// ── Participants ────────────────────────────────────────────────

export function getParticipants(conversationId: string): Participant[] {
  return db
    .query(
      `SELECT p.member_id, p.role, p.joined_at,
              u.username, u.display_name, u.avatar_color, u.avatar_url
       FROM conversation_participants p
       JOIN users u ON u.id = p.member_id
       WHERE p.conversation_id = ?
       ORDER BY p.joined_at`
    )
    .all(conversationId) as Participant[];
}

export function isParticipant(conversationId: string, memberId: string): boolean {
  return !!db
    .query(
      `SELECT 1 FROM conversation_participants
       WHERE conversation_id = ? AND member_id = ?`
    )
    .get(conversationId, memberId);
}

/** Mark a room read for a member (no-op for solo conversations they're not in). */
export function markConversationRead(memberId: string, conversationId: string): void {
  db.run(
    `UPDATE conversation_participants SET last_read_at = datetime('now')
     WHERE conversation_id = ? AND member_id = ?`,
    [conversationId, memberId],
  );
}

/** Per-foyer unread roll-up: count rooms with a message from someone else
 *  (a human, not this member, not Maurice) newer than the member's last read. */
export function unreadRoomCount(memberId: string): number {
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM conversation_participants cp
       WHERE cp.member_id = ?
         AND EXISTS (
           SELECT 1 FROM messages m
           WHERE m.conversation_id = cp.conversation_id
             AND m.author_id IS NOT NULL AND m.author_id != ?
             AND (cp.last_read_at IS NULL OR m.created_at > cp.last_read_at)
         )`
    )
    .get(memberId, memberId) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function addParticipant(
  conversationId: string,
  memberId: string,
  role: "owner" | "member" = "member"
): void {
  db.run(
    `INSERT OR IGNORE INTO conversation_participants (conversation_id, member_id, role)
     VALUES (?, ?, ?)`,
    [conversationId, memberId, role]
  );
  db.run(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`, [
    conversationId,
  ]);
}

export function removeParticipant(conversationId: string, memberId: string): void {
  db.run(
    `DELETE FROM conversation_participants WHERE conversation_id = ? AND member_id = ?`,
    [conversationId, memberId]
  );
}

// How many humans are in the room — drives summoning (1:1 vs room).
export function countParticipants(conversationId: string): number {
  const row = db
    .query(
      `SELECT COUNT(*) as n FROM conversation_participants WHERE conversation_id = ?`
    )
    .get(conversationId) as { n: number };
  return row.n;
}

export function renameConversation(
  id: string,
  userId: string,
  title: string
): Conversation | null {
  db.run(
    `UPDATE conversations SET title = ?, updated_at = datetime('now')
     WHERE id = ? AND user_id = ?`,
    [title, id, userId]
  );
  return getConversation(id, userId);
}

/** Per-conversation tool-family override. `null` clears it (inherit). */
export function setConversationToolFamilies(
  id: string,
  userId: string,
  families: string[] | null,
): boolean {
  const res = db.run(
    `UPDATE conversations SET tool_families = ?, updated_at = datetime('now')
     WHERE id = ? AND user_id = ?`,
    [families === null ? null : JSON.stringify(families), id, userId],
  );
  return res.changes > 0;
}

/** The conversation's explicit override (null = inheriting). */
export function conversationToolFamiliesOverride(id: string): string[] | null {
  const row = db
    .query(`SELECT tool_families FROM conversations WHERE id = ?`)
    .get(id) as { tool_families: string | null } | null;
  if (row?.tool_families == null) return null;
  try {
    const v = JSON.parse(row.tool_families);
    return Array.isArray(v) ? v.map(String) : null;
  } catch {
    return null;
  }
}

export function deleteConversation(id: string, userId: string): boolean {
  const result = db.run(
    `DELETE FROM conversations WHERE id = ? AND user_id = ?`,
    [id, userId]
  );
  return result.changes > 0;
}

// ── Messages ────────────────────────────────────────────────────

export function getMessages(conversationId: string): Message[] {
  return (
    db
      .query(
        `SELECT id, conversation_id, role, content, model, author_id, maurice_id, data, created_at
         FROM messages WHERE conversation_id = ?
         ORDER BY created_at`
      )
      .all(conversationId) as any[]
  ).map(hydrateMessage);
}

/** Set a thread's current/armed Maurice (null = everyday). Participant-guarded. */
export function setConversationMaurice(
  conversationId: string,
  viewerId: string,
  mauriceId: string | null
): boolean {
  if (!isParticipant(conversationId, viewerId)) return false;
  const r = db.run(`UPDATE conversations SET maurice_id = ? WHERE id = ?`, [mauriceId, conversationId]);
  return r.changes > 0;
}

export function addMessage(
  conversationId: string,
  role: "user" | "assistant" | "system",
  content: string,
  opts: {
    authorId?: string | null;
    model?: string;
    mauriceId?: string | null;
    /** structured tool results for this turn, [{ tool, data }]; persisted as JSON */
    data?: { tool: string; data: unknown }[] | null;
  } = {}
): Message {
  const id = crypto.randomUUID();
  const dataJson = opts.data && opts.data.length ? JSON.stringify(opts.data) : null;
  db.run(
    `INSERT INTO messages (id, conversation_id, role, content, model, author_id, maurice_id, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, conversationId, role, content, opts.model ?? null, opts.authorId ?? null, opts.mauriceId ?? null, dataJson]
  );

  // Touch conversation updated_at
  db.run(
    `UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`,
    [conversationId]
  );

  return hydrateMessage(
    db.query(`SELECT * FROM messages WHERE id = ?`).get(id)
  );
}

/**
 * Delete the most recent assistant message in a conversation.
 * Used by regenerate, which then re-streams a fresh answer from the same
 * history (which now ends at the last user message). Returns false if there
 * is no assistant message to drop.
 */
export function deleteLastAssistantMessage(conversationId: string): boolean {
  const row = db
    .query(
      `SELECT id FROM messages
       WHERE conversation_id = ? AND role = 'assistant'
       ORDER BY rowid DESC LIMIT 1`
    )
    .get(conversationId) as { id: string } | undefined;
  if (!row) return false;
  db.run(`DELETE FROM messages WHERE id = ?`, [row.id]);
  return true;
}

// Auto-generate title from first user message if title is null
export function autoTitle(conversationId: string): void {
  const convo = db
    .query(`SELECT title FROM conversations WHERE id = ?`)
    .get(conversationId) as any;

  if (convo?.title) return; // already titled

  const firstMsg = db
    .query(
      `SELECT content FROM messages
       WHERE conversation_id = ? AND role = 'user'
       ORDER BY created_at LIMIT 1`
    )
    .get(conversationId) as any;

  if (firstMsg) {
    const stripped = firstMsg.content
      .replace(/!\[.*?\]\(\/api\/images\/.+?\)\s*/g, "")
      .trim();
    const title = (stripped || "Photo").slice(0, 80).replace(/\n/g, " ");
    db.run(`UPDATE conversations SET title = ? WHERE id = ?`, [
      title,
      conversationId,
    ]);
  }
}
