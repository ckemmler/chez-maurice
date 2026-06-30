import { Hono } from "hono";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { createPairingToken } from "../services/auth";
import db from "../db";

const admin = new Hono();

admin.use("/*", requireAuth);
admin.use("/*", requireAdmin);

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

export default admin;
