// /api/me — what the signed-in member may know about themselves that no
// other route carries. (Their profile is /api/users/me.)
import { Hono } from "hono";
import { requestOrigin } from "../../lib/requestOrigin";
import type { Context } from "hono";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createApiToken, getRawApiToken, listApiTokens, requireAuth, revokeApiToken } from "../middleware/auth";
import { ArchiveError } from "../services/archive";
import { listAccountEvents, markAccountEventsSeen } from "../services/accountEvents";
import db from "../db";
import { verifyPassword, verifyPin } from "../services/auth";
import { householdBudget, usageFor } from "../services/budget";
import { gardensRoot } from "../services/gardensRoot";
import { isGardenDir } from "../services/gitHttp";
import { exportsConversations, setExportsConversations } from "../services/gardenExport";
import { uploadsDir } from "../services/chatImport";
import { importMember, memberExportResponse } from "../services/memberArchive";
import { EraseError, eraseMember, type EraseScope } from "../services/memberErase";
import { getUserById, getUser } from "../services/users";
import { ancillaryTable } from "../services/ancillary";
import {
  embeddingProvider, getConsent, isLocalProvider, providerInfo, setConsent, uncovered,
} from "../services/aiConsent";
import { dictationEngine } from "../services/dictation";
import { getHouseholdConfig } from "../services/claude";
import { getModel, householdDefaultModel } from "../services/models";
import { availableModelsForUser } from "../services/modelAccess";


const me = new Hono();

me.use("/*", requireAuth);

// ── GET /api/me/usage ───────────────────────────────────────────
// What this member has spent today (rolling 24 h) and this calendar month,
// the tightest daily cap that applies to them (null when none), and the
// headroom left under the tightest cap of any kind (null when uncapped).

me.get("/usage", (c) => c.json(usageFor(c.get("userId"))));

// ── The member's own data (docs/member-data.md) ─────────────────
// Export, import and erasure are the member's, about the member: no admin
// route does any of the three for someone else's conversations.

/** An API token (`maur_…`) is what a connected tool holds. It reads as the
 *  member; it does not get to bring data in or erase it. */
const viaApiToken = (c: Context) => (c.req.header("Authorization") ?? "").startsWith("Bearer maur_");

// GET /api/me/events — what the admin did that reached into this account (a
// device in by their code, the household exported): { events: [{ id, kind,
// created_at, seen_at }] }, newest first. POST /api/me/events/seen dismisses
// the unseen ones. services/accountEvents.ts.
me.get("/events", (c) => c.json({ events: listAccountEvents(db, c.get("userId")) }));
me.post("/events/seen", (c) => {
  markAccountEventsSeen(db, c.get("userId"));
  return c.json({ ok: true });
});

// GET /api/me/export — the member archive (`maurice-member-archive` v1), a
// gzipped tar streamed as it is produced.
me.get("/export", (c) => {
  try {
    return memberExportResponse(c.get("userId"));
  } catch (e: any) {
    console.error(`[member-archive] export refused: ${e?.message ?? e}`);
    return c.json({ error: e instanceof ArchiveError ? e.message : "Export failed" }, 500);
  }
});

// POST /api/me/import — multipart, field `file`: a member archive. Poured
// into the caller's account; adds, never overwrites. Answers { report }.
me.post("/import", async (c) => {
  if (viaApiToken(c)) return c.json({ error: "session_required" }, 403);
  let body: Record<string, any>;
  try {
    body = await c.req.parseBody();
  } catch {
    return c.json({ error: "bad_form" }, 400);
  }
  const file = body["file"];
  if (!(file instanceof File)) return c.json({ error: "no_file" }, 400);
  const path = join(uploadsDir(), `member-archive-${crypto.randomUUID()}.tar.gz`);
  await Bun.write(path, file);
  try {
    const { manifest, report } = await importMember(path, c.get("userId"));
    return c.json({ from: manifest.member.display_name, created_at: manifest.created_at, report });
  } catch (e: any) {
    if (e instanceof ArchiveError) return c.json({ error: e.message }, /already imported/.test(e.message) ? 409 : 400);
    console.error(`[member-archive] import failed: ${e?.message ?? e}`);
    return c.json({ error: "Import failed" }, 500);
  } finally {
    rmSync(path, { force: true });
  }
});

// POST /api/me/erase { scope: "data" | "account", confirm, password?, pin? }
// `confirm` is the member's username, typed; the password (or the PIN, for a
// member who signs in with one) is asked again. `data` empties the account
// and keeps it; `account` removes it — every session with it, this one
// included. Answers what was done and what this server could not reach.
const failures = new Map<string, { count: number; reset: number }>();

me.post("/erase", async (c) => {
  if (viaApiToken(c)) return c.json({ error: "session_required" }, 403);
  const id = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  const scope: EraseScope | null = body?.scope === "data" || body?.scope === "account" ? body.scope : null;
  if (!scope) return c.json({ error: "bad_scope" }, 400);

  const user = getUser(id);
  const creds = getUserById(id);
  if (!user || !creds) return c.json({ error: "User not found" }, 404);

  const now = Date.now();
  const f = failures.get(id);
  if (f && now < f.reset && f.count >= 5) return c.json({ error: "too_many_attempts" }, 429);
  const refuse = (error: string) => {
    const b = f && now < f.reset ? f : { count: 0, reset: now + 15 * 60 * 1000 };
    b.count++;
    failures.set(id, b);
    return c.json({ error }, 403);
  };

  if (String(body?.confirm ?? "").trim() !== user.username) return refuse("confirm_mismatch");
  if (creds.password_hash) {
    if (!body?.password || !(await verifyPassword(String(body.password), creds.password_hash))) return refuse("bad_password");
  } else if (creds.pin_hash) {
    if (!body?.pin || !(await verifyPin(String(body.pin), creds.pin_hash))) return refuse("bad_pin");
  }
  failures.delete(id);

  try {
    return c.json(await eraseMember(id, scope));
  } catch (e: any) {
    if (e instanceof EraseError) return c.json({ error: e.code }, e.code === "last_admin" ? 409 : 404);
    console.error(`[erase] failed: ${e?.message ?? e}`);
    return c.json({ error: "Erase failed" }, 500);
  }
});

// ── The garden as a git address (routes/git.ts) ─────────────────
// GET /api/me/git — { url, username, token }: where to clone the member's
// garden from and the password to give. The token is scope `git`, opens the
// clone and nothing else, and is kept recoverable so every device shows the
// same one. POST /api/me/git/rotate replaces it (the old one stops working).

const GIT_TOKEN_LABEL = "git-clone";

async function gitAccess(c: Context, rotate: boolean) {
  const userId = c.get("userId");
  const user = getUser(userId);
  if (!user) return c.json({ error: "no_user" }, 404);
  if (!isGardenDir(join(gardensRoot(), user.username))) return c.json({ error: "no_garden" }, 404);
  let token = rotate ? null : getRawApiToken(userId, GIT_TOKEN_LABEL);
  if (!token) {
    for (const t of listApiTokens(userId)) if (t.label === GIT_TOKEN_LABEL) revokeApiToken(t.id, userId);
    token = (await createApiToken(userId, GIT_TOKEN_LABEL, "git", true)).rawToken;
  }
  return c.json({
    url: `${requestOrigin(c.req)}/git/${user.username}.git`,
    username: user.username,
    token,
    export_conversations: exportsConversations(userId),
  });
}

me.get("/git", (c) => gitAccess(c, false));
me.post("/git/rotate", (c) => gitAccess(c, true));

// PUT /api/me/git/export { conversations: boolean } — whether the night's
// export writes the member's conversations into their garden.
me.put("/git/export", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body?.conversations !== "boolean") return c.json({ error: "conversations_boolean" }, 400);
  setExportsConversations(c.get("userId"), body.conversations);
  return c.json({ export_conversations: exportsConversations(c.get("userId")) });
});

// ── GET /api/me/budget ──────────────────────────────────────────
// The household's budget, as the app's ring shows it: whether one applies,
// the fraction of it left (0…1), what kind it is (a prepaid balance or a
// monthly budget), when a monthly one starts afresh, and the period the app's
// 20/10/5 % alerts are counted in. The same for every member, never an amount
// in euros — except to the admin, who pays, and is given `left_eur`.
// {limited:false, left:null, …} when nothing limits the household.

me.get("/budget", (c) => c.json(householdBudget(getUser(c.get("userId"))?.role === "admin")));

// ── /api/me/ai-consent ──────────────────────────────────────────
// The providers outside the house that this member's data can reach — the
// models they may chat with, the household's models for background work, the
// one that transcribes dictation, the one the search index embeds with — and
// the member's answer about them (services/aiConsent.ts). `needs_answer` is
// what the apps show the consent screen on: no answer yet, or a yes that does
// not cover a provider in use. A no stands until the member changes it.

export function providersInUse(userId: string): string[] {
  const ids = new Set<string>();
  for (const m of availableModelsForUser(userId)) if (m.tier !== "local") ids.add(m.provider);
  const fallback = householdDefaultModel();
  if (fallback) ids.add(getModel(fallback)?.provider ?? "");
  for (const row of ancillaryTable()) ids.add(getModel(row.effective)?.provider ?? "");
  if (dictationEngine() === "scaleway") ids.add("scaleway");
  const embed = embeddingProvider();
  if (embed) ids.add(embed);
  if (getHouseholdConfig().falApiKey) ids.add("fal");
  return [...ids].filter((p) => p && !isLocalProvider(p)).sort();
}

function consentView(userId: string) {
  const inUse = providersInUse(userId);
  const record = getConsent(userId);
  const missing = uncovered(userId, inUse);
  return {
    record,
    providers: inUse.map(providerInfo),
    needs_answer: !record || (record.status === "accepted" && missing.length > 0),
    uncovered: record?.status === "accepted" ? missing : [],
  };
}

me.get("/ai-consent", (c) => c.json(consentView(c.get("userId"))));

// PUT { status: "accepted" | "declined", providers?: string[] } — `providers`
// is the list the member was shown; only providers this household uses are
// kept. Withdrawing is a PUT with "declined".
me.put("/ai-consent", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { status?: string; providers?: unknown };
  if (body.status !== "accepted" && body.status !== "declined") {
    return c.json({ error: "status must be 'accepted' or 'declined'" }, 400);
  }
  const userId = c.get("userId");
  const inUse = new Set(providersInUse(userId));
  const shown = Array.isArray(body.providers)
    ? body.providers.filter((p): p is string => typeof p === "string")
    : [...inUse];
  setConsent(userId, body.status, shown.filter((p) => inUse.has(p)));
  return c.json(consentView(userId));
});

export default me;
