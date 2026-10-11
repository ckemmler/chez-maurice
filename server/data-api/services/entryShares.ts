/**
 * A media entry shared with other members of the household.
 *
 * The fiche stays what it was: one file, in the garden of the member who
 * opened it. Sharing it does not copy it. The members it is shared with read
 * it where it lives and add their notes to it, each signed (`@username`, see
 * gardenNote.ts); a note that names nobody is the owner's.
 *
 * What is shared is the written side: the prose, the notes, the résonances,
 * what Maurice filed. What each member does while reading stays theirs — the
 * highlights and the reading position are per member and are not shown to the
 * others. Nor does a share open the conversations a note came from: those have
 * their own participants.
 *
 * The owner adds and removes; a member may only take themselves off.
 */

import db from "../../src/db";
import { guestCanReach } from "../../src/services/users";
import { hasBlocked } from "../../src/services/safety";

export interface MemberBrief {
  id: string;
  username: string;
  display_name: string;
  avatar_color: string;
  avatar_url: string | null;
}

export interface SharedRef {
  owner_id: string;
  collection: string;
  locale: string;
  slug: string;
}

export class EntryShareError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404) {
    super(message);
  }
}

const BRIEF = `id, username, display_name, avatar_color, avatar_url`;

export function memberBrief(id: string): MemberBrief | null {
  return db.query(`SELECT ${BRIEF} FROM users WHERE id = ?`).get(id) as MemberBrief | null;
}

export function memberBriefByUsername(username: string): MemberBrief | null {
  return db.query(`SELECT ${BRIEF} FROM users WHERE username = ?`).get(username) as MemberBrief | null;
}

/** The members an entry is shared with, in the order they were added. The owner is not one. */
export function participantsOf(ownerId: string, ref: Omit<SharedRef, "owner_id">): MemberBrief[] {
  return db
    .query(
      `SELECT u.id, u.username, u.display_name, u.avatar_color, u.avatar_url
         FROM entry_shares s JOIN users u ON u.id = s.member_id
        WHERE s.owner_id = ? AND s.collection = ? AND s.locale = ? AND s.slug = ?
        ORDER BY s.created_at, u.username`,
    )
    .all(ownerId, ref.collection, ref.locale, ref.slug) as MemberBrief[];
}

/** Every entry of a member's that is shared, keyed `<collection>/<locale>/<slug>`. */
export function participantsByEntry(ownerId: string): Map<string, MemberBrief[]> {
  const rows = db
    .query(
      `SELECT s.collection, s.locale, s.slug, u.id, u.username, u.display_name, u.avatar_color, u.avatar_url
         FROM entry_shares s JOIN users u ON u.id = s.member_id
        WHERE s.owner_id = ?
        ORDER BY s.created_at, u.username`,
    )
    .all(ownerId) as (MemberBrief & { collection: string; locale: string; slug: string })[];
  const out = new Map<string, MemberBrief[]>();
  for (const { collection, locale, slug, ...member } of rows) {
    const key = `${collection}/${locale}/${slug}`;
    const list = out.get(key);
    if (list) list.push(member);
    else out.set(key, [member]);
  }
  return out;
}

/** The entries of other members that are shared with this one. */
export function sharedWith(memberId: string): SharedRef[] {
  return db
    .query(
      `SELECT owner_id, collection, locale, slug FROM entry_shares
        WHERE member_id = ? ORDER BY created_at DESC`,
    )
    .all(memberId) as SharedRef[];
}

export function isSharedWith(memberId: string, ref: SharedRef): boolean {
  return !!db
    .query(
      `SELECT 1 FROM entry_shares
        WHERE owner_id = ? AND collection = ? AND locale = ? AND slug = ? AND member_id = ?`,
    )
    .get(ref.owner_id, ref.collection, ref.locale, ref.slug, memberId);
}

/**
 * Share an entry with a member. The same limits as adding someone to a
 * conversation: a guest only meets the people on their allow-list — the owner
 * and everyone already there — and nobody is pulled in by a member they have
 * blocked.
 */
export function shareEntry(ref: SharedRef, memberId: string): void {
  const target = memberBrief(memberId);
  if (!target) throw new EntryShareError("Unknown member", 404);
  if (target.id === ref.owner_id) throw new EntryShareError("The entry is already theirs", 400);
  for (const present of [ref.owner_id, ...participantsOf(ref.owner_id, ref).map((p) => p.id)]) {
    if (!guestCanReach(target.id, present)) throw new EntryShareError("Not allowed to add this member", 403);
  }
  if (hasBlocked(target.id, ref.owner_id)) throw new EntryShareError("Not allowed to add this member", 403);
  db.run(
    `INSERT OR IGNORE INTO entry_shares (owner_id, collection, locale, slug, member_id) VALUES (?, ?, ?, ?, ?)`,
    [ref.owner_id, ref.collection, ref.locale, ref.slug, target.id],
  );
}

export function unshareEntry(ref: SharedRef, memberId: string): void {
  db.run(
    `DELETE FROM entry_shares
      WHERE owner_id = ? AND collection = ? AND locale = ? AND slug = ? AND member_id = ?`,
    [ref.owner_id, ref.collection, ref.locale, ref.slug, memberId],
  );
}

/** An entry that is gone is shared with nobody. `ids` are `<collection>/<locale>/<slug>`. */
export function dropShares(ownerId: string, ids: string[]): void {
  for (const id of ids) {
    const [collection, locale, slug] = id.split("/");
    if (!collection || !locale || !slug) continue;
    db.run(
      `DELETE FROM entry_shares WHERE owner_id = ? AND collection = ? AND locale = ? AND slug = ?`,
      [ownerId, collection, locale, slug],
    );
  }
}

/** Who started a conversation — the member a note that came from it is owed to. */
export function conversationInitiator(conversationId: string): MemberBrief | null {
  return db
    .query(
      `SELECT u.id, u.username, u.display_name, u.avatar_color, u.avatar_url
         FROM conversations c JOIN users u ON u.id = c.user_id WHERE c.id = ?`,
    )
    .get(conversationId) as MemberBrief | null;
}
