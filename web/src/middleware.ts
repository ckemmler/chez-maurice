import { defineMiddleware } from "astro:middleware";

/**
 * Garden base-path rewriter.
 *
 * A member's garden is served under /g/<member>/ on the private tunnel
 * (GARDEN_BASE), but templates, note content, and the wikilink resolver all
 * emit root-absolute links like `/notes/foo`. Astro prefixes its own
 * asset/route URLs with `base`, but not these author-written ones. Rather than
 * touch dozens of templates (and every future link), this rewrites the final
 * HTML once: absolute internal href/src get the base prefix, so source stays
 * clean yet resolves to the member's root.
 *
 * No-op when GARDEN_BASE is unset — Candide's tunnel and every public build run
 * at root, so candide.me is untouched.
 */
const BASE = (process.env.GARDEN_BASE || "").replace(/\/+$/, "");

// Paths that must NOT be prefixed: protocol-relative, and Vite/Astro dev
// internals (modules, source, deps) which are always served from the root.
const SKIP = /^\/(@|_astro\/|\.astro\/|src\/|node_modules\/|\.well-known\/)/;

// The active theme when none is chosen (no ?theme / cookie / THEME env). The
// internal "default" theme is the hidden view-base, not a user-facing look —
// fresh gardens land on a real garden theme.
const DEFAULT_THEME = process.env.THEME || "manuscript";

export const onRequest = defineMiddleware(async (ctx, next) => {
  // Per-request theme selection: ?theme=X sets a year-long cookie and wins;
  // otherwise the cookie; otherwise the build default. This is what enables live
  // theme switching without a rebuild (the shims read ctx.locals.theme).
  const q = new URL(ctx.request.url).searchParams.get("theme");
  if (q) ctx.cookies.set("theme", q, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  ctx.locals.theme = q || ctx.cookies.get("theme")?.value || DEFAULT_THEME;

  const res = await next();

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
