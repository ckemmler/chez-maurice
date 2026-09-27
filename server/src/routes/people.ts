import { Hono } from "hono";
import { existsSync } from "node:fs";
import { gardenFor, type GardenRef } from "../../data-api/services/gardenFiche";
import { requireAuth } from "../middleware/auth";
import { mailToolCall } from "../services/mailScan";
import { isGuest } from "../services/users";
import { ReviewError, personView, review, type Action, type Target } from "../services/personReview";

// The member's word on their person fiches (services/personReview.ts, lot 4
// of specs/contacts.md), and the source of a line (the `maurice-mail:` links
// the mail pass writes). Every route acts on the caller's own garden and
// mailboxes: there is no admin path to another member's.
//
//   GET  /api/people/:locale/:basename           the fiche, element by element
//   POST /api/people/:locale/:basename/review    { target, action, id?, text? }
//   GET  /api/people/mail/:id                    one message, as a page
//
// The fiche's page in the web garden calls the first two from the browser,
// with the session cookie; the third is where a `maurice-mail:` link goes.

const people = new Hono();

// The fiche's page calls these from the browser with the session cookie,
// which the app-wide proxyAuth has already resolved (as for the owner's
// toolbar, /api/v1/garden-tools); a Bearer token, from the app, goes
// through requireAuth as everywhere else.
people.use("/*", async (c, next) => (c.get("userId") ? next() : requireAuth(c, next)));

/** The caller's own garden, or the response that refuses — a guest has none. */
function mine(c: any): GardenRef | Response {
  const memberId = c.get("userId") as string;
  if (isGuest(memberId)) return c.json({ error: "Forbidden" }, 403);
  const garden = gardenFor(memberId);
  if (!garden || !existsSync(garden.root)) return c.json({ error: "No garden" }, 404);
  return garden;
}

function fail(c: any, err: unknown) {
  if (err instanceof ReviewError) return c.json({ error: err.message }, err.status);
  throw err;
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** The body between the tool's untrusted markers, without them. */
function plainBody(wrapped: string): string {
  const lines = String(wrapped ?? "").split("\n");
  const start = lines.findIndex((l) => l.startsWith("----- BEGIN UNTRUSTED"));
  const end = lines.findIndex((l, i) => i > start && l.startsWith("----- END UNTRUSTED"));
  return start >= 0 ? lines.slice(start + 1, end > start ? end : undefined).join("\n") : String(wrapped ?? "");
}

/** One message of the member's own mail, by the id a source link carries:
 *  headers and text, escaped — a page to check a line against, nothing to
 *  act on. */
people.get("/mail/:id", async (c) => {
  if (isGuest(c.get("userId"))) return c.json({ error: "Forbidden" }, 403);
  const id = decodeURIComponent(c.req.param("id"));
  let r: any;
  try {
    r = await mailToolCall(c.get("userId"), "get_by_id", { id, max_bytes: 60000 });
  } catch (err) {
    return c.html(`<!doctype html><meta charset="utf-8"><p>${esc((err as Error).message)}</p>`, 502);
  }
  if (r?.error || r?.raw) return c.html(`<!doctype html><meta charset="utf-8"><p>${esc(r.error ?? r.raw)}</p>`, 404);
  const list = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v ?? ""));
  const rows = [["De", list(r.from)], ["À", list(r.to)], ["Cc", list(r.cc)], ["Date", r.date], ["Boîte", r.account]]
    .filter(([, v]) => v).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("");
  return c.html(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(r.subject || "Message")}</title>
<style>
:root{color-scheme:light dark;--ink:#222;--mute:#777;--bg:#fbf8f3;--rule:#e3ddd2}
@media (prefers-color-scheme:dark){:root{--ink:#e8e4dc;--mute:#9a958c;--bg:#1d1c1a;--rule:#3a3833}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:20px;margin:0 0 12px}
table{border-collapse:collapse;margin-bottom:16px;font-size:13px}
th{text-align:left;color:var(--mute);font-weight:500;padding:2px 12px 2px 0;vertical-align:top}
pre{white-space:pre-wrap;word-wrap:break-word;font:14px/1.55 ui-monospace,Menlo,monospace;border-top:1px solid var(--rule);padding-top:16px}
p.note{color:var(--mute);font-size:12px}
</style></head><body><main>
<h1>${esc(r.subject || "(sans objet)")}</h1>
<table>${rows}</table>
<pre>${esc(plainBody(r.body))}</pre>
${r.body_truncated ? `<p class="note">Le texte est coupé.</p>` : ""}
</main></body></html>`);
});

people.get("/:locale/:basename", (c) => {
  const garden = mine(c);
  if (garden instanceof Response) return garden;
  try {
    return c.json(personView(garden, c.req.param("locale"), c.req.param("basename")));
  } catch (err) {
    return fail(c, err);
  }
});

people.post("/:locale/:basename/review", async (c) => {
  const garden = mine(c);
  if (garden instanceof Response) return garden;
  const body = await c.req.json().catch(() => ({}));
  try {
    const view = review(c.get("userId"), garden, c.req.param("locale"), c.req.param("basename"), {
      target: body?.target as Target, action: body?.action as Action,
      id: body?.id != null ? String(body.id) : undefined, text: typeof body?.text === "string" ? body.text : undefined,
    });
    return c.json({ ok: true, view });
  } catch (err) {
    return fail(c, err);
  }
});

export default people;
