import db from "../db";
import { addMessage } from "./conversations";
import { memberLocale } from "./domainBriefs";
import { mailOpenerStrings } from "./mailOpener";
import { mailToolCall, type MemberMailState } from "./mailScan";
import type { McpTool } from "./mcpClient";
import { OPENED_BY_MAURICE } from "./openedConversations";
import { publishToRoom } from "./roomBus";

// The member's yes to Maurice reading their mail — lot 3 of
// specs/mail-import.md, settled with Candide on 26 September 2026.
//
// The night opens one conversation per member with the numbers of their
// mailbox and the question "shall I read them?" (services/mailScan.ts,
// services/mailOpener.ts). The answer is taken here, on the model of the
// domain proposals (services/domainProposals.ts): one native tool,
// `mail__approve_reading`, which exists in exactly that conversation and
// nowhere else — granted by the conversation, not by a tool family — and
// which the model calls only on the member's explicit word. The same act
// has a second door, the card in the app's Settings → Mail, on
// routes/mailAccounts.ts; both run `decideReading` below.
//
// What the yes is: a CONSENT to read the bodies, not a purchase. No money
// anywhere near it — not in the tool, not in the prompt, not in the reply.
// No ceiling per job: the household's daily cap is the only one, and it is
// the operator's business. What the yes does: nothing that costs. It leaves
// a `reading` job `approved` in the member's own store (the `email` tool's
// file; the server never creates a job of its own), for the night of lot 4
// to run. A no is kept as `declined` and never asked about again; the member
// can come back on it, from the card or here.
//
// `mail_conversations` (db.ts) is the link a turn needs: which conversation
// is the mail one, whose it is, and — mirrored from the tool's answer, by the
// server alone — where the reading stands, so the prompt says it without a
// gateway call at every turn.

export type ReadingState = "pending" | "approved" | "declined";

export interface MailConversation {
  member_id: string;
  conversation_id: string;
  opened_at: string;
  reading: ReadingState;
  decided_at: string | null;
}

// ── The link ─────────────────────────────────────────────────────────────

/** Tie the conversation the night opened to its member. Idempotent: a
 *  member has one, and a second opening (there is none by design) would
 *  keep the first. */
export function linkMailConversation(memberId: string, conversationId: string, openedAt?: string): void {
  db.run(
    `INSERT INTO mail_conversations (member_id, conversation_id, opened_at) VALUES (?, ?, COALESCE(?, datetime('now')))
     ON CONFLICT (member_id) DO NOTHING`,
    [memberId, conversationId, openedAt ?? null],
  );
}

/** The conversations opened before this table existed, from the night's
 *  own record (mail-nightly.json). Called once at boot; nothing to do when
 *  every row is already there. Returns how many were added. */
export function backfillMailConversations(members: Record<string, MemberMailState> | undefined): number {
  let added = 0;
  for (const [memberId, ms] of Object.entries(members ?? {})) {
    if (!ms?.conversation_id) continue;
    const before = mailConversationOf(memberId);
    linkMailConversation(memberId, ms.conversation_id, ms.announced_at ? ms.announced_at.replace("T", " ").slice(0, 19) : undefined);
    if (!before && mailConversationOf(memberId)) added++;
  }
  return added;
}

export function mailConversationOf(memberId: string): MailConversation | null {
  return (db.query(`SELECT * FROM mail_conversations WHERE member_id = ?`).get(memberId) as MailConversation | null) ?? null;
}

/** The member whose mail conversation this is — one Maurice opened, that
 *  the night recorded — else null. This is the whole grant: the tool exists
 *  here and nowhere else, whatever the reading's state (a member who said
 *  no may still say yes here later; Maurice just does not ask). */
export function mailConversationMemberOf(conversationId: string): string | null {
  const row = db
    .query(
      `SELECT mc.member_id FROM mail_conversations mc JOIN conversations c ON c.id = mc.conversation_id
       WHERE mc.conversation_id = ? AND c.user_id = mc.member_id AND c.opened_by = ?`,
    )
    .get(conversationId, OPENED_BY_MAURICE) as { member_id: string } | null;
  return row?.member_id ?? null;
}

function mirror(memberId: string, reading: ReadingState): void {
  db.run(`UPDATE mail_conversations SET reading = ?, decided_at = datetime('now') WHERE member_id = ?`, [reading, memberId]);
}

// ── The act ──────────────────────────────────────────────────────────────

export type ReadingAction = "approve" | "decline";

export interface Decision {
  reading: ReadingState;
  /** True when the word was already the tool's: nothing changed. */
  already: boolean;
  /** The tool's job id, for the record (lot 4 will spend under it). */
  job_id: string | null;
  decided_at: string | null;
}

const isAction = (v: unknown): v is ReadingAction => v === "approve" || v === "decline";

/** Record the member's word in their store, through the `email` tool as the
 *  member, and mirror it here. Throws when the tool cannot be reached or
 *  refuses (no mail account, a reading already running): the caller says
 *  so in its own way. Nothing is read, nothing is spent. */
export async function decideReading(memberId: string, action: ReadingAction, opts: { years?: number } = {}): Promise<Decision> {
  const tool = action === "approve" ? "approve_reading" : "decline_reading";
  const args = action === "approve" && opts.years ? { years: opts.years } : {};
  const r = await mailToolCall(memberId, tool, args);
  if (r?.error || r?.raw) throw new Error(String(r.error ?? r.raw));
  const state = r?.job?.state;
  if (state !== "approved" && state !== "declined") {
    // A reading under way (lot 4): the word is not taken over a run.
    throw new Error(r?.note ? String(r.note) : `the reading job is ${state ?? "unknown"}`);
  }
  mirror(memberId, state);
  return { reading: state, already: !!r.already, job_id: r?.job?.id ?? null, decided_at: r?.job?.updated_at ?? null };
}

/** What Maurice says in the conversation when the word came from the app,
 *  rendered in the member's language, no model. */
export function readingReply(action: ReadingAction, locale: string): string {
  const t = mailOpenerStrings(locale);
  return action === "approve" ? t.approved : t.declined;
}

/** Say it in the mail conversation, in Maurice's voice, fanned out to the
 *  member's open screens. Returns the message id, or null when the member
 *  has no mail conversation (the word still stands). */
export function sayReadingDecided(memberId: string, action: ReadingAction): string | null {
  const mc = mailConversationOf(memberId);
  if (!mc) return null;
  const msg = addMessage(mc.conversation_id, "assistant", readingReply(action, memberLocale(memberId)), { mauriceId: null });
  publishToRoom(mc.conversation_id, { type: "message", message: msg });
  return msg.id;
}

// ── The tool ─────────────────────────────────────────────────────────────

export const MAIL_TOOL_NAME = "mail__approve_reading";

export function isMailTool(name: string): boolean {
  return name === MAIL_TOOL_NAME;
}

const TOOL: McpTool = {
  name: MAIL_TOOL_NAME,
  description:
    "Record the member's answer to your question about reading their mail — only in this conversation, and only on an explicit yes or no to that question. `approve`: they agree that you read the real exchanges of their mailbox; the reading happens at night, starting the next one, and you will come back with what you understood. `decline`: they do not want it; it is kept, and you never ask again (they can change their mind later, here or in the app's Settings → Mail).",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["approve", "decline"] },
    },
    required: ["action"],
  },
};

/** The tool for a turn: the one, when the conversation is the mail one of
 *  the member taking the turn; nothing otherwise. */
export function mailToolsFor(conversationId: string, memberId: string | undefined): McpTool[] {
  if (!memberId) return [];
  const owner = mailConversationMemberOf(conversationId);
  return owner && owner === memberId ? [TOOL] : [];
}

export interface ToolOutcome {
  text: string;
  isError: boolean;
  data?: unknown;
}

const ok = (data: unknown): ToolOutcome => ({ text: JSON.stringify(data, null, 1), isError: false, data });
const fail = (message: string): ToolOutcome => ({ text: `Tool error: ${message}`, isError: true });

/** Run the tool inside a conversation. The grant is checked again here, on
 *  the conversation itself, in case a roster was cached. */
export async function runMailTool(input: any, conversationId: string): Promise<ToolOutcome> {
  const memberId = mailConversationMemberOf(conversationId);
  if (!memberId) return fail("this tool exists only in the conversation that asked about reading the member's mail");
  const action = input?.action;
  if (!isAction(action)) return fail("action must be approve or decline");
  try {
    const d = await decideReading(memberId, action);
    return ok(
      action === "approve"
        ? {
            reading: d.reading,
            already: d.already,
            say: "the reading starts the next night and may take a few nights; you will come back in this conversation with what you understood — who matters to them and what is going on. Nothing is read now.",
          }
        : {
            reading: d.reading,
            already: d.already,
            say: "it is kept: you will not ask again. They can change their mind later, here or in the app under Settings → Mail.",
          },
    );
  } catch (err) {
    return fail((err as Error).message);
  }
}

// ── The prompt section ───────────────────────────────────────────────────

/** What Maurice is told in the mail conversation: what he asked, where the
 *  answer stands, the rule (an explicit yes only), and the tool. Empty
 *  everywhere else. */
export function mailPromptSection(conversationId: string, memberId: string | undefined, memberName: string): string {
  if (!memberId || mailConversationMemberOf(conversationId) !== memberId) return "";
  const mc = mailConversationOf(memberId);
  const standing =
    mc?.reading === "approved"
      ? `${memberName} has already said yes: the reading is approved and happens at night. Do not ask again; if they ask, say it is on its way and that you will come back with what you understood. If they now say no, call the tool with \`action: "decline"\`.`
      : mc?.reading === "declined"
        ? `${memberName} has said no. Never ask again, never hint at it. Only if they themselves say, unprompted and explicitly, that they now want you to read, call the tool with \`action: "approve"\`.`
        : `The question is open. Wait for ${memberName}'s word: on an explicit yes to reading their mail, call the tool with \`action: "approve"\`; on an explicit no, with \`action: "decline"\`. Never on a hint, an "ok" to something else, a question, or your own judgement — if unsure, ask again plainly.`;
  return (
    `\n\n## Reading ${memberName}'s mail\n` +
    `You opened this conversation yourself, at night, with the numbers of ${memberName}'s mailbox and one question: may you read the real exchanges of the last years, to tell them who matters to them and what is going on. ` +
    `It is a consent to read, nothing else: never speak of what it costs, of a budget, or of limits — there is nothing of the kind to say. ` +
    `Nothing happens before their yes, and the yes itself reads nothing now: the reading happens at night, starting the next one, over a few nights, and you come back here with what you understood.\n` +
    `One tool, here only: \`mail__approve_reading\` (\`action: "approve"\` or \`"decline"\`). ${standing}\n` +
    `${memberName} can also answer without you, from the card under Settings → Mail in the app; what they did there appears in this conversation as a message of yours.`
  );
}
