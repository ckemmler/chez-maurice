import fs from "node:fs";
import path from "node:path";
import db from "../db";
import { getUser, listUsers, type User } from "./users";
import { scanNotes, type NoteMeta } from "./composer/notes";
import { gardensRoot } from "./gardensRoot";

// Shared gardens — the per-NOTE sharing model (Claude Design handoff,
// "Shared Gardens - Sidebar"). Sharing is a fact about a note: the note's
// audience = its owner + everyone it's shared with. A "garden" is the DERIVED
// set of notes that share the same audience — named by the people, never by an
// invented title. The personal garden is just the audience {me}.
//
// note_shares rows live in the DB; the notes themselves stay markdown files in
// web/gardens/<owner>/notes/. garden_settings carries the per-garden web theme
// ("every gardener sees it"), keyed by the audience key.

const GARDENS_FS = gardensRoot();

export interface GardenMember {
  member_id: string;
  username: string | null;
  display_name: string;
  avatar_color: string;
  avatar_url: string | null;
}

export interface GardenNote {
  owner_id: string;
  owner_username: string;
  slug: string;
  locale: string;
  title: string;
  updated_at: string | null;
  /** signed-in web path of the note (relative to the server origin) */
  web_path: string;
}

export interface Garden {
  /** audience key: the sorted member ids joined with '+' */
  id: string;
  mine: boolean;
  members: GardenMember[];
  web_theme: string;
  /** signed-in web path of the garden itself */
  web_path: string;
  notes: GardenNote[];
}

/** Stable id for an audience set: sorted member ids joined with '+'. */
export function audienceKey(memberIds: Iterable<string>): string {
  return [...new Set(memberIds)].sort().join("+");
}

function memberOf(u: User): GardenMember {
  return {
    member_id: u.id,
    username: u.username,
    display_name: u.display_name,
    avatar_color: u.avatar_color,
    avatar_url: u.avatar_url,
  };
}

// ── Shares ──────────────────────────────────────────────────────────────────

/** Everyone a note is shared with (excluding its owner). */
export function sharesFor(ownerId: string, slug: string): string[] {
  return (
    db.query(`SELECT member_id FROM note_shares WHERE owner_id = ? AND slug = ?`)
      .all(ownerId, slug) as Array<{ member_id: string }>
  ).map((r) => r.member_id);
}

/** The full audience of a note: owner + shares. */
export function noteAudience(ownerId: string, slug: string): string[] {
  return [...new Set([ownerId, ...sharesFor(ownerId, slug)])].sort();
}

export function isNoteSharedWith(ownerId: string, slug: string, memberId: string): boolean {
  if (memberId === ownerId) return true;
  return !!db
    .query(`SELECT 1 FROM note_shares WHERE owner_id = ? AND slug = ? AND member_id = ?`)
    .get(ownerId, slug, memberId);
}

/** A member "tends" a note when they're in its audience (owner or shared). */
export function tendsNote(ownerId: string, slug: string, memberId: string): boolean {
  return isNoteSharedWith(ownerId, slug, memberId);
}

export function addShare(ownerId: string, slug: string, memberId: string): void {
  if (memberId === ownerId) return;
  db.run(
    `INSERT OR IGNORE INTO note_shares (owner_id, slug, member_id) VALUES (?, ?, ?)`,
    [ownerId, slug, memberId],
  );
}

/** Remove yourself — never others. The owner hosts the note and can't leave. */
export function removeSelf(ownerId: string, slug: string, memberId: string): boolean {
  if (memberId === ownerId) return false;
  db.run(`DELETE FROM note_shares WHERE owner_id = ? AND slug = ? AND member_id = ?`, [
    ownerId,
    slug,
    memberId,
  ]);
  return true;
}

// ── Garden settings (per-audience web theme) ────────────────────────────────

export function gardenTheme(id: string): string {
  const row = db.query(`SELECT web_theme FROM garden_settings WHERE id = ?`).get(id) as
    | { web_theme: string }
    | undefined;
  // "default" is the hidden internal base; a garden with no explicit choice
  // gets a real garden theme.
  return row?.web_theme ?? "manuscript";
}

export function setGardenTheme(id: string, webTheme: string): void {
  db.run(
    `INSERT INTO garden_settings (id, web_theme, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET web_theme = excluded.web_theme, updated_at = datetime('now')`,
    [id, webTheme],
  );
}

// ── Derivation ──────────────────────────────────────────────────────────────

function noteMtime(ownerUsername: string, note: NoteMeta): string | null {
  for (const ext of [".md", ".mdx"]) {
    const p = path.join(GARDENS_FS, ownerUsername, "notes", note.locale, note.slug + ext);
    try {
      // Second precision — the app's parseServerDate doesn't read fractional ISO.
      return fs.statSync(p).mtime.toISOString().replace(/\.\d{3}Z$/, "Z");
    } catch {}
  }
  return null;
}

function noteWebPath(ownerUsername: string, note: NoteMeta): string {
  const prefix = note.locale === "en" ? "" : `/${note.locale}`;
  return `/g/${ownerUsername}${prefix}/notes/${note.slug}`;
}

/**
 * Every garden a member belongs to: their personal garden first (always
 * present, even empty), then the shared sets, smallest audience first.
 * Notes from different owners with the same audience belong to the same set.
 */
export function gardensFor(memberId: string): Garden[] {
  const me = getUser(memberId);
  if (!me) return [];
  const members = listUsers().filter((u) => u.role !== "guest");
  const byId = new Map(members.map((u) => [u.id, u]));

  const buckets = new Map<string, GardenNote[]>();
  const audienceIds = new Map<string, string[]>();
  const mineKey = audienceKey([memberId]);
  buckets.set(mineKey, []);
  audienceIds.set(mineKey, [memberId]);

  for (const owner of members) {
    const shared = sharedSlugsByOwner(owner.id);
    // A member only scans gardens they can see into: their own notes always,
    // another member's only when at least one of that owner's notes is shared.
    if (owner.id !== memberId && ![...shared.values()].some((a) => a.includes(memberId))) continue;
    for (const note of scanNotes(owner.id).values()) {
      const audience = [owner.id, ...(shared.get(note.slug) ?? [])].sort();
      if (!audience.includes(memberId)) continue;
      const key = audienceKey(audience);
      if (!buckets.has(key)) {
        buckets.set(key, []);
        audienceIds.set(key, audience);
      }
      buckets.get(key)!.push({
        owner_id: owner.id,
        owner_username: owner.username,
        slug: note.slug,
        locale: note.locale,
        title: note.title,
        updated_at: noteMtime(owner.username, note),
        web_path: noteWebPath(owner.username, note),
      });
    }
  }

  const gardens: Garden[] = [];
  for (const [key, notes] of buckets) {
    const ids = audienceIds.get(key)!;
    const mine = key === mineKey;
    notes.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
    gardens.push({
      id: key,
      mine,
      members: ids.map((id) => byId.get(id)).filter((u): u is User => !!u).map(memberOf),
      web_theme: gardenTheme(key),
      web_path: mine ? `/g/${me.username}/` : `/gardens/${encodeURIComponent(key)}`,
      notes,
    });
  }

  // My garden first, then smallest audience first, ties by member names.
  gardens.sort((a, b) => {
    if (a.mine !== b.mine) return a.mine ? -1 : 1;
    if (a.members.length !== b.members.length) return a.members.length - b.members.length;
    return a.id.localeCompare(b.id);
  });
  return gardens;
}

/** All shares for one owner, grouped by slug (one query instead of N). */
function sharedSlugsByOwner(ownerId: string): Map<string, string[]> {
  const rows = db
    .query(`SELECT slug, member_id FROM note_shares WHERE owner_id = ?`)
    .all(ownerId) as Array<{ slug: string; member_id: string }>;
  const out = new Map<string, string[]>();
  for (const r of rows) {
    if (!out.has(r.slug)) out.set(r.slug, []);
    out.get(r.slug)!.push(r.member_id);
  }
  return out;
}

/** One derived garden by audience key — null when the caller isn't in it. */
export function gardenFor(memberId: string, id: string): Garden | null {
  return gardensFor(memberId).find((g) => g.id === id) ?? null;
}
