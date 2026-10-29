import db from "../db";
import { countParticipants, isParticipant } from "./conversations";

// ── Reports (operator moderation queue for member↔member room content) ──
//
// Reports of member content exist ONLY for shared rooms (>1 participant). A
// private 1:1 can never be reported that way, so the operator review path never
// exposes a member's private conversation — the per-member isolation invariant
// holds. A reply of Maurice's can be reported anywhere (App Review 1.2, AI
// content): the report keeps a copy of that reply and of the question before
// it, which the member is told will be shared, and the operator reads the copy
// only (`ai_reply_reports`, below).

export type ReportReason =
  | "spam"
  | "harassment_or_bullying"
  | "sexual_content"
  | "child_safety"
  | "other";

const REASONS: ReportReason[] = [
  "spam",
  "harassment_or_bullying",
  "sexual_content",
  "child_safety",
  "other",
];

export function isReason(x: unknown): x is ReportReason {
  return typeof x === "string" && (REASONS as string[]).includes(x);
}

export interface Report {
  id: string;
  reporter_member_id: string;
  room_id: string;
  target_type: "message" | "member" | "ai_reply";
  target_id: string;
  reason: ReportReason;
  note: string | null;
  status: "open" | "actioned" | "dismissed";
  created_at: string;
}

/** A room is reportable only if it's shared (more than one participant). */
export function isReportableRoom(roomId: string): boolean {
  return countParticipants(roomId) > 1;
}

function getReportRow(id: string): Report | null {
  return (db.query(`SELECT * FROM reports WHERE id = ?`).get(id) as Report) ?? null;
}

// ── Reports of Maurice's replies ────────────────────────────────

/** Reasons a reply of Maurice's can be reported for: the room reasons, and
 *  an answer that is wrong or misleading in a way that can hurt. */
export function isAiReplyReason(x: unknown): x is ReportReason | "harmful_or_misleading" {
  return isReason(x) || x === "harmful_or_misleading";
}

const REPLY_CHARS = 6000;
const QUESTION_CHARS = 2000;

interface AiReplyRow {
  id: string;
  reporter_member_id: string;
  conversation_id: string;
  message_id: string;
  reason: string;
  note: string | null;
  reply_text: string;
  question_text: string | null;
  status: "open" | "actioned" | "dismissed";
  created_at: string;
}

function getAiReplyRow(id: string): AiReplyRow | null {
  return (db.query(`SELECT * FROM ai_reply_reports WHERE id = ?`).get(id) as AiReplyRow) ?? null;
}

/** As the operator's queue shows it: the shape of a room report, with the
 *  copy in place of the message. */
function aiReplyAsReport(r: AiReplyRow): Report {
  return {
    id: r.id,
    reporter_member_id: r.reporter_member_id,
    room_id: r.conversation_id,
    target_type: "ai_reply",
    target_id: r.message_id,
    reason: r.reason as ReportReason,
    note: r.note,
    status: r.status,
    created_at: r.created_at,
  };
}

/**
 * A member reports a reply of Maurice's in a conversation they are in. The
 * caller has checked their access. Null when the message is not one of
 * Maurice's replies in that conversation.
 */
export function createAiReplyReport(args: {
  reporterId: string;
  conversationId: string;
  messageId: string;
  reason: string;
  note?: string | null;
}): Report | null {
  const reply = db
    .query(`SELECT id, content, created_at FROM messages WHERE id = ? AND conversation_id = ? AND role = 'assistant'`)
    .get(args.messageId, args.conversationId) as { id: string; content: string; created_at: string } | null;
  if (!reply) return null;
  // The question it answered: the last member message before it.
  const question = db
    .query(
      `SELECT content FROM messages WHERE conversation_id = ? AND role = 'user'
         AND (created_at < ? OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(args.conversationId, reply.created_at, reply.created_at, reply.id) as { content: string } | null;
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO ai_reply_reports (id, reporter_member_id, conversation_id, message_id, reason, note, reply_text, question_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, args.reporterId, args.conversationId, args.messageId, args.reason, args.note ?? null,
      reply.content.slice(0, REPLY_CHARS), question?.content.slice(0, QUESTION_CHARS) ?? null,
    ],
  );
  return aiReplyAsReport(getAiReplyRow(id)!);
}

export function createReport(args: {
  reporterId: string;
  roomId: string;
  targetType: "message" | "member";
  targetId: string;
  reason: ReportReason;
  note?: string | null;
}): Report | null {
  // Reporter must be in the room, and it must be a shared room (never 1:1).
  if (!isParticipant(args.roomId, args.reporterId)) return null;
  if (!isReportableRoom(args.roomId)) return null;
  // A reported message must belong to this room.
  if (args.targetType === "message") {
    const m = db
      .query(`SELECT 1 FROM messages WHERE id = ? AND conversation_id = ?`)
      .get(args.targetId, args.roomId);
    if (!m) return null;
  }
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO reports (id, reporter_member_id, room_id, target_type, target_id, reason, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, args.reporterId, args.roomId, args.targetType, args.targetId, args.reason, args.note ?? null],
  );
  return getReportRow(id);
}

export interface ReportView extends Report {
  reporter_display_name: string | null;
  room_title: string | null;
  // The reported content — exposed to the operator only. Always shared-room
  // content (reports never exist for private 1:1).
  reported_message?: {
    id: string;
    content: string;
    author_id: string | null;
    created_at: string;
  } | null;
  reported_member?: { id: string; display_name: string; username: string } | null;
  /** For a reply of Maurice's: the question it answered, as copied. */
  reported_question?: string | null;
}

function hydrateReportView(r: any): ReportView {
  const view: ReportView = { ...r };
  if (r.target_type === "message") {
    view.reported_message =
      (db
        .query(
          `SELECT id, content, author_id, created_at FROM messages
           WHERE id = ? AND conversation_id = ?`,
        )
        .get(r.target_id, r.room_id) as any) ?? null;
  } else {
    view.reported_member =
      (db
        .query(`SELECT id, display_name, username FROM users WHERE id = ?`)
        .get(r.target_id) as any) ?? null;
  }
  return view;
}

/**
 * Operator-only. child_safety reports surface first, then newest. Returns the
 * reported room content + report metadata only — never a private conversation.
 */
export function listReports(status = "open"): ReportView[] {
  const replies = (db
    .query(
      `SELECT r.*, u.display_name AS reporter_display_name
       FROM ai_reply_reports r LEFT JOIN users u ON u.id = r.reporter_member_id
       WHERE r.status = ?`,
    )
    .all(status) as Array<AiReplyRow & { reporter_display_name: string | null }>)
    .map((r): ReportView => ({
      ...aiReplyAsReport(r),
      reporter_display_name: r.reporter_display_name,
      // A private conversation's title is not the operator's to read.
      room_title: null,
      reported_message: { id: r.message_id, content: r.reply_text, author_id: null, created_at: r.created_at },
      reported_question: r.question_text,
    }));
  const rooms = listRoomReports(status);
  return [...rooms, ...replies].sort(
    (a, b) => Number(b.reason === "child_safety") - Number(a.reason === "child_safety")
      || b.created_at.localeCompare(a.created_at),
  );
}

function listRoomReports(status: string): ReportView[] {
  const rows = db
    .query(
      `SELECT r.*, u.display_name AS reporter_display_name, c.title AS room_title
       FROM reports r
       LEFT JOIN users u ON u.id = r.reporter_member_id
       LEFT JOIN conversations c ON c.id = r.room_id
       WHERE r.status = ?
       ORDER BY (r.reason = 'child_safety') DESC, r.created_at DESC`,
    )
    .all(status) as any[];
  return rows.map(hydrateReportView);
}

/**
 * Operator action: optionally remove the reported message and/or eject the
 * offending member from the room. Ejection removes room membership only — it
 * never touches the member's isolated private data.
 */
export function actionReport(
  id: string,
  opts: { removeMessage?: boolean; ejectMember?: boolean },
): Report | null {
  const r = getReportRow(id);
  if (!r) {
    // A reply of Maurice's: the operator marks it handled. Nothing is removed
    // from the member's conversation, which is not the operator's.
    if (!getAiReplyRow(id)) return null;
    db.run(`UPDATE ai_reply_reports SET status = 'actioned' WHERE id = ?`, [id]);
    return aiReplyAsReport(getAiReplyRow(id)!);
  }
  if (opts.removeMessage && r.target_type === "message") {
    db.run(`DELETE FROM messages WHERE id = ? AND conversation_id = ?`, [r.target_id, r.room_id]);
  }
  if (opts.ejectMember) {
    const memberId =
      r.target_type === "member"
        ? r.target_id
        : ((db.query(`SELECT author_id FROM messages WHERE id = ?`).get(r.target_id) as any)
            ?.author_id ?? null);
    if (memberId) {
      db.run(
        `DELETE FROM conversation_participants WHERE conversation_id = ? AND member_id = ?`,
        [r.room_id, memberId],
      );
    }
  }
  db.run(`UPDATE reports SET status = 'actioned' WHERE id = ?`, [id]);
  return getReportRow(id);
}

export function dismissReport(id: string): Report | null {
  const r = getReportRow(id);
  if (!r) {
    if (!getAiReplyRow(id)) return null;
    db.run(`UPDATE ai_reply_reports SET status = 'dismissed' WHERE id = ?`, [id]);
    return aiReplyAsReport(getAiReplyRow(id)!);
  }
  db.run(`UPDATE reports SET status = 'dismissed' WHERE id = ?`, [id]);
  return getReportRow(id);
}

// ── Blocks (per-member, isolation-respecting) ───────────────────

export function blockMember(memberId: string, blockedId: string): void {
  if (memberId === blockedId) return;
  db.run(
    `INSERT OR IGNORE INTO blocks (id, member_id, blocked_member_id) VALUES (?, ?, ?)`,
    [crypto.randomUUID(), memberId, blockedId],
  );
}

export function unblockMember(memberId: string, blockedId: string): void {
  db.run(`DELETE FROM blocks WHERE member_id = ? AND blocked_member_id = ?`, [memberId, blockedId]);
}

/** Ids this member has blocked — their messages are hidden from this member. */
export function blockedIdsFor(memberId: string): Set<string> {
  const rows = db
    .query(`SELECT blocked_member_id FROM blocks WHERE member_id = ?`)
    .all(memberId) as { blocked_member_id: string }[];
  return new Set(rows.map((r) => r.blocked_member_id));
}

/** True if `blocker` has blocked `blocked`. */
export function hasBlocked(blocker: string, blocked: string): boolean {
  return !!db
    .query(`SELECT 1 FROM blocks WHERE member_id = ? AND blocked_member_id = ?`)
    .get(blocker, blocked);
}
