import { Hono } from "hono";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { createPairingToken } from "../services/auth";
import { SYSTEM_SPENDER, usageFor } from "../services/budget";
import { docsStatus } from "../services/mauriceDocsRefresh";
import { ArchiveError, exportResponse } from "../services/archive";
import db from "../db";

const admin = new Hono();

admin.use("/*", requireAuth);
admin.use("/*", requireAdmin);

// ── GET /api/admin/usage ────────────────────────────────────────
// Every member's spend, and the tightest daily cap that applies to each. Last,
// the "system" spender: what Maurice spent on nobody's turn (the night's
// briefs), under the night's own cap.

admin.get("/usage", (c) => {
  const rows = db
    .query<{ id: string; username: string; display_name: string }, []>(
      `SELECT id, username, display_name FROM users ORDER BY created_at`,
    )
    .all();
  rows.push({ id: SYSTEM_SPENDER, username: SYSTEM_SPENDER, display_name: "Maurice, at night" });
  return c.json(
    rows.map((u) => {
      const usage = usageFor(u.id);
      return {
        id: u.id,
        username: u.username,
        display_name: u.display_name,
        today_usd: usage.today_usd,
        month_usd: usage.month_usd,
        cap_daily_usd: usage.cap_daily_usd,
      };
    }),
  );
});

// ── GET /api/admin/status ───────────────────────────────────────

admin.get("/status", (c) => {
  const household = db
    .query(`SELECT * FROM households WHERE id = 'default'`)
    .get() as any;

  const userCount = (
    db.query(`SELECT COUNT(*) as n FROM users`).get() as any
  ).n;
  const convoCount = (
    db.query(`SELECT COUNT(*) as n FROM conversations`).get() as any
  ).n;
  const messageCount = (
    db.query(`SELECT COUNT(*) as n FROM messages`).get() as any
  ).n;

  return c.json({
    household_name: household.name,
    has_api_key: !!household.api_key,
    has_fal_api_key: !!household.fal_api_key,
    default_model: household.default_model,
    max_tokens: household.max_tokens,
    users: userCount,
    conversations: convoCount,
    messages: messageCount,
    // Maurice Maurice's documentation: which set he reads and how fresh it is.
    docs: docsStatus(),
  });
});

// ── PATCH /api/admin/settings ───────────────────────────────────

admin.patch("/settings", async (c) => {
  const body = await c.req.json();
  const sets: string[] = [];
  const params: any[] = [];

  if (body.api_key !== undefined) {
    sets.push("api_key = ?");
    params.push(body.api_key || null);
  }
  if (body.fal_api_key !== undefined) {
    sets.push("fal_api_key = ?");
    params.push(body.fal_api_key || null);
  }
  if (body.default_model !== undefined) {
    sets.push("default_model = ?");
    params.push(body.default_model);
  }
  if (body.max_tokens !== undefined) {
    sets.push("max_tokens = ?");
    params.push(body.max_tokens);
  }
  if (body.name !== undefined) {
    sets.push("name = ?");
    params.push(body.name);
  }

  if (sets.length > 0) {
    db.run(
      `UPDATE households SET ${sets.join(", ")} WHERE id = 'default'`,
      params
    );
  }

  const updated = db
    .query(`SELECT * FROM households WHERE id = 'default'`)
    .get() as any;

  // Don't return the raw API key
  return c.json({
    name: updated.name,
    has_api_key: !!updated.api_key,
    has_fal_api_key: !!updated.fal_api_key,
    default_model: updated.default_model,
    max_tokens: updated.max_tokens,
  });
});

// ── POST /api/admin/pairing-token ───────────────────────────────
// Generate a QR-code-friendly pairing token for a new device

admin.post("/pairing-token", (c) => {
  const { deviceId, pairingToken } = createPairingToken();
  return c.json({ device_id: deviceId, pairing_token: pairingToken }, 201);
});

// ── GET /api/admin/export ───────────────────────────────────────
// The whole household as one `maurice-archive` tarball (docs/household-archive.md),
// streamed as tar produces it: the first bytes leave before the uploads are
// read, so a big household never sits silent past the server's idle timeout.
// The archive carries the provider keys with the rest of maurice.db — admin
// only, and the response is marked not to be cached anywhere.

admin.get("/export", (c) => {
  try {
    return exportResponse();
  } catch (e: any) {
    console.error(`[archive] export refused: ${e?.message ?? e}`);
    return c.json({ error: e instanceof ArchiveError ? e.message : "Export failed" }, 500);
  }
});

export default admin;
