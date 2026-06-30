import { Hono } from "hono";
import { requireAuth, requireAdmin, listApiTokens, revokeApiToken, createApiToken, getRawApiToken } from "../middleware/auth";
import {
  listUsers,
  getUser,
  createUser,
  updateUser,
  setUserAvatar,
  deleteUser,
  getUserPreferences,
  updateUserPreferences,
  getGuestContacts,
  updateHousehold,
} from "../services/users";
import { unreadRoomCount } from "../services/conversations";
import { saveAvatar } from "../services/avatars";
import { registerDeviceToken, removeDeviceToken } from "../services/push";
import { blockMember, unblockMember } from "../services/safety";

const users = new Hono();

// All user routes require auth
users.use("/*", requireAuth);

// ── GET /api/users ──────────────────────────────────────────────
// List all household users (any authenticated user can see the roster)

users.get("/", (c) => {
  let all = listUsers();
  const role = c.get("userRole");
  // A guest only sees the people they're allowed to talk to (plus themselves).
  if (role === "guest") {
    const reach = new Set([c.get("userId"), ...getGuestContacts(c.get("userId"))]);
    all = all.filter((u) => reach.has(u.id));
  }
  // Standard/guest users get a minimal view
  if (role !== "admin") {
    return c.json(
      all.map((u) => ({
        id: u.id,
        display_name: u.display_name,
        avatar_color: u.avatar_color,
        avatar_url: u.avatar_url,
        has_pin: u.has_pin,
        role: u.role,
      }))
    );
  }
  return c.json(all);
});

// ── GET /api/users/me ───────────────────────────────────────────

users.get("/me", (c) => {
  const user = getUser(c.get("userId"));
  if (!user) return c.json({ error: "User not found" }, 404);
  return c.json(user);
});

// ── PATCH /api/users/me ─────────────────────────────────────────

users.patch("/me", async (c) => {
  const body = await c.req.json();
  const allowed = ["display_name", "profile_text"];
  const updates: Record<string, any> = {};

  for (const key of allowed) {
    if (body[key] !== undefined) updates[key] = body[key];
  }

  const user = await updateUser(c.get("userId"), updates);
  return c.json(user);
});

// ── PUT /api/users/:id/avatar ───────────────────────────────────
// Set a member's photo avatar from a base64 data URI. A member may set their
// own; admins may set anyone's. Returns the updated user.

users.put("/:id/avatar", async (c) => {
  const id = c.req.param("id");
  const callerId = c.get("userId");
  if (id !== callerId && c.get("userRole") !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }
  const { image } = await c.req.json().catch(() => ({}));
  if (!image) return c.json({ error: "image required" }, 400);
  try {
    const { url } = saveAvatar(image);
    const user = setUserAvatar(id, url);
    if (!user) return c.json({ error: "User not found" }, 404);
    return c.json(user);
  } catch (err: any) {
    return c.json({ error: err?.message || "Invalid image" }, 400);
  }
});

// ── Device push tokens ───────────────────────────────────────
// The active user registers this device's APNs token; re-registered on switch.

users.post("/me/device-token", async (c) => {
  const { token, platform, household_tag } = await c.req.json().catch(() => ({}));
  if (!token) return c.json({ error: "token required" }, 400);
  registerDeviceToken(c.get("userId"), String(token), String(platform || "ios"), household_tag ? String(household_tag) : undefined);
  return c.json({ ok: true });
});

users.delete("/me/device-token/:token", (c) => {
  removeDeviceToken(c.req.param("token"));
  return c.json({ ok: true });
});

// The current member's unread roll-up for this foyer (rooms with new messages
// from others) — the app polls this per household for the switcher badge.
users.get("/me/unread", (c) => {
  return c.json({ unread: unreadRoomCount(c.get("userId")) });
});

// Household identity (name / colour / icon) — admin only.
users.patch("/household", requireAdmin, async (c) => {
  const { name, color, icon } = await c.req.json().catch(() => ({}));
  updateHousehold({
    ...(name !== undefined ? { name: String(name) } : {}),
    ...(color !== undefined ? { color: String(color) } : {}),
    ...(icon !== undefined ? { icon: String(icon) } : {}),
  });
  return c.json({ ok: true });
});

// ── GET /api/users/me/preferences ─────────────────────────────

users.get("/me/preferences", (c) => {
  const prefs = getUserPreferences(c.get("userId"));
  return c.json(prefs);
});

// ── PATCH /api/users/me/preferences ──────────────────────────

users.patch("/me/preferences", async (c) => {
  const body = await c.req.json();
  const prefs = updateUserPreferences(c.get("userId"), body);
  return c.json(prefs);
});

// ── POST /api/users/me/mcp-token ────────────────────────────────
// Get-or-create the member's single "mcp-settings" token. Idempotent so every
// device of the same member converges on the SAME token — important because
// Claude.ai/Desktop store one bearer per connection. Pass { rotate: true } to
// force a fresh token (revokes the old one, breaking other devices until they
// reload).

users.post("/me/mcp-token", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  const rotate = body?.rotate === true;

  if (!rotate) {
    // Return the existing recoverable token if one is already provisioned.
    const existingRaw = getRawApiToken(userId, "mcp-settings");
    if (existingRaw) return c.json({ rawToken: existingRaw });
  }

  // Rotating, or no recoverable token exists yet: clear any old ones and mint.
  const existing = listApiTokens(userId).filter((t) => t.label === "mcp-settings");
  for (const t of existing) {
    revokeApiToken(t.id, userId);
  }
  const { rawToken } = await createApiToken(userId, "mcp-settings", "mcp", true);
  return c.json({ rawToken });
});

// ── DELETE /api/users/me/mcp-token ──────────────────────────────
// Revoke the member's "mcp-settings" token (if any).

users.delete("/me/mcp-token", (c) => {
  const userId = c.get("userId");
  const existing = listApiTokens(userId).filter((t) => t.label === "mcp-settings");
  for (const t of existing) {
    revokeApiToken(t.id, userId);
  }
  return c.json({ ok: true });
});

// ── Admin-only: CRUD on other users ─────────────────────────────

// POST /api/users (admin creates a new household member)
users.post("/", requireAdmin, async (c) => {
  const body = await c.req.json();
  if (!body.username || !body.display_name) {
    return c.json({ error: "username and display_name required" }, 400);
  }

  try {
    const user = await createUser(body);
    return c.json(user, 201);
  } catch (err: any) {
    if (err.message?.includes("UNIQUE")) {
      return c.json({ error: "Username already taken" }, 409);
    }
    throw err;
  }
});

// PATCH /api/users/:id (admin edits a user)
users.patch("/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const user = await updateUser(id, body);
  if (!user) return c.json({ error: "User not found" }, 404);
  return c.json(user);
});

// DELETE /api/users/:id (admin deletes a user)
users.delete("/:id", requireAdmin, (c) => {
  const id = c.req.param("id");
  // Prevent self-deletion
  if (id === c.get("userId")) {
    return c.json({ error: "Cannot delete yourself" }, 400);
  }
  const ok = deleteUser(id);
  if (!ok) return c.json({ error: "User not found" }, 404);
  return c.json({ ok: true });
});

// ── Block / unblock another member (self-scoped, per-member) ────
// Hides the blocked member's messages from the caller in shared rooms and stops
// the blocked member from pulling the caller into a room. Member↔member only —
// not framed as protection from a hostile operator.

users.post("/:id/block", (c) => {
  const target = c.req.param("id");
  if (target === c.get("userId")) return c.json({ error: "cannot block yourself" }, 400);
  if (!getUser(target)) return c.json({ error: "Unknown member" }, 404);
  blockMember(c.get("userId"), target);
  return c.json({ ok: true }, 201);
});

users.delete("/:id/block", (c) => {
  unblockMember(c.get("userId"), c.req.param("id"));
  return c.json({ ok: true });
});

export default users;
