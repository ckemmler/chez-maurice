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

// ── Rate limiting (anti-brute-force) ────────────────────────────
// The unauthenticated auth endpoints are the surface for guessing: invite codes
// on /enroll, 4–6 digit PINs on /login. Both are reachable from the public
// internet through the Cloudflare tunnel, so both need a brake. Count FAILED
// attempts in a fixed window (successes never count, so a member onboarding many
// devices or a parent mistyping once isn't penalized), per client IP with a
// global backstop. In-memory — fine for a single-process household.
type Bucket = { count: number; reset: number };

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

/** A per-IP failure limiter with a global backstop. Returns retryAfter (seconds
 *  to wait, or null if under budget) and recordFailure. */
function makeLimiter(windowMs: number, perIp: number, global: number) {
  const byIp = new Map<string, Bucket>();
  let globalBucket: Bucket = { count: 0, reset: 0 };
  return {
    retryAfter(ip: string): number | null {
      const now = Date.now();
      const ipb = byIp.get(ip);
      if (ipb && liveCount(ipb, now) >= perIp) return Math.ceil((ipb.reset - now) / 1000);
      if (liveCount(globalBucket, now) >= global) return Math.ceil((globalBucket.reset - now) / 1000);
      return null;
    },
    recordFailure(ip: string): void {
      const now = Date.now();
      if (byIp.size > 2000) {
        for (const [k, v] of byIp) if (now >= v.reset) byIp.delete(k);
      }
      const bump = (b: Bucket): Bucket => {
        if (now >= b.reset) { b.count = 0; b.reset = now + windowMs; }
        b.count++;
        return b;
      };
      byIp.set(ip, bump(byIp.get(ip) ?? { count: 0, reset: 0 }));
      globalBucket = bump(globalBucket);
    },
  };
}

const enrollLimiter = makeLimiter(10 * 60 * 1000, 10, 100); // invite codes: 10/IP, 100 global, 10 min
const loginLimiter = makeLimiter(15 * 60 * 1000, 10, 200);  // PINs: 10/IP, 200 global, 15 min

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

  // Standard user login: user_id + PIN. Reachable unauthenticated from the
  // public internet through the tunnel, so it is rate-limited, and a PIN is
  // mandatory — a user_id alone (which any member can read from /api/users) must
  // never be enough. An account with no PIN set can only get in by enrolling a
  // device (invite code), which is the flow that then prompts it to set one.
  if (body.user_id) {
    const ip = clientIp(c);
    const retry = loginLimiter.retryAfter(ip);
    if (retry !== null) {
      c.header("Retry-After", String(retry));
      return c.json({ error: "Too many attempts. Try again later." }, 429);
    }

    const record = getUserById(body.user_id);
    // One generic failure shape for "no such user", "no PIN set" and "wrong PIN"
    // alike: never disclose which user_ids exist or which lack a PIN.
    const reject = () => {
      loginLimiter.recordFailure(ip);
      return c.json({ error: "Invalid credentials" }, 401);
    };

    if (!record || !record.pin_hash) return reject();
    if (!body.pin) return c.json({ error: "PIN required" }, 401);
    const valid = await verifyPin(body.pin.trim(), record.pin_hash);
    if (!valid) return reject();

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
  const retry = enrollLimiter.retryAfter(ip);
  if (retry !== null) {
    c.header("Retry-After", String(retry));
    return c.json({ error: "Too many attempts. Try again later." }, 429);
  }
  const { code, device_id } = await c.req.json().catch(() => ({}));
  if (!code) return c.json({ error: "code required" }, 400);
  const redeemed = redeemInviteCode(code);
  if (!redeemed) {
    enrollLimiter.recordFailure(ip);
    return c.json({ error: "Invalid or expired code" }, 401);
  }
  const user = getUserById(redeemed.userId);
  if (!user) {
    enrollLimiter.recordFailure(ip);
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
