import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import { getMaurice, isBuiltinMaurice } from "../services/maurices";
import { refreshBrief } from "../services/domainBriefs";

// A domain is a row of `maurices` seen from the other side: not a persona to
// summon but a part of a member's life that Maurice follows, with a brief he
// keeps on it (services/domainBriefs.ts). This router is where the brief is
// served. Today: the "now" button. Reading, correcting and erasing the brief
// (GET/PUT/DELETE …/brief) follow in the next session of the domains'
// roadmap, with the app's domain page.
//
// A brief is the creator's — a persona shared with a guest is still the
// creator's domain — so only the member who made the domain reaches it here.

const domains = new Hono();

domains.use("/*", requireAuth);

// POST /api/domains/:id/brief/refresh — rewrite the brief now, from whatever
// touched the domain since the last one. Answers when it is done: a rewrite
// is one model call, seconds. `outcome` says what happened — `written`,
// `unchanged` (nothing new: no call was made), `failed`, or `capped` (the
// night's allowance is spent) — beside the brief as it now stands.
domains.post("/:id/brief/refresh", async (c) => {
  const id = c.req.param("id");
  const uid = c.get("userId");
  if (isBuiltinMaurice(id)) return c.json({ error: "Maurice Maurice has no brief" }, 404);
  const domain = getMaurice(id);
  if (!domain || domain.created_by !== uid) return c.json({ error: "Not found" }, 404);
  const r = await refreshBrief(domain, uid);
  return c.json(
    {
      outcome: r.outcome,
      sources: r.sources,
      cost_usd: r.cost_usd,
      error: r.error ?? null,
      brief: r.brief
        ? { text: r.brief.text, updated_at: r.brief.updated_at, sources: r.brief.sources, read_until: r.brief.read_until, model: r.brief.model }
        : null,
    },
    r.outcome === "capped" ? 429 : r.outcome === "failed" ? 502 : 200,
  );
});

export default domains;
