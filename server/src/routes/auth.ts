import { Hono } from "hono";
import {
  createSession,
  revokeSession,
  verifyPassword,
  verifyPin,
  redeemPairingToken,
  redeemInviteCode,
} from "../services/auth";
import {
  getUserByUsername,
  getUserById,
  listUsers,
  adminExists,
  createUser,
  setUserPin,
} from "../services/users";
import { requireAuth } from "../middleware/auth";
import type { Context } from "hono";

const auth = new Hono();

// ── Enroll rate limiting (anti-brute-force) ─────────────────────
// /api/auth/enroll is unauthenticated, so it's the surface for guessing invite
// codes. Count FAILED attempts in a fixed window (successful enrollments never
// count, so legit members onboarding many devices aren't penalized), per client
// IP with a global backstop. In-memory — fine for a single-process household.
const ENROLL_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const ENROLL_FAILS_PER_IP = 10;
const ENROLL_FAILS_GLOBAL = 100;

type Bucket = { count: number; reset: number };
const enrollFailsByIp = new Map<string, Bucket>();
let enrollFailsGlobal: Bucket = { count: 0, reset: 0 };

function clientIp(c: Context): string {
  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}

function liveCount(b: Bucket | undefined, now: number): number {
  return !b || now >= b.reset ? 0 : b.count;
}

/** Seconds to wait if this IP (or the whole server) is over its failure budget,
 *  else null. */
function enrollRetryAfter(ip: string): number | null {
  const now = Date.now();
  const ipb = enrollFailsByIp.get(ip);
  if (ipb && liveCount(ipb, now) >= ENROLL_FAILS_PER_IP) return Math.ceil((ipb.reset - now) / 1000);
  if (liveCount(enrollFailsGlobal, now) >= ENROLL_FAILS_GLOBAL) {
    return Math.ceil((enrollFailsGlobal.reset - now) / 1000);
  }
  return null;
}

function recordEnrollFailure(ip: string): void {
  const now = Date.now();
  if (enrollFailsByIp.size > 2000) {
    for (const [k, v] of enrollFailsByIp) if (now >= v.reset) enrollFailsByIp.delete(k);
  }
  const bump = (b: Bucket): Bucket => {
    if (now >= b.reset) { b.count = 0; b.reset = now + ENROLL_WINDOW_MS; }
    b.count++;
    return b;
  };
  enrollFailsByIp.set(ip, bump(enrollFailsByIp.get(ip) ?? { count: 0, reset: 0 }));
  enrollFailsGlobal = bump(enrollFailsGlobal);
}

// ── POST /api/auth/setup ────────────────────────────────────────
// First-run: create the admin account. Only works if no admin exists.

auth.post("/setup", async (c) => {
  if (adminExists()) {
    return c.json({ error: "Admin already exists" }, 409);
  }

  const { username, password, display_name } = await c.req.json();
  if (!username || !password) {
    return c.json({ error: "username and password required" }, 400);
  }

  const user = await createUser({
    username,
    display_name: display_name || username,
    role: "admin",
    password,
    avatar_color: "#2a2622",
  });

  const { token } = createSession(user.id);

  return c.json({ user, token }, 201);
});

// ── POST /api/auth/login ────────────────────────────────────────
// Login with username + password (admin) or user_id + PIN (standard)

auth.post("/login", async (c) => {
  const body = await c.req.json();

  // Admin login: username + password
  if (body.username && body.password) {
    const record = getUserByUsername(body.username);
    if (!record || record.role !== "admin" || !record.password_hash) {
      return c.json({ error: "Invalid credentials" }, 401);
    }

    const valid = await verifyPassword(body.password, record.password_hash);
    if (!valid) {
      return c.json({ error: "Invalid credentials" }, 401);
    }

    const { token } = createSession(record.id, body.device_id);
    return c.json({ user_id: record.id, token });
  }

  // Standard user login: user_id + optional PIN
  if (body.user_id) {
    const record = getUserById(body.user_id);
    if (!record) {
      return c.json({ error: "User not found" }, 404);
    }

    // If user has a PIN, require it
    if (record.pin_hash) {
      if (!body.pin) {
        return c.json({ error: "PIN required" }, 401);
      }
      const valid = await verifyPin(body.pin.trim(), record.pin_hash);
      if (!valid) {
        return c.json({ error: "Invalid PIN" }, 401);
      }
    }

    const { token } = createSession(record.id, body.device_id);
    return c.json({ user_id: record.id, token });
  }

  return c.json({ error: "Provide username+password or user_id+pin" }, 400);
});

// ── POST /api/auth/enroll ───────────────────────────────────────
// Redeem an invite code on a fresh device → a session for that member, with no
// admin password needed. Members are told to set a PIN next; guests aren't.

auth.post("/enroll", async (c) => {
  const ip = clientIp(c);
  const retry = enrollRetryAfter(ip);
  if (retry !== null) {
    c.header("Retry-After", String(retry));
    return c.json({ error: "Too many attempts. Try again later." }, 429);
  }
  const { code, device_id } = await c.req.json().catch(() => ({}));
  if (!code) return c.json({ error: "code required" }, 400);
  const redeemed = redeemInviteCode(code);
  if (!redeemed) {
    recordEnrollFailure(ip);
    return c.json({ error: "Invalid or expired code" }, 401);
  }
  const user = getUserById(redeemed.userId);
  if (!user) {
    recordEnrollFailure(ip);
    return c.json({ error: "User not found" }, 404);
  }
  const { token } = createSession(user.id, device_id);
  return c.json({ user_id: user.id, token, role: user.role, needs_pin: user.role !== "guest" });
});

// ── POST /api/auth/set-pin ──────────────────────────────────────
// A member sets their own PIN (after enrolling, or to change it).

auth.post("/set-pin", requireAuth, async (c) => {
  const { pin } = await c.req.json().catch(() => ({}));
  const p = String(pin ?? "").trim();
  if (!/^\d{4,6}$/.test(p)) return c.json({ error: "PIN must be 4–6 digits" }, 400);
  await setUserPin(c.get("userId"), p);
  return c.json({ ok: true });
});

// ── POST /api/auth/logout ───────────────────────────────────────

auth.post("/logout", requireAuth, (c) => {
  const authHeader = c.req.header("Authorization")!;
  const token = authHeader.slice(7);
  revokeSession(token);
  return c.json({ ok: true });
});

// ── POST /api/auth/pair ─────────────────────────────────────────
// Device pairing: accept a pairing token, return device_id

auth.post("/pair", async (c) => {
  const { pairing_token } = await c.req.json();
  if (!pairing_token) {
    return c.json({ error: "pairing_token required" }, 400);
  }

  const result = redeemPairingToken(pairing_token);
  if (!result) {
    return c.json({ error: "Invalid or expired pairing token" }, 400);
  }

  return c.json({ device_id: result.deviceId });
});

export default auth;
