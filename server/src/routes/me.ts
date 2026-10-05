// /api/me — what the signed-in member may know about themselves that no
// other route carries. (Their profile is /api/users/me.)
import { Hono } from "hono";
import type { Context } from "hono";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { requireAuth } from "../middleware/auth";
import { ArchiveError } from "../services/archive";
import { verifyPassword, verifyPin } from "../services/auth";
import { usageFor } from "../services/budget";
import { uploadsDir } from "../services/chatImport";
import { importMember, memberExportResponse } from "../services/memberArchive";
import { EraseError, eraseMember, type EraseScope } from "../services/memberErase";
import { getUserById, getUser } from "../services/users";

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

export default me;
