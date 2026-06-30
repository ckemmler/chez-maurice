import db from "../db";

// ── Activity throttling (avoid unnecessary writes) ──────────────

const ACTIVITY_THROTTLE_MS = 5 * 60 * 1000; // 5 minutes
const lastSessionTouch = new Map<string, number>();
const lastUserTouch = new Map<string, number>();

function touchSessionActivity(token: string): void {
  const now = Date.now();
  const last = lastSessionTouch.get(token) ?? 0;
  if (now - last < ACTIVITY_THROTTLE_MS) return;
  lastSessionTouch.set(token, now);
  db.run(
    `UPDATE sessions SET last_used_at = datetime('now') WHERE id = ?`,
    [token]
  );
}

export function touchUserActivityThrottled(userId: string): void {
  const now = Date.now();
  const last = lastUserTouch.get(userId) ?? 0;
  if (now - last < ACTIVITY_THROTTLE_MS) return;
  lastUserTouch.set(userId, now);
  db.run(
    `UPDATE users SET last_active_at = datetime('now') WHERE id = ?`,
    [userId]
  );
}

// ── Password hashing ────────────────────────────────────────────

export async function hashPassword(plain: string): Promise<string> {
  return await Bun.password.hash(plain, { algorithm: "bcrypt", cost: 10 });
}

export async function verifyPassword(
  plain: string,
  hash: string
): Promise<boolean> {
  return await Bun.password.verify(plain, hash);
}

// ── PIN hashing (same mechanism, shorter input) ─────────────────

export async function hashPin(pin: string): Promise<string> {
  return await Bun.password.hash(pin, { algorithm: "bcrypt", cost: 10 });
}

export async function verifyPin(
  pin: string,
  hash: string
): Promise<boolean> {
  return await Bun.password.verify(pin, hash);
}

// ── Invite codes (device enrollment) ────────────────────────────
// A short, human-friendly code an admin hands to a member so they can enroll a
// new device without the admin password. Reusable until expiry, one per member.

// Unambiguous alphabet (no I/O/0/1) for codes read aloud or texted.
const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateInviteCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join("");
}

/** Canonicalize user input: uppercase, drop everything but A–Z/2–9. */
export function normalizeInviteCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Display form: GROUP-GROUP. */
export function formatInviteCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

export function createInviteCode(userId: string, days = 7): { code: string; expiresAt: string } {
  db.run(`DELETE FROM invite_codes WHERE user_id = ?`, [userId]); // one active code per member
  let code = generateInviteCode();
  while (db.query(`SELECT 1 FROM invite_codes WHERE code = ?`).get(code)) code = generateInviteCode();
  const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
  db.run(`INSERT INTO invite_codes (code, user_id, expires_at) VALUES (?, ?, ?)`, [code, userId, expiresAt]);
  return { code, expiresAt };
}

/** Redeem a code → the member id, or null if unknown/expired. Reusable: the row
 *  is left in place (still valid within the window). */
export function redeemInviteCode(raw: string): { userId: string } | null {
  const code = normalizeInviteCode(raw);
  const row = db.query(`SELECT user_id, expires_at FROM invite_codes WHERE code = ?`).get(code) as
    | { user_id: string; expires_at: string }
    | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return { userId: row.user_id };
}

export function getInviteForUser(userId: string): { code: string; expires_at: string } | null {
  const row = db.query(`SELECT code, expires_at FROM invite_codes WHERE user_id = ?`).get(userId) as
    | { code: string; expires_at: string }
    | undefined;
  if (!row || new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

export function revokeInvite(userId: string): void {
  db.run(`DELETE FROM invite_codes WHERE user_id = ?`, [userId]);
}

// ── Session tokens ──────────────────────────────────────────────

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createSession(
  userId: string,
  deviceId?: string
): { token: string; expiresAt: string | null } {
  const token = generateToken();
  const expiresAt = null; // sessions don't expire in v1 unless explicitly revoked

  db.run(
    `INSERT INTO sessions (id, user_id, device_id, last_used_at)
     VALUES (?, ?, ?, datetime('now'))`,
    [token, userId, deviceId ?? null]
  );

  return { token, expiresAt };
}

export function validateSession(
  token: string
): { userId: string; deviceId: string | null } | null {
  const row = db
    .query(
      `SELECT user_id, device_id, expires_at FROM sessions WHERE id = ?`
    )
    .get(token) as any;

  if (!row) return null;

  // Check expiry
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    db.run(`DELETE FROM sessions WHERE id = ?`, [token]);
    return null;
  }

  // Touch last_used_at (throttled to once per 5 minutes)
  touchSessionActivity(token);

  return { userId: row.user_id, deviceId: row.device_id };
}

export function revokeSession(token: string): void {
  db.run(`DELETE FROM sessions WHERE id = ?`, [token]);
}

export function revokeAllUserSessions(userId: string): void {
  db.run(`DELETE FROM sessions WHERE user_id = ?`, [userId]);
}

// ── Device pairing ──────────────────────────────────────────────

export function createPairingToken(): {
  deviceId: string;
  pairingToken: string;
} {
  const deviceId = crypto.randomUUID();
  const pairingToken = generateToken();

  db.run(
    `INSERT INTO devices (id, pairing_token) VALUES (?, ?)`,
    [deviceId, pairingToken]
  );

  return { deviceId, pairingToken };
}

export function redeemPairingToken(
  pairingToken: string
): { deviceId: string } | null {
  const row = db
    .query(
      `SELECT id FROM devices WHERE pairing_token = ? AND paired_at IS NULL`
    )
    .get(pairingToken) as any;

  if (!row) return null;

  db.run(
    `UPDATE devices SET paired_at = datetime('now'), pairing_token = NULL WHERE id = ?`,
    [row.id]
  );

  return { deviceId: row.id };
}
