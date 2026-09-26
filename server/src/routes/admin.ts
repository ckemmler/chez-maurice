import { Hono } from "hono";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { createPairingToken } from "../services/auth";
import { SYSTEM_SPENDER, usageFor } from "../services/budget";
import { docsStatus } from "../services/mauriceDocsRefresh";
import { ArchiveError, exportResponse } from "../services/archive";
import { openConversation, openingGuard } from "../services/openedConversations";
import { mapMember, mappingNightlyStatus, runDomainMapping } from "../services/domainMapping";
import { corpusNightlyStatus, reconcileCorpus } from "../services/corpusNightly";
import { listProposals, proposalCard, type ProposalState } from "../services/domainProposals";
import { canUseMaurice } from "../services/maurices";
import { getUser, getUserByUsername } from "../services/users";
import { mailReadingStatus, startMailReading } from "../services/mailReading";
import { mailDocumentsStatus, startMailDocuments } from "../services/mailDocuments";
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
    // Maurice's documentation (the maurice_docs tool): which set it reads and how fresh it is.
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

// ── The mail reading, by hand (lot 4, services/mailReading.ts) ─────────
// POST /api/admin/mail/reading/run { member_id | username, limit?, wait? }
// runs the passes for a member who said yes — in the background unless
// `wait` — and GET /api/admin/mail/reading/:member_id says whether a run is
// going and what the last one got through. The operator's hand on what the
// night does on its own; nothing here the member sees.

function memberOf(body: any) {
  return body?.member_id
    ? getUser(String(body.member_id))
    : body?.username
      ? (() => { const u = getUserByUsername(String(body.username)); return u ? getUser(u.id) : null; })()
      : null;
}

admin.post("/mail/reading/run", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const member = memberOf(body);
  if (!member) return c.json({ error: "Unknown member" }, 404);
  const limit = Number.isFinite(Number(body.limit)) && Number(body.limit) > 0 ? Math.floor(Number(body.limit)) : undefined;
  const p = startMailReading(member.id, { limit });
  if (body.wait) return c.json(await p);
  p.catch(() => {});
  return c.json({ started: true, member_id: member.id, limit: limit ?? null, ...mailReadingStatus(member.id) }, 202);
});

admin.get("/mail/reading/:member_id", (c) => c.json(mailReadingStatus(c.req.param("member_id"))));

// The documents (lot 5, services/mailDocuments.ts), by hand: POST
// /api/admin/mail/documents/run { member_id | username, wait? } writes the
// fiches and digests the member's readings allow; GET …/:member_id the last.
admin.post("/mail/documents/run", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const member = memberOf(body);
  if (!member) return c.json({ error: "Unknown member" }, 404);
  const p = startMailDocuments(member.id);
  if (body.wait) return c.json(await p);
  p.catch(() => {});
  return c.json({ started: true, member_id: member.id, ...mailDocumentsStatus(member.id) }, 202);
});

admin.get("/mail/documents/:member_id", (c) => c.json(mailDocumentsStatus(c.req.param("member_id"))));

// ── POST /api/admin/conversations/open ──────────────────────────
// Open a conversation for a member, in Maurice's voice — the operator's hand
// on the brick the night will use (services/openedConversations.ts). Body:
// { member_id | username, text, title?, maurice_id?, force?, dry_run? }.
// `dry_run` only answers the guard. Refused by the guard → 409 with the
// reason (child, guest, too_soon) and, when it is a matter of time, `next_at`.

admin.post("/conversations/open", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const member = body.member_id
    ? getUser(String(body.member_id))
    : body.username
      ? (() => { const u = getUserByUsername(String(body.username)); return u ? getUser(u.id) : null; })()
      : null;
  if (!member) return c.json({ error: "Unknown member" }, 404);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (body.dry_run) return c.json({ member_id: member.id, guard: openingGuard(member.id) });
  if (!text) return c.json({ error: "text required" }, 400);
  const mauriceId = body.maurice_id ? String(body.maurice_id) : null;
  if (mauriceId && !canUseMaurice(mauriceId, member.id)) return c.json({ error: "Unknown domain for this member" }, 404);
  const result = await openConversation({
    memberId: member.id,
    text,
    title: typeof body.title === "string" ? body.title : null,
    mauriceId,
    force: body.force === true,
  });
  if (!result.ok) {
    if (result.reason === "empty") return c.json({ error: "text required" }, 400);
    if (result.reason === "unknown") return c.json({ error: "Unknown member" }, 404);
    return c.json({ error: "Refused by the guard", reason: result.reason, last_opened_at: result.last_opened_at ?? null, next_at: result.next_at ?? null }, 409);
  }
  return c.json({ conversation: result.conversation, message: result.message }, 201);
});

// ── The domain mapping (P2-B) ───────────────────────────────────
// POST /api/admin/domains/map — map one member now: { member_id | username,
// dry_run?, force? }. `dry_run` groups and names (the model calls are made
// and charged) but writes no proposal and opens nothing; `force` walks past
// the opening guard the way the admin's hand may. Without a member, the
// whole night runs (every member), not awaited. GET /api/admin/domains/proposals
// lists a member's proposals (`?username=…&state=proposed`).

// POST /api/admin/corpus/reconcile — reconcile every conversation into the
// corpus now and answer when it is done (the console's button does the same
// without waiting). What a seeded or freshly imported household needs before
// a mapping can read it — the night does it on its own at 03:00.
admin.post("/corpus/reconcile", async (c) => {
  const outcome = await reconcileCorpus();
  return c.json({ outcome, ...corpusNightlyStatus() }, outcome === "failed" ? 500 : 200);
});

admin.post("/domains/map", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const member = body.member_id
    ? getUser(String(body.member_id))
    : body.username
      ? (() => { const u = getUserByUsername(String(body.username)); return u ? getUser(u.id) : null; })()
      : null;
  if (!member) {
    if (body.member_id || body.username) return c.json({ error: "Unknown member" }, 404);
    const already = mappingNightlyStatus().running;
    runDomainMapping().catch(() => {});
    return c.json({ started: !already, running: true }, 202);
  }
  const r = await mapMember(member.id, { dryRun: body.dry_run === true, force: body.force === true });
  return c.json(r, r.outcome === "failed" ? 500 : 200);
});

admin.get("/domains/proposals", (c) => {
  const username = c.req.query("username");
  const memberId = c.req.query("member_id");
  const member = memberId ? getUser(memberId) : username ? (() => { const u = getUserByUsername(username); return u ? getUser(u.id) : null; })() : null;
  if (!member) return c.json({ error: "Unknown member" }, 404);
  const state = c.req.query("state") as ProposalState | undefined;
  const rows = listProposals(member.id, state ? [state] : undefined);
  return c.json({ member_id: member.id, proposals: rows.map((p) => ({ ...proposalCard(p, { ids: c.req.query("ids") === "1" }), conversation_id: p.conversation_id, created_at: p.created_at })) });
});

export default admin;
