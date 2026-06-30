import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import {
  listMaurices,
  getMaurice,
  canUseMaurice,
  createMaurice,
  updateMaurice,
  deleteMaurice,
  type MauriceInput,
} from "../services/maurices";

// Specialized Maurices (personas). Private to their creator — each member lists,
// edits, and deletes only the Maurices they made; nobody else in the household
// sees them. Guests are the one exception: an admin can grant a guest access to
// specific personas, surfaced through the persona's `users` access list.

const maurices = new Hono();

maurices.use("/*", requireAuth);

// GET /api/maurices — the caller's own Maurices (a guest sees instead the
// personas an admin has explicitly granted them; the everyday Maurice, which is
// not stored here, stays available to everyone).
maurices.get("/", (c) => {
  const uid = c.get("userId");
  const all = listMaurices();
  if (c.get("userRole") === "guest") {
    return c.json(all.filter((m) => m.users.includes(uid)));
  }
  return c.json(all.filter((m) => m.created_by === uid));
});

// GET /api/maurices/:id — only the creator (or a guest it's shared with).
maurices.get("/:id", (c) => {
  const id = c.req.param("id");
  const m = getMaurice(id);
  if (!m || !canUseMaurice(id, c.get("userId"))) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json(m);
});

// POST /api/maurices — create. Name is required.
maurices.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as MauriceInput;
  if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
  const res = createMaurice(c.get("userId"), body);
  if ("errors" in res) return c.json({ error: "invalid context", details: res.errors }, 400);
  return c.json(res, 201);
});

// PATCH /api/maurices/:id — only the creator may edit.
maurices.patch("/:id", async (c) => {
  const existing = getMaurice(c.req.param("id"));
  if (!existing || existing.created_by !== c.get("userId")) {
    return c.json({ error: "Not found" }, 404);
  }
  const body = (await c.req.json().catch(() => ({}))) as MauriceInput;
  if (body.name !== undefined && !body.name.trim()) {
    return c.json({ error: "name cannot be empty" }, 400);
  }
  const res = updateMaurice(c.req.param("id"), c.get("userId"), body);
  if (res === null) return c.json({ error: "Not found" }, 404);
  if ("errors" in res) return c.json({ error: "invalid context", details: res.errors }, 400);
  return c.json(res);
});

// DELETE /api/maurices/:id — only the creator may delete.
maurices.delete("/:id", (c) => {
  const existing = getMaurice(c.req.param("id"));
  if (!existing || existing.created_by !== c.get("userId")) {
    return c.json({ error: "Not found" }, 404);
  }
  const ok = deleteMaurice(c.req.param("id"));
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

export default maurices;
