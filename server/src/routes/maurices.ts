import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import {
  reachableMaurices,
  getMaurice,
  canUseMaurice,
  createMaurice,
  updateMaurice,
  deleteMaurice,
  type MauriceInput,
} from "../services/maurices";

// The rows of `maurices` — the member's domains and reading companions (see
// services/maurices.ts; `kind` tells them apart, and routes/domains.ts serves
// them as such, briefs included). Private to their creator — each member
// lists, edits, and deletes only the rows they made; nobody else in the
// household sees them. Guests are the one exception: an admin can grant a
// guest access to specific rows, surfaced through the `users` access list.
//
// Nothing here is built in any more: Maurice Maurice, the specialist of
// Maurice who headed every list until 19 September 2026, gave way to the
// `maurice_docs` tool the everyday Maurice holds (services/mauriceDocsTool.ts).

const maurices = new Hono();

maurices.use("/*", requireAuth);

// GET /api/maurices — the caller's own rows, domains and companions alike (a
// guest sees instead the rows an admin has explicitly granted them; the
// everyday Maurice, which is not stored here, stays available to everyone).
maurices.get("/", (c) => {
  return c.json(reachableMaurices(c.get("userId"), c.get("userRole")));
});

// GET /api/maurices/:id — only the creator (or a guest it's shared with).
maurices.get("/:id", (c) => {
  const id = c.req.param("id");
  const uid = c.get("userId");
  const m = getMaurice(id);
  if (!m || !canUseMaurice(id, uid)) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json(m);
});

// POST /api/maurices — create. Name is required; `kind` is `domain` unless
// the body says `companion`. `hat` and `palette` are ignored.
maurices.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as MauriceInput;
  if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
  const res = createMaurice(c.get("userId"), body);
  if ("errors" in res) return c.json({ error: "invalid context", details: res.errors }, 400);
  return c.json(res, 201);
});

// PATCH /api/maurices/:id — only the creator may edit; `kind` is how a member
// re-sorts a row by hand (a companion the migration took for a domain, or the
// reverse — nothing else changes, the brief rows included).
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
