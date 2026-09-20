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
import {
  applyProposals,
  getProposal,
  memberConversationCount,
  proposalView,
  proposalsForMember,
  renameProposal,
  type ApplyItem,
  type Proposal,
} from "../services/domainProposals";
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
//
// The proposal routes (P2-D, 20 September 2026) are the app's drawer "Define
// my domains": what the night proposed to the member, with each proposal's
// weight, and the member's word on it — rename, adopt, put away, one at a
// time or the whole lot — on the same functions as the tools of the
// conversation Maurice opened (services/domainProposals.ts). The member is
// the caller; a proposal of someone else's is not found.

const domains = new Hono();

domains.use("/*", requireAuth);

/** The caller's open proposal, or null. */
function ownProposal(c: any): Proposal | null {
  const p = getProposal(c.req.param("id"));
  return p && p.member_id === c.get("userId") ? p : null;
}

function proposalOrNotFound(c: any): Proposal | Response {
  const p = ownProposal(c);
  if (!p) return c.json({ error: "Not found" }, 404);
  if (p.state !== "proposed") return c.json({ error: `This proposal is ${p.state}`, state: p.state }, 409);
  return p;
}

async function jsonBody(c: any): Promise<any | null> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// GET /api/domains/proposals — the member's open proposals, alive first,
// each with its weight (1–5, relative to the biggest), its share of the
// member's conversations, how many were recent, one line of summary, and
// the conversation that carries them; the settled ones of that conversation
// ride along for the record. An empty `proposals` means the drawer has
// nothing to show — the app hides its button on that.
domains.get("/proposals", (c) => {
  return c.json(proposalsForMember(c.get("userId")));
});

// PATCH /api/domains/proposals/:id — `{ name?, summary? }`, the member's words.
domains.patch("/proposals/:id", async (c) => {
  const p = proposalOrNotFound(c);
  if (p instanceof Response) return p;
  const body = await jsonBody(c);
  if (!body) return c.json({ error: "Expected a JSON body" }, 400);
  const renamed = renameProposal(p, { name: str(body.name), summary: str(body.summary) });
  return c.json({ proposal: proposalView(renamed, Math.max(1, renamed.conversation_ids.length), memberConversationCount(p.member_id)) });
});

// POST /api/domains/proposals/:id/adopt — `{ name?, summary?, seed? }`: the
// domain is created as the tool creates it (kind domain, conversations bound,
// first brief in the background); `seed: true` also writes the garden notes,
// in the background — the box is off by default, a yes to the domain is not
// a yes to the notes. Maurice says what was done in the conversation.
domains.post("/proposals/:id/adopt", async (c) => {
  const p = proposalOrNotFound(c);
  if (p instanceof Response) return p;
  const body = (await jsonBody(c)) ?? {};
  const r = await applyProposals(p.member_id, [{ id: p.id, action: "adopt", name: str(body.name), summary: str(body.summary), seed: body.seed === true }]);
  if (r.errors.length) return c.json({ error: r.errors[0]!.error }, 422);
  return c.json({ adopted: r.adopted[0], message_id: r.message_id });
});

// POST /api/domains/proposals/:id/dismiss — put away; its conversations
// never come up again.
domains.post("/proposals/:id/dismiss", async (c) => {
  const p = proposalOrNotFound(c);
  if (p instanceof Response) return p;
  const r = await applyProposals(p.member_id, [{ id: p.id, action: "dismiss" }]);
  return c.json({ dismissed: r.dismissed[0], message_id: r.message_id });
});

// POST /api/domains/proposals/apply — the drawer's validation in one go:
// `{ items: [{ id, action: adopt | dismiss | keep, name?, summary?, seed? }] }`.
// `keep` only renames. Answers with what was adopted, dismissed and renamed,
// the errors per item, and the id of the message Maurice left.
domains.post("/proposals/apply", async (c) => {
  const body = await jsonBody(c);
  const items = Array.isArray(body?.items) ? body.items : null;
  if (!items) return c.json({ error: "Expected a JSON body with `items`" }, 400);
  const clean: ApplyItem[] = [];
  for (const it of items) {
    const id = str(it?.id);
    const action = str(it?.action);
    if (!id || !action || !["adopt", "dismiss", "keep"].includes(action)) continue;
    clean.push({ id, action: action as ApplyItem["action"], name: str(it.name), summary: str(it.summary), seed: it.seed === true });
  }
  const r = await applyProposals(c.get("userId"), clean);
  return c.json(r);
});

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
