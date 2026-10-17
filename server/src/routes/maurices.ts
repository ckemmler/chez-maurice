import { Hono } from "hono";
import type { Context } from "hono";
import { mergeDomains } from "../services/domainMerge";
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
  if ("taken" in res) return nameTaken(c, res.taken);
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
  if ("taken" in res) return nameTaken(c, res.taken);
  if ("errors" in res) return c.json({ error: "invalid context", details: res.errors }, 400);
  return c.json(res);
});

// POST /api/maurices/:id/merge { into } — fold the domain :id into the domain
// `into`, both the caller's: its conversations, context, briefs, mail and
// seeded notes move over, and :id is gone (services/domainMerge.ts).
maurices.post("/:id/merge", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { into?: string };
  if (!body.into) return c.json({ error: "into required" }, 400);
  const res = mergeDomains(c.get("userId"), c.req.param("id"), body.into);
  if ("error" in res) return c.json({ error: res.error }, res.error === "not_found" ? 404 : 400);
  return c.json({ domain: res.into, moved: res.moved });
});

/** 409 for a domain name the member has already, naming the one that has it
 *  so the client can offer to open it. */
function nameTaken(c: Context, taken: { id: string; name: string }) {
  return c.json({ error: "domain_name_taken", existing: { id: taken.id, name: taken.name } }, 409);
}

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
