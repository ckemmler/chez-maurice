import db from "../db";

// Senders set aside from the reading of a member's mail (28 September 2026).
//
// A mailbox can be mostly one machine talking: on the owner's contactoffice
// box, 31 663 of 37 335 messages came from a support desk and 934 from a
// tracker, and they made most of an 18 € estimate for a box where he writes
// little. A rule says how much of a sender is worth reading: none of it
// (`days: 0`), or only its last days — a week of support tickets, three
// weeks of tracker notifications. The triage applies it (tools/email/triage.py,
// `sender_rule`): what falls outside is sorted as bulk, so neither pass reads
// it; the window slides every night, as the triage runs again. Nothing is
// deleted, nothing is changed in the mailbox, and a rule taken back reads
// the sender again.

export interface SenderRule {
  address: string;
  /** Days of this sender's mail still read; 0: none. */
  days: number;
}

export function normaliseAddress(raw: string): string | null {
  const m = String(raw ?? "").trim().toLowerCase().match(/<([^>]+)>\s*$/);
  const a = (m ? m[1]! : String(raw ?? "")).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a) ? a : null;
}

export function listSenderRules(memberId: string): SenderRule[] {
  return db.query(`SELECT address, days FROM mail_sender_rules WHERE member_id = ? ORDER BY address`).all(memberId) as SenderRule[];
}

/** The rules as the triage takes them: address → days. */
export function senderRulesForTriage(memberId: string): Record<string, number> {
  return Object.fromEntries(listSenderRules(memberId).map((r) => [r.address, r.days]));
}

/** Set a sender's rule, or take it back with `days: null`. */
export function setSenderRule(memberId: string, rawAddress: string, days: number | null): SenderRule | null {
  const address = normaliseAddress(rawAddress);
  if (!address) throw new Error("not an email address");
  if (days === null) {
    db.run(`DELETE FROM mail_sender_rules WHERE member_id = ? AND address = ?`, [memberId, address]);
    return null;
  }
  if (!Number.isInteger(days) || days < 0 || days > 36500) throw new Error("days must be a whole number from 0 to 36500");
  db.run(
    `INSERT INTO mail_sender_rules (member_id, address, days) VALUES (?, ?, ?)
     ON CONFLICT (member_id, address) DO UPDATE SET days = excluded.days, updated_at = datetime('now')`,
    [memberId, address, days],
  );
  return { address, days };
}
