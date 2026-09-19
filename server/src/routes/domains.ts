import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import db from "../db";
import {
  companionBookId,
  companionsFor,
  domainsFor,
  getMaurice,
  isDomain,
  type Maurice,
} from "../services/maurices";
import { deleteBrief, getBrief, refreshBrief, setBriefText, type BriefRow } from "../services/domainBriefs";
import { seededNotesOf } from "../services/domainSeeding";

// A domain is a row of `maurices` of kind `domain`: not a persona to summon
// but a part of a member's life that Maurice follows, with a brief he keeps
// on it (services/domainBriefs.ts). This router lists the member's domains
// and reading companions, and serves the brief: read, corrected, erased, and
// rewritten now.
//
// A brief is the creator's — a domain shared with a guest is still the
// creator's domain — so only the member who made the domain reaches it here.
// A reading companion (kind `companion`) has no brief: the routes answer 404
// for it, and the row it is stays reachable through /api/maurices.

const domains = new Hono();

domains.use("/*", requireAuth);

/** The domain when it is the caller's, else null. */
function ownDomain(c: any): Maurice | null {
  const id = c.req.param("id");
  const uid = c.get("userId");
  const domain = getMaurice(id);
  if (!domain || domain.created_by !== uid || !isDomain(domain)) return null;
  return domain;
}

function notFound(c: any) {
  const id = c.req.param("id");
  const row = getMaurice(id);
  if (row && row.created_by === c.get("userId") && row.kind === "companion") {
    return c.json({ error: "A reading companion has no brief" }, 404);
  }
  return c.json({ error: "Not found" }, 404);
}

function briefJson(b: BriefRow | null) {
  return b ? { text: b.text, updated_at: b.updated_at, sources: b.sources, read_until: b.read_until, model: b.model } : null;
}

/** The pinned conversation of a companion for this member: the most recently
 *  touched conversation bound to it that the member sits in, or null. */
function pinnedConversation(companionId: string, memberId: string): string | null {
  const row = db
    .query(
      `SELECT c.id FROM conversations c
         JOIN conversation_participants p ON p.conversation_id = c.id
        WHERE c.maurice_id = ? AND p.member_id = ?
        ORDER BY c.updated_at DESC, c.created_at DESC LIMIT 1`,
    )
    .get(companionId, memberId) as { id: string } | null;
  return row?.id ?? null;
}

// GET /api/domains — the member's domains and reading companions, sorted.
// A standard member sees the rows they made; a guest the ones granted to
// them (`mine: false`, and no brief: the brief is the creator's). Each domain
// carries when its brief was last rewritten and by whom, or `brief: null`,
// and the notes Maurice seeded in the garden for it (P2-C: how many, how many
// not reviewed yet, the hub's web path) or `notes: null`; each companion its
// book and its pinned conversation, when one exists.
domains.get("/", (c) => {
  const uid = c.get("userId");
  const role = c.get("userRole");
  const list = domainsFor(uid, role).map((d) => {
    const mine = d.created_by === uid;
    const b = mine ? getBrief(d.id, uid) : null;
    return {
      id: d.id,
      name: d.name,
      tagline: d.tagline,
      kind: d.kind,
      created_by: d.created_by,
      mine,
      count: d.count,
      weight: d.weight,
      brief: b ? { updated_at: b.updated_at, model: b.model, sources: b.sources.length } : null,
      notes: mine ? seededNotesOf(uid, d.id) : null,
    };
  });
  const companions = companionsFor(uid, role).map((m) => ({
    id: m.id,
    name: m.name,
    tagline: m.tagline,
    kind: m.kind,
    created_by: m.created_by,
    mine: m.created_by === uid,
    book_id: companionBookId(m),
    conversation_id: pinnedConversation(m.id, uid),
  }));
  return c.json({ domains: list, companions });
});

// GET /api/domains/:id/brief — the brief as it stands, or `brief: null` when
// the night has not written one yet (a 200: the domain exists, the brief
// does not). The domain's name rides along for a page that opens on the id.
domains.get("/:id/brief", (c) => {
  const domain = ownDomain(c);
  if (!domain) return notFound(c);
  return c.json({
    domain: { id: domain.id, name: domain.name, tagline: domain.tagline },
    brief: briefJson(getBrief(domain.id, domain.created_by!)),
    notes: seededNotesOf(domain.created_by!, domain.id),
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
