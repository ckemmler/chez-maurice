import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import { getMaurice, isBuiltinMaurice, type Maurice } from "../services/maurices";
import { deleteBrief, getBrief, refreshBrief, setBriefText, type BriefRow } from "../services/domainBriefs";

// A domain is a row of `maurices` seen from the other side: not a persona to
// summon but a part of a member's life that Maurice follows, with a brief he
// keeps on it (services/domainBriefs.ts). This router is where the brief is
// served: read, corrected, erased, and rewritten now.
//
// A brief is the creator's — a persona shared with a guest is still the
// creator's domain — so only the member who made the domain reaches it here.

const domains = new Hono();

domains.use("/*", requireAuth);

/** The domain when it is the caller's, else null. */
function ownDomain(c: any): Maurice | null {
  const id = c.req.param("id");
  const uid = c.get("userId");
  if (isBuiltinMaurice(id)) return null;
  const domain = getMaurice(id);
  if (!domain || domain.created_by !== uid) return null;
  return domain;
}

function notFound(c: any) {
  const id = c.req.param("id");
  return c.json({ error: isBuiltinMaurice(id) ? "Maurice Maurice has no brief" : "Not found" }, 404);
}

function briefJson(b: BriefRow | null) {
  return b ? { text: b.text, updated_at: b.updated_at, sources: b.sources, read_until: b.read_until, model: b.model } : null;
}

// GET /api/domains/:id/brief — the brief as it stands, or `brief: null` when
// the night has not written one yet (a 200: the domain exists, the brief
// does not). The domain's name rides along for a page that opens on the id.
domains.get("/:id/brief", (c) => {
  const domain = ownDomain(c);
  if (!domain) return notFound(c);
  return c.json({
    domain: { id: domain.id, name: domain.name, tagline: domain.tagline },
    brief: briefJson(getBrief(domain.id, domain.created_by!)),
  });
});

// PUT /api/domains/:id/brief — the member's correction, `{ text }`. What
// they wrote is the brief from the next turn on, and what the next night
// starts from, marked as theirs. An empty text erases the brief.
domains.put("/:id/brief", async (c) => {
  const domain = ownDomain(c);
  if (!domain) return notFound(c);
  let body: { text?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected a JSON body with `text`" }, 400);
  }
  if (typeof body.text !== "string") return c.json({ error: "`text` must be a string" }, 400);
  const brief = setBriefText(domain.id, domain.created_by!, body.text);
  return c.json({ brief: briefJson(brief) });
});

// DELETE /api/domains/:id/brief — Maurice forgets what he kept on the domain.
// Idempotent: erasing a brief that is not there is a 200 with `erased: false`.
domains.delete("/:id/brief", (c) => {
  const domain = ownDomain(c);
  if (!domain) return notFound(c);
  return c.json({ erased: deleteBrief(domain.id, domain.created_by!) });
});

// POST /api/domains/:id/brief/refresh — rewrite the brief now, from whatever
// touched the domain since the last one. Answers when it is done: a rewrite
// is one model call, seconds. `outcome` says what happened — `written`,
// `unchanged` (nothing new: no call was made), `failed`, or `capped` (the
// night's allowance is spent) — beside the brief as it now stands.
domains.post("/:id/brief/refresh", async (c) => {
  const domain = ownDomain(c);
  if (!domain) return notFound(c);
  const r = await refreshBrief(domain, domain.created_by!);
  return c.json(
    { outcome: r.outcome, sources: r.sources, cost_usd: r.cost_usd, error: r.error ?? null, brief: briefJson(r.brief) },
    r.outcome === "capped" ? 429 : r.outcome === "failed" ? 502 : 200,
  );
});

export default domains;
