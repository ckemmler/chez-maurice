import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { validateSession, touchUserActivityThrottled } from "../services/auth";
import { getUser, adminExists } from "../services/users";
import db from "../db";

// Extend Hono context with authenticated user info
declare module "hono" {
  interface ContextVariableMap {
    userId: string;
    userRole: "admin" | "standard" | "guest";
    deviceId: string | null;
  }
}

/**
 * Requires a valid credential in the Authorization header — either a session
 * token or a maur_* API token. Sets userId, userRole, deviceId in the context.
 *
 * Accepting maur_* here matters because the MCP gateway validates member tokens
 * by calling GET /api/users/me with the token as a Bearer; that route uses this
 * middleware, so it must understand API tokens, not just sessions.
 */
export const requireAuth = createMiddleware(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const token = authHeader.slice(7);

  if (token.startsWith("maur_")) {
    const hash = await hashToken(token);
    const result = validateApiToken(hash);
    if (!result) {
      return c.json({ error: "Invalid API token" }, 401);
    }
    const user = getUser(result.userId);
    if (!user) {
      return c.json({ error: "User not found" }, 401);
    }
    c.set("userId", result.userId);
    c.set("userRole", user.role as "admin" | "standard" | "guest");
    c.set("deviceId", null);
    touchUserActivityThrottled(result.userId);
    await next();
    return;
  }

  const session = validateSession(token);
  if (!session) {
    return c.json({ error: "Invalid or expired session" }, 401);
  }

  const user = getUser(session.userId);
  if (!user) {
    return c.json({ error: "User not found" }, 401);
  }

  c.set("userId", session.userId);
  c.set("userRole", user.role as "admin" | "standard" | "guest");
  c.set("deviceId", session.deviceId);

  touchUserActivityThrottled(session.userId);

  await next();
});

/**
 * Requires the authenticated user to be an admin.
 * Must be used after requireAuth.
 */
export const requireAdmin = createMiddleware(async (c, next) => {
  if (c.get("userRole") !== "admin") {
    return c.json({ error: "Admin access required" }, 403);
  }
  await next();
});

// ── API token helpers ────────────────────────────────────────────

async function hashToken(raw: string): Promise<string> {
  const data = new TextEncoder().encode(raw);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

function validateApiToken(tokenHash: string): { userId: string } | null {
  const row = db
    .query(`SELECT user_id FROM api_tokens WHERE token_hash = ?`)
    .get(tokenHash) as any;
  if (!row) return null;
  // Touch last_used_at (fire-and-forget)
  db.run(`UPDATE api_tokens SET last_used_at = datetime('now') WHERE token_hash = ?`, [tokenHash]);
  return { userId: row.user_id };
}

/**
 * Validate a raw maur_* token (hashes it, looks up in DB).
 * Returns the userId on success, null on failure.
 */
export async function validateApiTokenRaw(raw: string): Promise<{ userId: string } | null> {
  const hash = await hashToken(raw);
  return validateApiToken(hash);
}

// ── API token CRUD (used by web-admin routes) ────────────────────

export function generateApiToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `maur_${b64}`;
}

export async function createApiToken(
  userId: string,
  label: string,
  scope: "mcp" | "health" | "full" = "full",
  storeRaw = false
): Promise<{ id: string; rawToken: string }> {
  const raw = generateApiToken();
  const hash = await hashToken(raw);
  const id = crypto.randomUUID();
  // storeRaw keeps a recoverable copy so the token can be re-displayed on other
  // devices (used for the self-service mcp-settings token). Admin/full tokens
  // stay hash-only.
  db.run(
    `INSERT INTO api_tokens (id, user_id, token_hash, label, scope, token_plain) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, userId, hash, label, scope, storeRaw ? raw : null]
  );
  return { id, rawToken: raw };
}

/**
 * Return the recoverable raw token for a (userId, label) pair, or null.
 * Only tokens created with storeRaw=true have a recoverable value.
 */
export function getRawApiToken(userId: string, label: string): string | null {
  const row = db
    .query(`SELECT token_plain FROM api_tokens WHERE user_id = ? AND label = ? AND token_plain IS NOT NULL ORDER BY created_at DESC LIMIT 1`)
    .get(userId, label) as { token_plain: string } | undefined;
  return row?.token_plain ?? null;
}

export function listApiTokens(userId: string): Array<{
  id: string;
  label: string;
  scope: string;
  last_used_at: string | null;
  created_at: string;
}> {
  return db
    .query(`SELECT id, label, scope, last_used_at, created_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC`)
    .all(userId) as any[];
}

export function revokeApiToken(id: string, userId: string): boolean {
  const result = db.run(
    `DELETE FROM api_tokens WHERE id = ? AND user_id = ?`,
    [id, userId]
  );
  return result.changes > 0;
}

// ── Global proxy auth middleware ─────────────────────────────────

/**
 * Global auth middleware applied before all routes.
 * Exempts /healthz and /setup/* (when no owner exists).
 * Checks Authorization: Bearer <token>:
 *   - maur_* tokens → look up hash in api_tokens → resolve to user_id
 *   - Otherwise → validate as session token
 * Sets userId, userRole, deviceId in context + X-Maurice-Member-Id header.
 */
export const proxyAuth = createMiddleware(async (c, next) => {
  const path = c.req.path;

  // Always allow health checks
  if (path === "/healthz") return next();

  // Allow setup when no admin exists
  if (path.startsWith("/setup") && !adminExists()) return next();

  // Allow admin login/setup pages (they have their own cookie-based auth)
  if (path.startsWith("/admin")) return next();

  // Allow auth endpoints
  if (path.startsWith("/api/auth")) return next();

  // Allow API health check
  if (path === "/api/health") return next();

  // MCP gateway routes: the gateway runs its own OAuth (access tokens it minted,
  // or maur_* tokens it validates itself). The server must NOT try to validate
  // those here — it would reject the gateway's opaque access tokens as bad
  // sessions. Pass straight through to the gateway proxy.
  if (path === "/mcp" || path.startsWith("/mcp/")) return next();
  if (path === "/authorize" || path === "/token" || path === "/register") return next();
  if (path.startsWith("/.well-known/oauth-")) return next();

  const authHeader = c.req.header("Authorization");
  let token: string | undefined;

  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  } else {
    // Fall back to session cookie (browser-based web UIs like /dossiers, /articles)
    token = getCookie(c, "maurice_session") || getCookie(c, "maurice_admin");
  }

  if (!token) {
    // No credentials — let the request through for public routes
    // Individual route handlers can use requireAuth for protected endpoints
    return next();
  }

  if (token.startsWith("maur_")) {
    // API token authentication
    const hash = await hashToken(token);
    const result = validateApiToken(hash);
    if (!result) {
      return c.json({ error: "Invalid API token" }, 401);
    }
    const user = getUser(result.userId);
    if (!user) {
      return c.json({ error: "User not found" }, 401);
    }
    c.set("userId", result.userId);
    c.set("userRole", user.role as "admin" | "standard" | "guest");
    c.set("deviceId", null);
    touchUserActivityThrottled(result.userId);
  } else {
    // Session token authentication
    const session = validateSession(token);
    if (!session) {
      return c.json({ error: "Invalid or expired session" }, 401);
    }
    const user = getUser(session.userId);
    if (!user) {
      return c.json({ error: "User not found" }, 401);
    }
    c.set("userId", session.userId);
    c.set("userRole", user.role as "admin" | "standard" | "guest");
    c.set("deviceId", session.deviceId);
    touchUserActivityThrottled(session.userId);
  }

  await next();
});
