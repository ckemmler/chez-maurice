import { defineMiddleware } from "astro:middleware";
import { runInGarden } from "@app/lib/garden-context";

/**
 * Who this request is for, and where their garden hangs.
 *
 * Both come from the Bun proxy, per request: `X-Maurice-Garden` names the
 * member and `X-Maurice-Base` the prefix they are served under (`/g/<member>`).
 * One built engine therefore serves a whole household, where an engine told
 * once by a `GARDEN` environment variable needed one process per member. With
 * no headers — a bare `astro dev`, a static publish — the environment answers
 * and nothing changes.
 *
 * The base matters because templates, note bodies and the wikilink resolver
 * all emit root-absolute links like `/notes/foo`. Astro prefixes its own asset
 * URLs, but not these author-written ones, so the final HTML is rewritten once
 * here: source stays clean and resolves to the member's root.
 */

// Paths that must NOT be prefixed: Vite/Astro internals (modules, source,
// deps), and `/api/…` — the Maurice server's own routes, which live at the
// root whatever garden is being read. A note written by Maurice carries
// `![](/api/images/<name>)`, and prefixing that produced
// `/g/<member>/api/images/<name>`, which the engine answered 404: every note
// illustration was broken in a member's garden.
const SKIP = /^\/(@|_astro\/|\.astro\/|src\/|node_modules\/|api\/|\.well-known\/)/;

// The active theme when none is chosen (no ?theme / cookie / THEME env). The
// internal "default" theme is the hidden view-base, not a user-facing look —
// fresh gardens land on a real garden theme.
const DEFAULT_THEME = process.env.THEME || "manuscript";

export const onRequest = defineMiddleware(async (ctx, next) => {
  const req = ctx.request.headers;
  const member = req.get("x-maurice-garden") || process.env.GARDEN || "demo";
  const BASE = (req.get("x-maurice-base") ?? process.env.GARDEN_BASE ?? "").replace(/\/+$/, "");
  const owner = req.get("x-maurice-owner") === "1" || process.env.GARDEN_OWNER === "1";
  const shared = req.get("x-maurice-shared") === "1";
  ctx.locals.member = member;

  // Which look to render, most specific first:
  //   1. ?theme=X — a reader trying one on, remembered in a cookie;
  //   2. that cookie, for the rest of their visits;
  //   3. X-Maurice-Theme — what the garden's OWNER chose in the app
  //      (garden_settings.web_theme, which the engine used to ignore entirely,
  //      so the Settings picker appeared to do nothing);
  //   4. the household default (THEME), then a real garden theme.
  // None of this rebuilds anything, which is the point.
  const q = new URL(ctx.request.url).searchParams.get("theme");
  if (q) ctx.cookies.set("theme", q, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  ctx.locals.theme =
    q || ctx.cookies.get("theme")?.value || req.get("x-maurice-theme") || DEFAULT_THEME;

  // Owner mode: the garden's owner is looking at their own garden — drafts,
  // private notes and the toolbar are theirs. The proxy decides (session user
  // == garden slug) and strips any such header a client sent. GARDEN_OWNER=1
  // makes a bare `astro dev` behave as the owner; a static build has no
  // request and is never owner.
  ctx.locals.owner = owner;
  // A note page another member may read because it was shared with them.
  ctx.locals.shared = shared;

  // Everything rendered below — including every file the content readers
  // touch — runs as this member (see lib/garden-context.ts).
  const res = await runInGarden({ member, base: BASE, owner, shared }, () => next());

  const ct = res.headers.get("content-type") || "";
  const isHtml = ct.includes("text/html");
  // The active theme is per-request (cookie / ?theme=) and each theme inlines
  // its own CSS into the page, so a cached HTML page pins a stale theme (you'd
  // see the right per-theme background from the inline block but stale fonts /
  // links). Forbid caching of the SSR HTML — assets keep their own caching.
  if (isHtml) res.headers.set("Cache-Control", "no-store");

  if (!BASE || !isHtml) return res;

  // A root-absolute URL that should stay as-is: protocol-relative, already
  // based, or a Vite/Astro dev internal.
  const based = (url: string) =>
    url.startsWith("//") || url === BASE || url.startsWith(BASE + "/") || SKIP.test(url);

  const html = await res.text();
  const rewritten = html
    .replace(/\b(href|src)="(\/[^"]*)"/g, (m, attr, url) =>
      based(url) ? m : `${attr}="${BASE}${url}"`)
    // CSS url(/path) in inline styles — note background-images (MOC headers,
    // moc-cards) aren't href/src attributes, so they'd otherwise stay base-less.
    .replace(/url\((['"]?)(\/[^"')]+)\1\)/g, (m, q, url) =>
      based(url) ? m : `url(${q}${BASE}${url}${q})`);

  const headers = new Headers(res.headers);
  headers.delete("content-length"); // body length changed
  return new Response(rewritten, { status: res.status, headers });
});
