import db from "../db";
import { freshInviteCode, normalizeInviteCode } from "./auth";
import { createUser } from "./users";
import { seedDefaultAccess } from "./modelAccess";

// ── Open invitations ─────────────────────────────────────────────
// An admin invites *someone*: no member exists until the code is redeemed, and
// the person who redeems it names themselves. Single use, seven days. The
// member-bound codes in auth.ts stay for the other case — a new device for
// someone who is already here.

export interface OpenInvite {
  code: string;
  expires_at: string;
  created_at: string;
}

export function createOpenInvite(createdBy: string, days = 7): OpenInvite {
  const code = freshInviteCode();
  const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
  db.run(`INSERT INTO household_invites (code, created_by, expires_at) VALUES (?, ?, ?)`, [
    code,
    createdBy,
    expiresAt,
  ]);
  return db
    .query(`SELECT code, expires_at, created_at FROM household_invites WHERE code = ?`)
    .get(code) as OpenInvite;
}

/** Invitations still waiting for someone: unused and unexpired, newest first. */
export function listOpenInvites(): OpenInvite[] {
  return db
    .query(
      `SELECT code, expires_at, created_at FROM household_invites
       WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC`,
    )
    .all(new Date().toISOString()) as OpenInvite[];
}

/** Withdraw an invitation nobody has used yet. */
export function revokeOpenInvite(raw: string): boolean {
  const res = db.run(`DELETE FROM household_invites WHERE code = ? AND used_at IS NULL`, [
    normalizeInviteCode(raw),
  ]);
  return res.changes > 0;
}

/** Whether a code is an open invitation that can still be used. */
export function isOpenInvite(raw: string): boolean {
  return !!db
    .query(`SELECT 1 FROM household_invites WHERE code = ? AND used_at IS NULL AND expires_at > ?`)
    .get(normalizeInviteCode(raw), new Date().toISOString());
}

/**
 * A handle for the newcomer, from the name they gave: lowercase ASCII, accents
 * folded ("Aline" → "aline", "Zoé" → "zoe"), numbered when taken. The username
 * names the member's garden directory, so it has to be plain.
 */
export function usernameFor(displayName: string): string {
  const base =
    displayName
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 20) || "membre";
  const taken = (u: string) => db.query(`SELECT 1 FROM users WHERE username = ?`).get(u);
  if (!taken(base)) return base;
  let n = 2;
  while (taken(`${base}${n}`)) n++;
  return `${base}${n}`;
}

/**
 * Redeem an open invitation: the newcomer becomes a member under the name they
 * chose. The code is claimed before the member is created, in one statement,
 * so two phones scanning the same QR code at once cannot both come in.
 */
export async function redeemOpenInvite(
  raw: string,
  profile: { display_name: string; avatar_color?: string },
): Promise<{ userId: string } | null> {
  const code = normalizeInviteCode(raw);
  const now = new Date().toISOString();
  const claimed = db.run(
    `UPDATE household_invites SET used_at = ? WHERE code = ? AND used_at IS NULL AND expires_at > ?`,
    [now, code, now],
  );
  if (claimed.changes === 0) return null;
  try {
    const user = await createUser({
      username: usernameFor(profile.display_name),
      display_name: profile.display_name,
      role: "standard",
      avatar_color: profile.avatar_color,
    });
    seedDefaultAccess(user.id);
    db.run(`UPDATE household_invites SET used_by = ? WHERE code = ?`, [user.id, code]);
    return { userId: user.id };
  } catch (err) {
    // Hand the invitation back: nobody came in by it.
    db.run(`UPDATE household_invites SET used_at = NULL WHERE code = ?`, [code]);
    throw err;
  }
}
