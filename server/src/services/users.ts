import db from "../db";
import { hashPassword, hashPin } from "./auth";

export interface User {
  id: string;
  username: string;
  display_name: string;
  role: "admin" | "standard" | "guest";
  avatar_color: string;
  avatar_url: string | null;
  profile_text: string | null;
  has_pin: boolean;
  created_at: string;
  last_active_at: string | null;
}

export interface CreateUserInput {
  username: string;
  display_name: string;
  role?: "admin" | "standard" | "guest";
  password?: string; // required for admin
  pin?: string; // optional for standard users
  avatar_color?: string;
  profile_text?: string;
}

// ── Queries ─────────────────────────────────────────────────────

export function listUsers(): User[] {
  const rows = db
    .query(
      `SELECT id, username, display_name, role, avatar_color, avatar_url, profile_text,
              CASE WHEN pin_hash IS NOT NULL THEN 1 ELSE 0 END as has_pin,
              created_at, last_active_at
       FROM users ORDER BY created_at`
    )
    .all() as any[];

  return rows.map((r) => ({ ...r, has_pin: !!r.has_pin }));
}

export function getUser(id: string): User | null {
  const row = db
    .query(
      `SELECT id, username, display_name, role, avatar_color, avatar_url, profile_text,
              CASE WHEN pin_hash IS NOT NULL THEN 1 ELSE 0 END as has_pin,
              created_at, last_active_at
       FROM users WHERE id = ?`
    )
    .get(id) as any;

  if (!row) return null;
  return { ...row, has_pin: !!row.has_pin };
}

export function getUserByUsername(username: string): {
  id: string;
  role: string;
  password_hash: string | null;
  pin_hash: string | null;
} | null {
  return db
    .query(
      `SELECT id, role, password_hash, pin_hash FROM users WHERE username = ?`
    )
    .get(username) as any;
}

export function getUserById(id: string): {
  id: string;
  role: string;
  password_hash: string | null;
  pin_hash: string | null;
} | null {
  return db
    .query(
      `SELECT id, role, password_hash, pin_hash FROM users WHERE id = ?`
    )
    .get(id) as any;
}

// ── Mutations ───────────────────────────────────────────────────

export async function createUser(input: CreateUserInput): Promise<User> {
  const id = crypto.randomUUID();
  const role = input.role || "standard";

  let passwordHash: string | null = null;
  if (input.password) {
    passwordHash = await hashPassword(input.password);
  }

  let pinHash: string | null = null;
  if (input.pin) {
    pinHash = await hashPin(input.pin);
  }

  db.run(
    `INSERT INTO users (id, username, display_name, role, password_hash, pin_hash, avatar_color, profile_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.username,
      input.display_name,
      role,
      passwordHash,
      pinHash,
      input.avatar_color || "#2c5aa0",
      input.profile_text || null,
    ]
  );

  return getUser(id)!;
}

export async function updateUser(
  id: string,
  updates: {
    display_name?: string;
    avatar_color?: string;
    profile_text?: string;
    pin?: string | null; // null to clear
  }
): Promise<User | null> {
  const sets: string[] = [];
  const params: any[] = [];

  if (updates.display_name !== undefined) {
    sets.push("display_name = ?");
    params.push(updates.display_name);
  }
  if (updates.avatar_color !== undefined) {
    sets.push("avatar_color = ?");
    params.push(updates.avatar_color);
  }
  if (updates.profile_text !== undefined) {
    sets.push("profile_text = ?");
    params.push(updates.profile_text);
  }
  if (updates.pin !== undefined) {
    if (updates.pin === null) {
      sets.push("pin_hash = NULL");
    } else {
      sets.push("pin_hash = ?");
      params.push(await hashPin(updates.pin));
    }
  }

  if (sets.length === 0) return getUser(id);

  params.push(id);
  db.run(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, params);
  return getUser(id);
}

export function setUserAvatar(id: string, url: string | null): User | null {
  db.run(`UPDATE users SET avatar_url = ? WHERE id = ?`, [url, id]);
  return getUser(id);
}

export function deleteUser(id: string): boolean {
  const result = db.run(`DELETE FROM users WHERE id = ?`, [id]);
  return result.changes > 0;
}

export function touchUserActivity(userId: string): void {
  db.run(
    `UPDATE users SET last_active_at = datetime('now') WHERE id = ?`,
    [userId]
  );
}

// ── Preferences ─────────────────────────────────────────────

export interface UserPreferences {
  theme: string;
  palette: string;
  locale: string | null;
}

export function getUserPreferences(userId: string): UserPreferences {
  const row = db
    .query(
      `SELECT theme, palette, locale FROM user_preferences WHERE user_id = ?`
    )
    .get(userId) as any;

  return {
    theme: row?.theme ?? "auto",
    palette: row?.palette ?? "auto",
    locale: row?.locale ?? null,
  };
}

export function updateUserPreferences(
  userId: string,
  updates: Partial<UserPreferences>
): UserPreferences {
  // Upsert: insert defaults then update
  db.run(
    `INSERT OR IGNORE INTO user_preferences (user_id) VALUES (?)`,
    [userId]
  );

  const sets: string[] = [];
  const params: any[] = [];

  const allowed = ["theme", "palette", "locale"];
  for (const key of allowed) {
    if ((updates as any)[key] !== undefined) {
      sets.push(`${key} = ?`);
      params.push((updates as any)[key]);
    }
  }

  if (sets.length > 0) {
    sets.push("updated_at = datetime('now')");
    params.push(userId);
    db.run(
      `UPDATE user_preferences SET ${sets.join(", ")} WHERE user_id = ?`,
      params
    );
  }

  return getUserPreferences(userId);
}

export function adminExists(): boolean {
  const row = db
    .query(`SELECT 1 FROM users WHERE role = 'admin' LIMIT 1`)
    .get();
  return !!row;
}

/** The household's display name (for the app's household switcher). */
export function householdName(): string {
  const row = db.query(`SELECT name FROM households WHERE id = 'default'`).get() as { name: string } | undefined;
  return row?.name ?? "";
}

/** Household identity for the foyer switcher: name + optional colour/icon. */
export function householdInfo(): { name: string; color: string | null; icon: string | null } {
  const row = db.query(`SELECT name, color, icon FROM households WHERE id = 'default'`)
    .get() as { name: string; color: string | null; icon: string | null } | undefined;
  return { name: row?.name ?? "", color: row?.color ?? null, icon: row?.icon ?? null };
}

/** Set the household's name / colour / icon (admin). */
export function updateHousehold(updates: { name?: string; color?: string; icon?: string }): void {
  const sets: string[] = [];
  const params: any[] = [];
  if (updates.name !== undefined) { sets.push("name = ?"); params.push(updates.name); }
  if (updates.color !== undefined) { sets.push("color = ?"); params.push(updates.color); }
  if (updates.icon !== undefined) { sets.push("icon = ?"); params.push(updates.icon); }
  if (!sets.length) return;
  db.run(`UPDATE households SET ${sets.join(", ")} WHERE id = 'default'`, params);
}

// ── Guests ──────────────────────────────────────────────────────
// A guest has standard capabilities but a limited reach: an explicit allow-list
// of people (guest_contacts) and of Maurices (each persona's own access list).

export function isGuest(userId: string | null | undefined): boolean {
  if (!userId) return false;
  const r = db.query(`SELECT role FROM users WHERE id = ?`).get(userId) as { role: string } | undefined;
  return r?.role === "guest";
}

export function getGuestContacts(guestId: string): string[] {
  return (db.query(`SELECT member_id FROM guest_contacts WHERE guest_user_id = ?`).all(guestId) as { member_id: string }[])
    .map((r) => r.member_id);
}

export function setGuestContacts(guestId: string, memberIds: string[]): void {
  db.transaction(() => {
    db.run(`DELETE FROM guest_contacts WHERE guest_user_id = ?`, [guestId]);
    for (const m of [...new Set(memberIds)]) {
      if (m && m !== guestId) {
        db.run(`INSERT OR IGNORE INTO guest_contacts (guest_user_id, member_id) VALUES (?, ?)`, [guestId, m]);
      }
    }
  })();
}

/** May `actorId` and `targetId` share a conversation? A guest is limited to its
 *  contacts; enforced both directions (guest → contact, and someone → guest). */
export function guestCanReach(actorId: string, targetId: string): boolean {
  if (actorId === targetId) return true;
  if (isGuest(actorId) && !getGuestContacts(actorId).includes(targetId)) return false;
  if (isGuest(targetId) && !getGuestContacts(targetId).includes(actorId)) return false;
  return true;
}

export function setUserRole(id: string, role: "admin" | "standard" | "guest"): void {
  db.run(`UPDATE users SET role = ? WHERE id = ?`, [role, id]);
}

/** Set (or change) a member's own PIN — used by self-service PIN setup. */
export async function setUserPin(id: string, pin: string): Promise<void> {
  db.run(`UPDATE users SET pin_hash = ? WHERE id = ?`, [await hashPin(pin), id]);
}
