import db from "../db";
import { approvedMailboxAddresses, approveMailboxes } from "./mailAccounts";
import { mailToolCall } from "./mailScan";

// The member's yes to Maurice reading their mail — lot 3 of
// specs/mail-import.md, settled with Candide on 26 September 2026.
//
// The word is given on the card under Settings → Mail in the app
// (routes/mailAccounts.ts), which shows what the mailbox holds and what a
// reading would take. Until 10 October 2026 the night also opened a
// conversation per member with those numbers and the question, and a native
// tool, `mail__approve_reading`, took the answer there; Maurice no longer
// opens that conversation, and the tool went with it — a consent is better
// given on a card that says what it is a consent to than read out of a
// sentence by a model. A member who already had the conversation keeps it
// as an ordinary one, and their word with it: `mail_reading_consent` was
// filled from those rows when it was created (db.ts).
//
// What the yes is: a CONSENT to read the bodies, not a purchase. No money
// anywhere near it. No ceiling per job: the household's daily cap is the
// only one, and it is the operator's business. What the yes does: nothing
// that costs. It leaves a `reading` job `approved` in the member's own store
// (the `email` tool's file; the server never creates a job of its own), for
// the night of lot 4 to run. A no is kept as `declined`; the member can
// come back on it, from the card.
//
// `mail_reading_consent` is the server's mirror of that word, so that the
// night knows who to read for without a gateway call per member.

export type ReadingState = "pending" | "approved" | "declined";

/** Where the member's word stands: `pending` until they gave one. */
export function readingState(memberId: string): ReadingState {
  const row = db.query(`SELECT reading FROM mail_reading_consent WHERE member_id = ?`).get(memberId) as { reading: ReadingState } | null;
  return row?.reading ?? "pending";
}

function recordReading(memberId: string, reading: "approved" | "declined"): void {
  db.run(
    `INSERT INTO mail_reading_consent (member_id, reading) VALUES (?, ?)
     ON CONFLICT (member_id) DO UPDATE SET reading = excluded.reading, decided_at = datetime('now')`,
    [memberId, reading],
  );
}

/** Whether the member wants their mail read: their yes, or — for a yes given
 *  to one mailbox before any other word — the mailboxes it approved. */
export function readingApproved(memberId: string): boolean {
  const state = readingState(memberId);
  return state === "pending" ? approvedMailboxAddresses(memberId).length > 0 : state === "approved";
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
 *  so in its own way. Nothing is read, nothing is spent, nothing is said. */
export async function decideReading(memberId: string, action: ReadingAction, opts: { years?: number; mailbox?: string } = {}): Promise<Decision> {
  const tool = action === "approve" ? "approve_reading" : "decline_reading";
  const args = action === "approve" && opts.years ? { years: opts.years } : {};
  const r = await mailToolCall(memberId, tool, args);
  if (r?.error || r?.raw) throw new Error(String(r.error ?? r.raw));
  const state = r?.job?.state;
  if (state !== "approved" && state !== "declined") {
    // A reading under way (lot 4): the word is not taken over a run.
    throw new Error(r?.note ? String(r.note) : `the reading job is ${state ?? "unknown"}`);
  }
  recordReading(memberId, state);
  // The yes covers the mailboxes there are — or the one it was given for;
  // a mailbox added later waits for its own.
  if (state === "approved") approveMailboxes(memberId, opts.mailbox ?? null);
  return { reading: state, already: !!r.already, job_id: r?.job?.id ?? null, decided_at: r?.job?.updated_at ?? null };
}

/** At or past this many years the window is the member's whole mail (the
 *  tool's ALL_YEARS). */
export const READING_ALL_YEARS = 50;

export interface WindowChange {
  years: number;
  previous: number;
  changed: boolean;
  job_id: string | null;
}

/** Take the reading further back than the years the yes covered (5 October
 *  2026) — only ever wider. Nothing is read again: the tool keeps a verdict
 *  and a reading per message, so the wider window adds its own messages and
 *  no others. Throws when the tool refuses (no yes) or cannot be reached. */
export async function widenReading(memberId: string, years: number): Promise<WindowChange> {
  const wanted = Math.max(1, Math.min(Math.floor(years), READING_ALL_YEARS));
  const r = await mailToolCall(memberId, "reading_window", { years: wanted });
  if (r?.error || r?.raw) throw new Error(String(r.error ?? r.raw));
  return { years: Number(r.years), previous: Number(r.previous), changed: !!r.changed, job_id: r?.job?.id ?? null };
}

export interface DepthChange {
  depth: "overview" | "all";
  previous: "overview" | "all";
  changed: boolean;
  job_id: string | null;
}

/** From the overview — the people who count and the last months, what a
 *  first yes reads since 6 October 2026 — to every message of the window.
 *  Never back; what the overview read is not read again. Throws when the
 *  tool refuses (no yes) or cannot be reached. */
export async function deepenReading(memberId: string): Promise<DepthChange> {
  const r = await mailToolCall(memberId, "reading_depth", { depth: "all" });
  if (r?.error || r?.raw) throw new Error(String(r.error ?? r.raw));
  return { depth: r.depth, previous: r.previous, changed: !!r.changed, job_id: r?.job?.id ?? null };
}
