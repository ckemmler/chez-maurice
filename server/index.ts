import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { gardensRoot } from "./src/services/gardensRoot";

// ── Load .env before any other imports that read env ─────────────────────
// Two locations, first-wins (and an already-set env var always wins):
//   1. ~/.maurice/.env  — the user config file (next to config.toml); this is
//      where an installed (.pkg) server reads its config, e.g. TLS settings.
//   2. ../.env          — repo-root, for a from-source / dev run.
function loadEnvFile(envPath: string): void {
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key.startsWith("#")) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
loadEnvFile(resolve(process.env.HOME || "", ".maurice", ".env"));
loadEnvFile(resolve(process.cwd(), "../.env"));

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { getPort } from "./data-api/lib/config";

// ── Maurice core imports ─────────────────────────────────────────────────
import auth from "./src/routes/auth";
import users from "./src/routes/users";
import files from "./src/routes/files";
import conversations from "./src/routes/conversations";
import reports from "./src/routes/reports";
import admin from "./src/routes/admin";
import webAdmin from "./src/routes/web-admin";
import webLogin from "./src/routes/web-login";
import composer from "./src/routes/composer";
import gardens from "./src/routes/gardens";
import gardenTools from "./src/routes/gardenTools";
import { maybeRegenerateAdherence } from "./src/services/gardenTools";
import { localiseRemoteImages } from "./src/services/gardenImages";
import { gardenTheme, isNoteSharedWith, gardenFor } from "./src/services/gardens";
import maurices from "./src/routes/maurices";
import models from "./src/routes/models";
import toolFamilies from "./src/routes/toolFamilies";
import { adminExists, getUser, getUserByUsername, householdName, householdInfo } from "./src/services/users";
import { refreshAutoPins, seedAncillaryPinsOnce } from "./src/services/ancillary";
import { dataDir } from "./src/db";
import { imagesDir } from "./src/services/images";
import { avatarsDir } from "./src/services/avatars";
import { proxyAuth, validateApiTokenRaw, validateHealthToken } from "./src/middleware/auth";
import { fullHealth, hookConsoleErrors, publicHealth, recordError } from "./src/services/health";
import { validateSession } from "./src/services/auth";
import { isParticipant } from "./src/services/conversations";
import { setRoomPublisher, setSubscriberCount, roomTopic, userTopic } from "./src/services/roomBus";

// ── Data-API route imports (from akita) ──────────────────────────────────
import sleep from "./data-api/routes/health/sleep";
import meditation from "./data-api/routes/health/meditation";
import workouts from "./data-api/routes/health/workouts";
import activeEnergy from "./data-api/routes/health/active-energy";
import hrv from "./data-api/routes/health/hrv";
import respiratoryRate from "./data-api/routes/health/respiratory-rate";
import health from "./data-api/routes/health/index";
import calibre from "./data-api/routes/calibre/index";
import trackPlans from "./data-api/routes/tracks/plans";
import { noPathTraversal } from "./data-api/middleware/noPathTraversal";
import tracksUi from "./data-api/routes/tracks/ui";
import reportsUi from "./data-api/routes/tracks/reports";
import articlesUi from "./data-api/routes/articles";
import booksUi from "./data-api/routes/books";
import dossierRoutes from "./data-api/routes/dossiers";
import tasks from "./data-api/routes/tasks";
import signalsPost from "./data-api/routes/signals";
import uploads from "./data-api/routes/uploads";
import articlesScrape from "./data-api/routes/articles-api";
import gardenArticles from "./data-api/routes/garden-articles";
import gardenEntries from "./data-api/routes/garden-entries";
import gardenLinks from "./data-api/routes/garden-links";
import gardenCards from "./data-api/routes/garden-cards";
import bankTransactions from "./data-api/routes/bank-transactions";
import compte from "./data-api/routes/compte";
import places from "./data-api/routes/places";
import coaching from "./data-api/routes/coaching";
import layouts from "./data-api/routes/layouts";
import dashboard from "./data-api/routes/dashboard";

const app = new Hono();

// Every console.error from here on is one tick on /healthz's error counter.
hookConsoleErrors();

// ── Middleware ───────────────────────────────────────────────────

app.use("/*", logger());

// Errors that escape a route: log the tag, count it, answer 500. Without this
// Hono answers 500 silently and the operator never learns the rate.
app.onError((err, c) => {
  console.error(`[http] ${c.req.method} ${c.req.path}:`, err?.message);
  return c.json({ error: "Internal error" }, 500);
});
app.use("/*", async (c, next) => {
  await next();
  if (c.res.status >= 500) recordError(`http-${c.res.status}`);
});
app.use(
  "/*",
  cors({
    origin: (origin?: string) => {
      if (!origin) return "*";
      if (origin.endsWith("claude.ai")) return origin;
      if (origin.endsWith(".chezmaurice.eu") || origin === "https://chezmaurice.eu") return origin;
      if (
        origin.startsWith("http://localhost") ||
        origin.startsWith("http://192.168.") ||
        origin.includes(".ts.net")
      ) {
        return origin;
      }
      return "";
    },
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-API-Key"],
    exposeHeaders: ["Content-Type"],
    credentials: true,
  }),
);

app.use("/*", proxyAuth);

// ── Require authentication for all data routes ───────────────────
// proxyAuth is permissive (passes through unauthenticated requests for
// public endpoints like /healthz, /admin, /api/auth).  Data routes under
// /api/v1/* always need an authenticated member.
app.use("/api/v1/*", async (c, next) => {
  if (!c.get("userId")) {
    return c.json({ error: "Authentication required" }, 401);
  }
  await next();
});

// Member garden engine instances: /g/<member>/… proxies to that member's dev
// server. Sourced from web/gardens/gardens.json (members with a /g/ base);
// Candide is the root fallback (webPort), so he's not in this map.
// The household's gardens, from the manifest. It used to carry a port per
// member because each ran its own engine; one engine serves them all now, so
// all this answers is "does <member> have a garden here".
//
// Via gardensRoot(), like every other reader of this tree: hardcoding the repo
// path meant the manifest could not follow MAURICE_GARDENS_DIR, so the one file
// naming a household's members had to live inside the checkout — where every
// branch switch restored the public demo placeholder and 404'd every garden.
const GARDEN_MEMBERS: Set<string> = (() => {
  try {
    const manifest = JSON.parse(
      readFileSync(join(gardensRoot(), "gardens.json"), "utf8"),
    ) as Record<string, { base?: string }>;
    return new Set(
      Object.entries(manifest)
        .filter(([, cfg]) => cfg.base?.startsWith("/g/"))
        .map(([member]) => member),
    );
  } catch (err) {
    console.error("[gardens] could not load gardens.json:", (err as Error).message);
    return new Set<string>();
  }
})();
// Bring home any cover image still pointing at someone else's server. Once,
// a few seconds after boot, so it never delays a start; the writers handle
// what they write, this catches the rest (see services/gardenImages.ts).
setTimeout(() => {
  for (const member of GARDEN_MEMBERS) {
    const garden = { root: join(gardensRoot(), member), username: member };
    localiseRemoteImages(garden)
      .then((n) => { if (n) console.log(`[gardens] localised ${n} image reference(s) for ${member}`); })
      .catch((err) => console.error(`[gardens] image sweep failed for ${member}:`, (err as Error).message));
  }
}, 5000).unref?.();

/** Is this a member whose garden the household serves? */
function gardenExists(member: string): boolean {
  return GARDEN_MEMBERS.has(member);
}

function gardenSlug(path: string): string | null {
  return path.match(/^\/g\/([^/]+)(?:\/|$)/)?.[1] ?? null;
}

// ── Gate the web surface (garden + dossiers + dev-server source) ─────
// The proxied Astro dev server serves notes UNencrypted (encryption is a
// build-only step) and exposes raw /src + /@id modules, so the tunnel must be
// members-only. Require an authenticated session for everything that isn't an
// API route (those self-authenticate), the login/admin pages, health, or the
// MCP gateway's own OAuth endpoints. Auth comes from the maurice_session cookie
// (set via /login?token=…) or a Bearer token, both resolved by proxyAuth.
app.use("/*", async (c, next) => {
  const path = c.req.path;
  const open =
    path.startsWith("/api/") ||
    path === "/healthz" ||
    path.startsWith("/login") ||
    path.startsWith("/admin") ||
    path.startsWith("/mcp") ||
    path === "/authorize" ||
    path === "/token" ||
    path === "/register" ||
    path.startsWith("/.well-known/oauth-") ||
    (path.startsWith("/setup") && !adminExists());
  if (open) return next();

  if (!c.get("userId")) {
    // Unauthenticated. Members reach the garden via the app's "open in browser"
    // link (which sets the maurice_session cookie); there's no remote login form
    // (web-admin is localhost-only). Short explainer to browsers, 401 otherwise.
    if (c.req.method === "GET" && (c.req.header("accept") || "").includes("text/html")) {
      return c.html(privatePage(), 401);
    }
    return c.json({ error: "Authentication required" }, 401);
  }

  // A member's garden under /g/<member>/ is private to that member — widened
  // by per-note sharing: another (non-guest) household member may open a note
  // PAGE that's shared with them, plus the page's subresources (scripts, css,
  // dev-server modules — anything that isn't a top-level document navigation).
  const slug = gardenSlug(path);
  if (slug) {
    const me = getUser(c.get("userId"));
    if (!me) return c.json({ error: "Forbidden" }, 403);
    if (me.username !== slug) {
      if (me.role === "guest") return c.json({ error: "Forbidden" }, 403);
      const owner = getUserByUsername(slug);
      if (!owner) return c.json({ error: "Forbidden" }, 403);
      // (The garden engine used to serve unauthenticated /_dev/* write tools,
      // guarded here. They are /api/v1/garden-tools now, which acts on the
      // caller's own garden and cannot be aimed at another member's.)

      const note = path.match(/^\/g\/[^/]+(?:\/[a-z]{2})?\/notes\/([a-z0-9-]+)\/?$/)?.[1];
      if (note) {
        if (!isNoteSharedWith(owner.id, note, me.id)) {
          return c.json({ error: "Forbidden" }, 403);
        }
      } else {
        // Only block document navigations — a shared note page may pull any
        // of the garden's assets, which don't leak more than the page does.
        const dest = c.req.header("sec-fetch-dest");
        const isDoc = dest ? dest === "document" : (c.req.header("accept") || "").includes("text/html");
        if (isDoc) return c.json({ error: "Forbidden" }, 403);
      }
    }
  }
  return next();
});

function privatePage(): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chez Maurice — Private</title>
<style>
  body { font-family: ui-serif, Georgia, serif; max-width: 30rem; margin: 18vh auto; padding: 0 1.5rem; color: #2a2622; background: #f5efe6; }
  h1 { font-size: 1.5rem; font-weight: 400; margin: 0 0 .5rem; }
  p { color: #6b6358; line-height: 1.6; font-size: .98rem; }
  code { font-family: ui-monospace, monospace; background: #ece3d6; padding: .1rem .35rem; border-radius: 4px; }
</style></head><body>
  <h1>This garden is private</h1>
  <p>Open it from the Maurice app (Settings → open in browser) to sign in, then this link will work for 30 days.</p>
</body></html>`;
}

// ── Maurice core routes ──────────────────────────────────────────

app.route("/api/auth", auth);
app.route("/api/users", users);
app.route("/api/files", files);
app.route("/api/conversations", conversations);
app.route("/api/reports", reports);
app.route("/api/maurices", maurices);
app.route("/api/models", models);
app.route("/api/tool-families", toolFamilies);
app.route("/api/admin", admin);
app.route("/admin", webAdmin);
app.route("/login", webLogin);
app.route("/api/v1/gardens", gardens);
app.route("/api/v1/garden-tools", gardenTools);

// ── Shared garden on the web ─────────────────────────────────────
// The garden IS a website: a shared set's "root note" is, by default, a plain
// list of everything the audience tends — rendered here (members-gated above).
// Each entry links to the note's page on its owner's garden site, which the
// /g/ gate admits because the note is shared with the viewer.
app.get("/gardens/:id", (c) => {
  const me = c.get("userId");
  if (!me) return c.json({ error: "Authentication required" }, 401);
  const id = decodeURIComponent(c.req.param("id"));
  if (!id.split("+").includes(me)) return c.json({ error: "Forbidden" }, 403);
  const garden = gardenFor(me, id);
  if (!garden) return c.json({ error: "Not found" }, 404);

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const names = garden.members.map((m) => m.display_name);
  const title = names.length > 1 ? names.join(" & ") : `${names[0] ?? "?"} — garden`;
  const items = garden.notes
    .map(
      (n) =>
        `<li><a href="${esc(n.web_path)}">${esc(n.title)}</a>` +
        `<span class="meta">${esc(n.owner_username)}${n.updated_at ? " · " + esc(n.updated_at.slice(0, 10)) : ""}</span></li>`,
    )
    .join("\n      ");
  return c.html(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Chez Maurice</title>
<style>
  body { font-family: ui-serif, Georgia, serif; max-width: 38rem; margin: 10vh auto; padding: 0 1.5rem; color: #2a2622; background: #f5efe6; }
  h1 { font-size: 1.7rem; font-weight: 400; margin: 0 0 .25rem; }
  .sub { color: #8a8074; font-family: ui-monospace, monospace; font-size: .75rem; letter-spacing: .08em; text-transform: uppercase; }
  ul { list-style: none; padding: 0; margin: 2rem 0; }
  li { display: flex; align-items: baseline; gap: .75rem; padding: .55rem 0; border-bottom: 1px solid #e4dccd; }
  a { color: #2a2622; text-decoration: none; border-bottom: 1px solid #c9bda6; }
  a:hover { border-bottom-color: #2a2622; }
  .meta { margin-left: auto; color: #8a8074; font-family: ui-monospace, monospace; font-size: .72rem; white-space: nowrap; }
  p.hint { color: #6b6358; font-size: .9rem; }
</style></head><body>
  <h1>${esc(title)}</h1>
  <div class="sub">${garden.notes.length} note${garden.notes.length === 1 ? "" : "s"} · shared garden</div>
  <ul>
      ${items || "<li><span class='meta'>Nothing here yet — share a note to start this garden.</span></li>"}
  </ul>
  <p class="hint">This is the garden's root note — a plain list, until someone redesigns it.</p>
</body></html>`);
});

// ── Serve generated images ──────────────────────────────────

app.get("/api/images/:filename", (c) => {
  const filename = c.req.param("filename");
  if (filename.includes("/") || filename.includes("..")) {
    return c.json({ error: "Invalid filename" }, 400);
  }
  const filePath = join(imagesDir, filename);
  if (!existsSync(filePath)) {
    return c.json({ error: "Not found" }, 404);
  }
  const file = readFileSync(filePath);
  const ext = extname(filename).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "application/octet-stream";
  return new Response(file, {
    headers: { "Content-Type": mime, "Cache-Control": "public, max-age=86400" },
  });
});

// ── Serve member avatars (no auth, like images, so AsyncImage can load them) ──

app.get("/api/avatars/:filename", (c) => {
  const filename = c.req.param("filename");
  if (filename.includes("/") || filename.includes("..")) {
    return c.json({ error: "Invalid filename" }, 400);
  }
  const filePath = join(avatarsDir, filename);
  if (!existsSync(filePath)) {
    return c.json({ error: "Not found" }, 404);
  }
  const file = readFileSync(filePath);
  const ext = extname(filename).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "application/octet-stream";
  return new Response(file, {
    headers: { "Content-Type": mime, "Cache-Control": "public, max-age=86400" },
  });
});

// ── Serve garden cover art (no auth, like avatars, so AsyncImage can load it) ──
// The app's fiche card shows a downloaded poster. The garden itself serves these
// under /g/<member>/images/…, but that path is session-gated and AsyncImage
// sends no credentials — hence this /api/ mirror, which the gate treats as open.
//
// Rooted at images/RESOURCES, not images/: the sibling images/notes holds the
// illustrations of private notes, and this route has no authentication at all.
// Cover art is already public-facing metadata; a member's note images are not.
// A garden's own images, read off disk at request time.
//
// Note bodies and MOC cards point at `/images/<member>/notes/<file>` and
// `/images/<member>/resources/…`. Those used to be served by the engine out of
// its `public/` dir, through a symlink into the garden — which stopped working
// when the engine became a build: `public/` is copied into the bundle at build
// time, and the publish step prunes note art out of it (rightly — that build
// also feeds the public site). Every note illustration 404'd.
//
// Serving them here fixes more than the 404: an image added after the build
// appears immediately, like every other thing in a garden. The engine's
// symlinks now matter only to the static publish.
//
// Who may see what: your own garden's images entirely; anyone else's only
// under `resources/`, which is cover art — the same line /api/garden-images
// draws, and the reason `images/notes` is not on it.
app.get("/images/:member/*", (c) => {
  const member = c.req.param("member");
  const rest = c.req.path.split(`/images/${member}/`)[1] || "";
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(member) || rest.includes("..")) {
    return c.json({ error: "Invalid path" }, 400);
  }
  const me = getUser(c.get("userId"));
  if (!me) return c.json({ error: "Forbidden" }, 403);
  if (me.username !== member && !rest.startsWith("resources/")) {
    return c.json({ error: "Forbidden" }, 403);
  }
  const root = resolve(join(gardensRoot(), member, "images"));
  const filePath = resolve(join(root, rest));
  if (!filePath.startsWith(root + "/") || !existsSync(filePath) || !statSync(filePath).isFile()) {
    return c.json({ error: "Not found" }, 404);
  }
  const ext = extname(filePath).toLowerCase();
  const mime = ext === ".png" ? "image/png"
    : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
    : ext === ".webp" ? "image/webp"
    : ext === ".svg" ? "image/svg+xml"
    : ext === ".gif" ? "image/gif"
    : "application/octet-stream";
  return new Response(readFileSync(filePath), {
    // Private to a member: cache in their browser, never in a shared proxy.
    headers: { "Content-Type": mime, "Cache-Control": "private, max-age=3600" },
  });
});

app.get("/api/garden-images/:member/*", (c) => {
  const member = c.req.param("member");
  const rest = c.req.path.split(`/api/garden-images/${member}/`)[1] || "";
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(member) || rest.includes("..")) {
    return c.json({ error: "Invalid path" }, 400);
  }
  const root = resolve(join(gardensRoot(), member, "images", "resources"));
  const filePath = resolve(join(root, rest));
  // resolve() both sides: a decoded traversal must not escape the subtree.
  if (!filePath.startsWith(root + "/") || !existsSync(filePath)) {
    return c.json({ error: "Not found" }, 404);
  }
  const ext = extname(filePath).toLowerCase();
  const mime = ext === ".png" ? "image/png"
    : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
    : ext === ".webp" ? "image/webp"
    : "application/octet-stream";
  return new Response(readFileSync(filePath), {
    headers: { "Content-Type": mime, "Cache-Control": "public, max-age=86400" },
  });
});

// ── Web themes a member can pick for their garden (web/themes/<id>/theme.json) ──
app.get("/api/web-themes", (c) => {
  const dir = resolve(import.meta.dir, "../web/themes");
  const themes: { id: string; name: string; description?: string }[] = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name, "theme.json");
      if (!existsSync(p)) continue;
      try {
        const t = JSON.parse(readFileSync(p, "utf8"));
        // Offer every theme present on disk; skip only the hidden internal base.
        // A theme's privacy is the public-repo boundary (the maurice-web overlay
        // keeps `candide` off the public repo), not whether it's shown here — and
        // `kind` only controls the landing (site=hero home, garden=notes index).
        if (t.hidden === true) continue;
        themes.push({ id: t.id ?? name, name: t.name ?? name, description: t.description });
      } catch {}
    }
  }
  themes.sort((a, b) => (a.id === "default" ? -1 : b.id === "default" ? 1 : a.name.localeCompare(b.name)));
  return c.json({ themes });
});

// ── Data-API routes (health, signals, tasks, calibre, etc.) ──────

app.route("/api/v1/composer", composer);
app.route("/api/v1/health/sleep", sleep);
app.route("/api/v1/health/meditation", meditation);
app.route("/api/v1/health/workouts", workouts);
app.route("/api/v1/health/active-energy", activeEnergy);
app.route("/api/v1/health/hrv", hrv);
app.route("/api/v1/health/respiratory-rate", respiratoryRate);
app.route("/api/v1/health", health);
app.route("/api/v1/calibre", calibre);
app.use("/api/v1/tracks/plans/*", noPathTraversal);
app.use("/reports/*", noPathTraversal);
app.use("/tracks/*", noPathTraversal);
app.route("/api/v1/tracks/plans", trackPlans);
app.route("/tracks", tracksUi);
app.route("/reports", reportsUi);
app.route("/articles", articlesUi);
app.route("/books", booksUi);
app.route("/api/v1/tasks", tasks);
app.route("/api/v1/signals", signalsPost);
app.route("/api/v1/uploads", uploads);
app.route("/api/v1/articles", articlesScrape);
app.route("/api/v1/garden/articles", gardenArticles);
app.route("/api/v1/garden/links", gardenLinks);
app.route("/api/v1/garden/cards", gardenCards);
app.route("/api/v1/garden", gardenEntries);
app.route("/api/v1/bank-transactions", bankTransactions);
app.route("/api/v1/compte", compte);
app.route("/api/v1/places", places);
app.route("/api/v1/coaching/plans", coaching);
app.route("/api/v1/layouts", layouts);
app.route("/api/v1/dashboard", dashboard);
app.route("/", dossierRoutes);

// ── Reverse proxy: MCP gateway ─────────────────────────────────────
// /mcp/*            → gateway (prefix stripped) — the MCP endpoint itself
// OAuth 2.1 routes  → gateway (verbatim) — so Claude's "custom connector"
//                     can run the browser OAuth flow against magik.chezmaurice.eu
//
// The gateway runs at base-path / with OAuth routes at its root, and builds its
// public metadata URLs from X-Forwarded-Proto/Host, so discovery advertises the
// real edge origin rather than 127.0.0.1:8710.

const mcpPort = getPort("mcp-gateway");

async function proxyToGateway(c: any, gatewayPath: string): Promise<Response> {
  const target = new URL(c.req.url);
  target.protocol = "http:";
  target.hostname = "127.0.0.1";
  target.port = String(mcpPort);
  target.pathname = gatewayPath || "/";

  const fwdHost = c.req.header("x-forwarded-host") || c.req.header("host") || "localhost:3001";
  const fwdProto = c.req.header("x-forwarded-proto") || "https";

  const headers = new Headers(c.req.raw.headers);
  headers.set("host", `127.0.0.1:${mcpPort}`);
  headers.set("X-Forwarded-Host", fwdHost);
  headers.set("X-Forwarded-Proto", fwdProto);

  // Forward resolved member identity (Bearer maur_* path); OAuth tokens carry
  // their own member_id inside the gateway, so this is only a fallback.
  const memberId = c.get("userId");
  if (memberId) headers.set("X-Maurice-Member-Id", memberId);

  const resp = await fetch(
    new Request(target.toString(), {
      method: c.req.method,
      headers,
      body: c.req.raw.body,
      // Return the gateway's 3xx to the client instead of following it —
      // the OAuth /authorize step issues a 302 to the redirect_uri carrying
      // the auth code; following it here both loses the code and throws when
      // replaying the half-duplex body.
      redirect: "manual",
      // @ts-ignore — Bun supports duplex streaming
      duplex: "half",
    }),
  );
  return new Response(resp.body, { status: resp.status, headers: resp.headers });
}

// MCP endpoint + OAuth routes are all forwarded VERBATIM: the gateway serves
// MCP at base-path /mcp and its OAuth routes at root, so paths already match.
const GW_PATHS = [
  "/mcp",
  "/mcp/*",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/*",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/*",
  "/authorize",
  "/token",
  "/register",
];
for (const p of GW_PATHS) {
  app.all(p, (c) => proxyToGateway(c, c.req.path));
}

// ── Health / status ─────────────────────────────────────────────

app.get("/api/health", (c) => {
  const h = householdInfo();
  return c.json({
    status: "ok",
    version: "0.1.0",
    setup_complete: adminExists(),
    household: h.name,
    household_color: h.color,
    household_icon: h.icon,
  });
});

// Public face: enough for an uptime probe and for the apps' version check.
// With a `health`- or `full`-scoped maur_* token: the operator's full picture.
// No member data on either face — see src/services/health.ts.
app.get("/healthz", async (c) => {
  const auth = c.req.header("Authorization");
  const raw = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (raw && (await validateHealthToken(raw))) {
    const h = fullHealth();
    return c.json(h, h.status === "ok" ? 200 : 503);
  }
  return c.json(publicHealth());
});

// ── Reverse proxy: the garden engine ────────────────────────────
//
// ONE engine serves the whole household. It is told whose garden a request is
// for by a header, not by an environment variable — which is what let a
// household stop running one Astro process per member. The prefix is stripped
// here and put back by the engine's middleware, so the engine's own asset
// URLs (/_astro/…) live at the root and every member shares one build.

const webPort = getPort("web");
app.notFound(async (c) => {
  const slug = gardenSlug(c.req.path);
  const port = webPort;

  if (slug) {
    if (!gardenExists(slug)) return c.text("Garden not available", 404);
  } else {
    // No /g/<member>/ prefix. An HTML navigation → send the member to their
    // own garden. Engine assets (/src, /@vite, /@id, /_astro …) are referenced
    // at root by every page and must be served, not redirected.
    const isNav =
      c.req.method === "GET" && (c.req.header("accept") || "").includes("text/html");
    if (isNav) {
      const me = getUser(c.get("userId"));
      if (me) {
        const url = new URL(c.req.url);
        return c.redirect(`/g/${me.username}${url.pathname}${url.search}`);
      }
      return c.text("Not found", 404);
    }
    // else: fall through and proxy the asset from the default (webPort) instance.
  }

  // Strip /g/<member> before forwarding: the engine has no base of its own.
  const target = new URL(c.req.url);
  target.protocol = "http:";
  target.hostname = "127.0.0.1";
  target.port = String(port);
  if (slug) target.pathname = target.pathname.slice(`/g/${slug}`.length) || "/";

  // Owner mode for the engine: the session user is this garden's owner. The
  // header is ours alone — whatever a client sent under that name is dropped.
  // X-Maurice-Shared marks a note page another member may read because it
  // was shared with them (the auth middleware above already let it through).
  const headers = new Headers(c.req.raw.headers);
  headers.delete("x-maurice-owner");
  headers.delete("x-maurice-shared");
  headers.delete("x-maurice-garden");
  headers.delete("x-maurice-base");
  headers.delete("x-maurice-theme");
  if (slug) {
    // Whose garden, and the prefix its links must carry.
    headers.set("x-maurice-garden", slug);
    headers.set("x-maurice-base", `/g/${slug}`);
    // The look its owner picked in the app. `garden_settings.web_theme` was
    // written by the app and read by nobody: the engine chose a theme from
    // its own environment, so changing it in Settings did nothing at all.
    const owner = getUserByUsername(slug);
    if (owner) headers.set("x-maurice-theme", gardenTheme(owner.id));
  }
  if (slug && c.get("userId")) {
    const me = getUser(c.get("userId"));
    if (me && me.username === slug) {
      headers.set("x-maurice-owner", "1");
      maybeRegenerateAdherence(c.req.path, true);
    }
    else if (me) {
      const owner = getUserByUsername(slug);
      const note = c.req.path.match(/^\/g\/[^/]+(?:\/[a-z]{2})?\/notes\/([a-z0-9-]+)\/?$/)?.[1];
      if (owner && note && isNoteSharedWith(owner.id, note, me.id)) headers.set("x-maurice-shared", "1");
    }
  }

  try {
    const resp = await fetch(
      new Request(target.toString(), {
        method: c.req.method,
        headers,
        body: c.req.raw.body,
        // @ts-ignore
        duplex: "half",
      }),
    );
    return new Response(resp.body, { status: resp.status, headers: resp.headers });
  } catch {
    return c.text("Web server not available", 502);
  }
});

// ── TLS ──────────────────────────────────────────────────────────
// Point MAURICE_TLS_CERT / MAURICE_TLS_KEY at a cert + key (e.g. a Tailscale
// `tailscale cert` pair or Let's Encrypt). MAURICE_PUBLIC_HOST is the host the
// apps reach the server on; defaults to localhost for a plain local run.

const port = parseInt(process.env.PORT || "3001");
const certsDir = resolve(import.meta.dir, "certs");
const certFile = process.env.MAURICE_TLS_CERT || resolve(certsDir, "server.crt");
const keyFile = process.env.MAURICE_TLS_KEY || resolve(certsDir, "server.key");
const hasTls = existsSync(certFile) && existsSync(keyFile);

const publicHost = process.env.MAURICE_PUBLIC_HOST || "localhost";
const host = hasTls
  ? `https://${publicHost}:${port}`
  : `http://${publicHost}:${port}`;

// Give the ancillary functions their own models the first time this code runs
// on a household that has never pinned one: a dossier title has no business
// on the chat's flagship (services/ancillary.ts). Pins, so the admin sees
// them and the Python tools read the same table.
const seededPins = seedAncillaryPinsOnce();
if (seededPins.length) {
  console.log(`[ancillary] pinned ${seededPins.length} function(s) to a model their size`);
}
// And the ones this codebase chose on an earlier start follow its current
// advice — what the admin chose by hand never moves.
const movedPins = refreshAutoPins();
if (movedPins.length) {
  console.log(`[ancillary] moved ${movedPins.length} unchosen pin(s) onto what is advised now`);
}

console.log(`
  Chez Maurice server v0.1.0
  ${host}
  data: ${dataDir}
  tls: ${hasTls ? "tailscale" : "none"}
  setup: ${adminExists() ? "complete" : "open http://localhost:" + port + "/admin"}
  admin: http://localhost:${port}/admin
`);

/** True if the request carries a valid session — Bearer token or the
 *  maurice_session cookie (maur_* API token or an opaque session token). */
async function webSessionUser(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization");
  let token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : undefined;
  if (!token) {
    const cookie = req.headers.get("cookie") || "";
    token = cookie.match(/(?:^|;\s*)maurice_session=([^;]+)/)?.[1];
  }
  if (!token) {
    // Browsers (and the room WS clients) can't set an Authorization header on a
    // WebSocket, so accept a ?token= query param too.
    token = new URL(req.url).searchParams.get("token") ?? undefined;
  }
  if (!token) return null;
  if (token.startsWith("maur_")) return (await validateApiTokenRaw(token))?.userId ?? null;
  return validateSession(token)?.userId ?? null;
}

let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({
    port,
    hostname: "0.0.0.0",
    idleTimeout: 255,
    // Bun defaults to a 128 MB request body cap; ChatGPT/Claude data exports
    // bundle all media and routinely exceed that, which surfaces in the browser
    // as a bare "TypeError: Failed to fetch" on the import upload. Lift to 4 GB.
    maxRequestBodySize: 4 * 1024 * 1024 * 1024,
    async fetch(req, srv) {
      // Forward WebSocket upgrades to the garden engine.
      //
      // The built engine opens none — a page that wants to know its note
      // changed subscribes to /api/v1/garden-tools/events instead. This is for
      // developing the web UI: `npm run dev` in web/ behind this proxy, where
      // Vite's HMR client opens a socket the fetch-based proxy below cannot
      // carry (it looped reconnect→full-reload through the tunnel). The MCP
      // gateway streams over HTTP, so any upgrade reaching here is that.
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        // A dev socket can stream source modules — gate it on a session, and
        // scope a member's /g/<member>/ socket to that member.
        const sessionUser = await webSessionUser(req);
        if (!sessionUser) return new Response("Unauthorized", { status: 401 });
        const u = new URL(req.url);

        // Room channel: GET /api/conversations/<id>/ws — a participant subscribes
        // to live authored messages + Maurice's replies for that room.
        const roomMatch = u.pathname.match(/^\/api\/conversations\/([^/]+)\/ws$/);
        if (roomMatch) {
          const roomId = roomMatch[1]!;
          if (!isParticipant(roomId, sessionUser)) {
            return new Response("Forbidden", { status: 403 });
          }
          const ok = srv.upgrade(req, { data: { kind: "room", roomId, userId: sessionUser } });
          if (ok) return undefined;
          return new Response("WebSocket upgrade failed", { status: 426 });
        }

        // User channel: GET /api/me/ws — a member's global socket, open whatever
        // room they're in, for new-conversation + activity notifications.
        if (u.pathname === "/api/me/ws") {
          const ok = srv.upgrade(req, { data: { kind: "user", userId: sessionUser } });
          if (ok) return undefined;
          return new Response("WebSocket upgrade failed", { status: 426 });
        }

        const slug = gardenSlug(u.pathname);
        if (slug && getUser(sessionUser)?.username !== slug) {
          return new Response("Forbidden", { status: 403 });
        }
        const port = webPort; // one engine for the household
        const subprotocol = req.headers.get("sec-websocket-protocol") || undefined;
        const upstream = subprotocol
          ? new WebSocket(`ws://127.0.0.1:${port}${u.pathname}${u.search}`, subprotocol.split(",").map((s) => s.trim()))
          : new WebSocket(`ws://127.0.0.1:${port}${u.pathname}${u.search}`);
        const ok = srv.upgrade(req, { data: { kind: "hmr", upstream, queue: [] as (string | ArrayBufferLike)[] } });
        if (ok) return undefined;
        try { upstream.close(); } catch {}
        return new Response("WebSocket upgrade failed", { status: 426 });
      }
      return app.fetch(req, srv);
    },
    websocket: {
      idleTimeout: 960, // long-lived HMR socket; Vite sends its own keepalives
      open(ws) {
        const d = ws.data as any;
        if (d.kind === "room") {
          // Subscribe to the room topic; publishToRoom() fans messages here.
          ws.subscribe(roomTopic(d.roomId));
          return;
        }
        if (d.kind === "user") {
          // Global per-user channel; publishToUser() fans notifications here.
          ws.subscribe(userTopic(d.userId));
          return;
        }
        const flush = () => { for (const m of d.queue) { try { d.upstream.send(m); } catch {} } d.queue = []; };
        d.upstream.addEventListener("message", (e: MessageEvent) => { try { ws.send(e.data); } catch {} });
        d.upstream.addEventListener("close", (e: CloseEvent) => { try { ws.close(e.code || 1000, e.reason || ""); } catch {} });
        d.upstream.addEventListener("error", () => { try { ws.close(); } catch {} });
        if (d.upstream.readyState === WebSocket.OPEN) flush();
        else d.upstream.addEventListener("open", flush);
      },
      message(ws, message) {
        const d = ws.data as any;
        if (d.kind === "room" || d.kind === "user") return; // receive-only; clients post via REST
        if (d.upstream.readyState === WebSocket.OPEN) { try { d.upstream.send(message); } catch {} }
        else d.queue.push(message);
      },
      close(ws) {
        const d = ws.data as any;
        if (d.kind === "room") { try { ws.unsubscribe(roomTopic(d.roomId)); } catch {} return; }
        if (d.kind === "user") { try { ws.unsubscribe(userTopic(d.userId)); } catch {} return; }
        try { d.upstream.close(); } catch {}
      },
    },
    ...(hasTls && {
      tls: {
        cert: readFileSync(certFile),
        key: readFileSync(keyFile),
      },
    }),
  });
} catch (err: any) {
  if (err?.code === "EADDRINUSE") {
    console.error(`Port ${port} is in use. Edit ~/.maurice/config.toml to change it.`);
    process.exit(1);
  }
  throw err;
}

// Let route/service code fan messages out to room subscribers without importing
// the server (avoids a cycle): publishToRoom() → server.publish(topic, data).
setRoomPublisher((topic, data) => server.publish(topic, data));
setSubscriberCount((topic) => server.subscriberCount(topic));

export default server;
