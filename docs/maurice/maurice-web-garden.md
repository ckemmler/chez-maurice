---
title: The web garden
date: '2026-09-19'
flags: []
locale: en
description: 'The Astro renderer: per-request theme engine, content collections, wiki-links,
  build-time encryption, and Cloudflare deployment.'
tags:
- maurice
- documentation
- architecture
- web
- astro
icon: globe
parent: maurice-docs
---

# The web garden

The garden is Markdown on disk; `web/` is the **Astro** site that renders it as a browsable, themeable website. The same content the app edits becomes pages here. Multi-member serving (each person's own garden, shared gardens) is its own note — [[maurice-shared-gardens]]; this one is the rendering engine.

## The theme engine

A theme is a folder under `web/themes/<name>/` (a `theme.json`, a `global.css`, `layouts/Base.astro`, and `views/*.astro`). Themes are resolved per request, not baked in:

- **Selection** (`web/src/middleware.ts`): `?theme=` query (wins, sets a year-long cookie) → that cookie, *while it is newer than the owner's choice* → `X-Maurice-Theme` (the owner's pick in the app, from `garden_settings.web_theme`) → `THEME` env → `DEFAULT_THEME` (`manuscript`). The choice rides on `Astro.locals.theme`. The cookie is dated (`<name>.<unix seconds>`) and the proxy sends the choice's date as `X-Maurice-Theme-Since`: the app itself opens a garden through `/login?…&theme=X`, so the cookie is usually the owner's own earlier pick, and without the date a new pick in Settings showed on no device that had opened the garden before (the regression of 2026-09-19). An undated cookie, from before that rule, yields.
- **View resolution** (`web/src/lib/theme-registry.ts`): `resolveView(theme, "NoteDetail")` / `resolveLayout(...)` dispatch to the active theme's component, falling back to the hidden `default` theme — so a theme only overrides what it wants to.
- **Vite aliasing** (`web/astro.config.mjs`): a `themeResolver()` plugin maps `@theme/<path>` to the active theme with a `default` fallback; `@app` points at `src/`.

The shipped garden themes are **manuscript** (default — ivory paper, oxblood links), **botanical**, **newsprint**, and **terminal**; `default` is the hidden base. `theme.json`'s `kind` (`garden` → notes-index home, vs `site` → hero home) decides what the homepage is.

**Live switching requires SSR.** A static build bakes one theme; with `WEB_SSR=1` the middleware reads the cookie/query each request (HTML served `Cache-Control: no-store`) so a theme change applies immediately.

## What it renders

Content collections (`web/src/content.config.ts`) load from the member's garden under `~/.maurice/gardens/<member>/` (resolved from one place, `gardensRoot`, in the server, the shell and the engine alike):

- **notes**, **blog**, **essays** (MDX), **pages**
- **resources**: books, articles, movies, series, podcasts, games, people — the *cards*
- **fiches** — the working faces (`<slug>-fiche.md`), rendered on the member's private garden with everything the fiche knows about itself (provider metadata, fragments, résonances); left out of the production build. A garden is its fiches and cards too, not only its notes — the garden list is built a page at a time.

A note Maurice wrote at a domain's adoption and the owner has not reviewed yet (`meta.opened: false` in its frontmatter, see [[maurice-knowledge]]) opens on a **banner** — *Written by Maurice, not reviewed yet · From 16 conversations, with deepseek-v4-flash-0731* — with, for the owner, the two gestures that are not the toolbar's: **Keep** (`POST /api/v1/garden-tools/review-note`, the mark goes and the banner fades) and **Throw away** (the toolbar's delete, then back to the notes index; correcting is the toolbar's *Edit*). The notes index and a MOC's child list show *to review* beside such a note. Both are in the default theme's `NoteDetail` and `NotesList`, which every shipped theme inherits; a non-owner sees the banner without the buttons.

A **dev bar** on the private garden gives its controls back to the reader: toggle a note public or encrypted, reorder, delete, open the page in Obsidian on the Mac or Working Copy on the iPad, and what the dev bar writes is committed like any other garden write. Drafts show in search there.

Routing is locale-aware: English at `/`, French under `/fr/` (with localized segments — resources live at `/resources/…` in English, `/fr/trouvailles/…` in French). Drafts vs. published is the `public` flag (`web/src/lib/flags.ts`): no `public` flag → visible in dev, hidden in the production build.

## Linking

`web/src/plugins/remark-cross-ref.mjs` turns two syntaxes into real links, locale-aware:

- **Wiki-links** `[[slug]]` / `[[slug|Label]]` → `/notes/slug`, tagged `class="wiki-link"`.
- **Typed cross-refs** `[text](note:slug)`, `(book:…)`, `(movie:…)`, etc. → routed through a `ROUTE_MAP` to the right collection, tagged `cross-ref cross-ref--<type>` for themed styling.

MOC notes render their wiki-link children as cards.

## Build-time integrations

- **Private-note encryption** (`web/src/integrations/encrypt-private.ts`, on `astro:build:done`): notes flagged `encrypted` are encrypted **in the built HTML** with AES-256-GCM (PBKDF2, 600k iterations) under `PRIVATE_CONTENT_PASSWORD`; the page ships a decryption form and caches the derived key in `sessionStorage`. The bytes at rest on the public host are ciphertext.
- **Garden image links** (`garden-image-links.ts`, on `astro:config:setup`): symlinks `public/images/<member>` at the member's images and `public/avatars/*` at theirs, so a cover resolves; on `astro:build:done` it prunes everything but `resources/` out of the build, keeping private note art off a published site. It used to *also* walk every collection at engine start, download remote covers and rewrite the garden's markdown — the renderer editing what it renders. That sweep is the server's since 2026-09-14 (`server/src/services/gardenImages.ts`, once a few seconds after boot), beside the on-write download the writers already did.

## SSR vs. static, and deployment

`WEB_SSR=1` → `output: "server"` (each note route does `prerender = false` and reads the `.md` straight from disk via `web/src/lib/notes-fs.ts`, bypassing Astro's content layer to survive rapid edits). Unset → a fully static build. Either way the adapter is **Cloudflare**.

At home the private gardens are served by the `com.maurice.web` engine, reached through the server at `/g/<member>/` (the server gates each garden to its member; the engine accepts any host). Each engine **binds to the loopback only** — the proxy is the sole way in, and that is load-bearing: these are `astro dev` servers, and the `/_dev/*` editing routes they carry (delete a note, flip it public, write a file) have no auth of their own. The proxy refuses `/_dev/*` for a garden that isn't yours, whatever the request shape, and the engine confines every path it resolves to the garden it serves. The public site is published to **Cloudflare Pages** production from `scripts/publish-web.sh`, whatever branch is checked out.

A Cloudflare Pages function (`web/functions/_middleware.ts`) adds **time-travel**: `?t=YYYY-MM-DD` serves a historical snapshot from an **R2** bucket (`SNAPSHOTS`), choosing the most recent milestone ≤ the date and injecting a banner. Falls back to the live site when absent.

## Ships vs. exists

The renderer, the garden themes, wiki-links, and build-time encryption are **core** to the shipping garden. The time-travel snapshots and the `candide` *site*-kind theme are tied to the public `candide.me` deployment — real, but deployment-specific rather than part of the household product.

## One engine, every member

Since 2026-09-14 a household runs **one built node server** for all its gardens — `web/dist/server/entry.mjs`, started by `scripts/start-web.sh` on :4321. It used to be one `astro dev` per member, because the engine was told whose garden it served once, by a `GARDEN` environment variable. It is now told **per request**: the Bun proxy sends `X-Maurice-Garden` and `X-Maurice-Base` and strips the `/g/<member>` prefix before forwarding; the engine's middleware opens an `AsyncLocalStorage` (`src/lib/garden-context.ts`) that `garden.ts`, `notes-fs`, `content-fs` and `fiche.ts` read, so the member reaches them without a single signature changing. Outside a request — the static publish, a script — there is no store and `GARDEN` answers as before.

The engine therefore has **no `base`**: its own asset URLs sit at the root, which is what lets one build serve everyone, and the middleware puts the prefix back into the HTML as it always did. `@astrojs/node` (standalone) is the adapter when `WEB_SSR=1`; the Cloudflare adapter stays for the static publish.

Measured on the real household — Candide's 266-note garden plus three others, every member warmed through the one process: **127 MB**, against about 1.44 GB of dev servers before (a page renders in 13 ms, the search index in 3 ms). On the Mac mini the running engine sits at ~113 MB.

**Live reload replaces HMR.** Vite's socket existed only because the engine was a dev server, and it pushed changed *modules*; what changes in a garden is content. `GET /api/v1/garden-tools/events` now streams `{collection, locale, slug}` from one `fs.watch` per garden, and `GardenReload.astro` (in every theme's `Base`) reloads when the change plausibly concerns the page — debounced, capped at ten, backing off on error. A platform without recursive watching simply gets no auto-refresh.

## Images

A garden's images are served by the **server**, off disk, at request time:
`GET /images/<member>/**` reads `<garden>/images/…`. Note bodies and MOC cards
point there (`/images/<member>/notes/<file>`), covers too
(`/images/<member>/resources/<collection>/<file>`).

They used to come out of the engine's `public/` dir through a symlink into the
garden. That stopped working when the engine became a build — `public/` is
copied into the bundle at build time, and the publish step prunes note art out
of it (rightly: the same build feeds the public site), so every note
illustration 404'd while covers survived. Serving them from the server also
means an image added after the build appears at once, like everything else in a
garden. The `garden-image-links` symlinks now matter only to the static
publish.

Who sees what: your own garden's images entirely, another member's only under
`resources/` — cover art is public-facing metadata, a note's illustration is
not. `/api/images/<name>` (the data dir) is what Maurice writes into a note
body and is unauthenticated by design, as the app's `AsyncImage` needs.

## Where the content comes from

Every collection is read **off disk, per request** — `web/src/lib/content-fs.ts`, since 2026-09-14. It offers the three calls Astro's content layer offered (`getCollection`, `getEntry`, `renderEntry`), so the pages and theme views changed only their import, and `content.config.ts` is gone: no collection store is loaded, in the engine or in the static build.

The content layer was a *build-time store*: a glob loader scanned the garden once and served what it captured. A garden is not a build artefact — Maurice writes to it all day — and under rapid edits the store intermittently collapsed a collection to "empty" until the dev server restarted, which is why notes were moved off it long before the rest. Reading files has no store to corrupt: an entry exists iff its file exists.

A call walks the collection's directory (fresh, so a write shows at once) over a parse cache keyed by mtime and size, and a render cache likewise. On Candide's garden — 266 files — the walk costs 2.4 ms and the whole search index 3–5 ms. The zod schemas went with the config: YAML already types dates, numbers and arrays; `content-fs` coerces the few fields views depend on and passes the rest through as authored, skipping a malformed file with a warning rather than taking its collection down. **Notes** keep `notes-fs` as their reader and `content-fs` delegates to it. **Fiches** are present in the garden engine and absent from a static publish — the rule the old `NODE_ENV=production` test was reaching for.

## The owner's toolbar

The toolbar a garden owner sees on their own pages — flip a note public or private, delete it, drag-reorder a MOC's children, open the file in Obsidian or Working Copy, translate, share to social — calls `POST /api/v1/garden-tools/*` on the Maurice server (`server/src/routes/gardenTools.ts`, over `server/src/services/gardenTools.ts`) — and, since 19 September 2026, `review-state` / `review-note` for the banner above (`clearUnreviewed` edits the one line and leaves the rest of a hand-written frontmatter exactly as it was). **No member in the URL**: each route acts on the caller's own garden, resolved from the session, so one cannot be aimed at someone else's. Writes go through the same `atomicWrite` + `autoCommit` as the MCP tool, so a toggle is committed (and pushed when there is a remote) like any other garden write.

Until September 2026 these were eleven Vite middlewares in `web/src/integrations/dev-tools.ts` (`astro:server:setup`), which is a large part of why every member garden had to run `astro dev`. They carried no authentication, trusting the proxy; and the browser called them root-absolute at `/_dev/…`, which under `/g/<member>/` reached whichever engine served the *default* garden — so in a household a member's toolbar edited nobody's garden. Two long-standing bugs died with the move: that one, and `reorder-children` resolving slugs under the empty `web/src/content` (a drag-reorder answered success and wrote nothing).

Two of the ten routes need the source checkout: `translate` (a tsx script) and `social-publish` (a python CLI in `tools/social`). On an install that is not a checkout — the container — they answer 501 rather than spawn what is not there. The same goes for the coaching-adherence regeneration, which now lives in the proxy: visiting `/fr/notes/bilan-<slug>` as the owner kicks off a debounced background run.

## Owner mode

Since 2026-09-14 the engine has no notion of "dev mode". What `import.meta.env.DEV` used to mean — the owner is looking at their own garden: drafts and private notes are theirs to see, the toolbar is theirs to use — is `Astro.locals.owner`, set by `src/middleware.ts` from the `X-Maurice-Owner: 1` header the Bun proxy adds when the session user is the garden's owner (any such header a client sent is dropped first). `X-Maurice-Shared: 1` marks a note page a non-owner may read because it was shared with them (`locals.shared`). `GARDEN_OWNER=1` makes a bare `astro dev` without the proxy behave as the owner. A static build has no request and is never owner, so `getStaticPaths` filters are plain `isPublic` and `buildSearchIndex(locale, owner)` takes the flag from its route. This closed a leak: a non-owner member could fetch another garden's `search-index.json` (an asset, not a navigation, so the proxy let it through) and get its drafts and private notes.

## Tests

Since 2026-09-14 the garden has an end-to-end battery, `web/e2e/` (Playwright, chromium, `npm run e2e` from `web/`). It starts the real topology on ephemeral ports — a seeded throwaway household (hana, theo, mei, a guest), the Bun server, one engine per member — and runs 55 tests in ~25 s: every collection renders in both locales through the proxy; a file written, edited or removed shows on the next request; who sees what (owner, member, guest, anonymous); the owner's toolbar routes; the activity JSON and the live socket. `E2E_ENGINE=dev|server` picks `astro dev` or the built node server, which is the point: the battery is the reference for [[maurice-web-garden|the engine leaving the dev server]] — plan and phases in `docs/garden-server-mode.md`. Four tests are `test.fail()` and pin known bugs (below).

## Gaps & notes

- **The private overlay is a second place to look.** `maurice-web/` is symlinked into `web/src/pages` and `web/src/components`, so a sweep over `web/` with `grep -r` does not see it (it does not follow symlinked directories) — which is how four of its pages kept importing `astro:content` after the engine stopped loading a content config, and answered 404. Use `grep -R`, and remember the overlay is its own repo with its own commit.
- **The e2e battery found four bugs and all four are fixed** (September 2026): `reorder-children` wrote nothing, the toolbar reached the default garden's engine, note images 404'd under `/g/<member>/`, and the MOC-card script dropped the text before a wiki-link. Nothing is pinned; 73 tests run green against both the dev server and the build.
- **The chantier is finished** (phases 0–5, `docs/garden-server-mode.md` keeps the record): the e2e battery, owner mode, the toolbar API, disk readers, one built engine per household, and the cleanup. Nothing starts an `astro dev` per member any more; `start-garden.sh` and the `.garden-roots` shells are gone, and `gardens.json` no longer carries a port.

- **The editing routes are dev-server middleware.** `/_dev/*` lives in an `astro:server:setup` hook, so the gardens must keep running under `astro dev` for the toolbar to work at all. Three layers stand in for authentication they don't have: loopback binding, the proxy's member check, and path confinement. A production-mode garden would need them rebuilt as real endpoints. (Closed in September 2026: the engines were bound to `0.0.0.0`, and a `fetch()` slipped past the proxy's navigation-only check.)
- **Per-garden theme wiring is joined** (2026-09-14, dated 2026-09-19). The server's `garden_settings.web_theme` — what the app's picker writes — travels to the engine as `X-Maurice-Theme`, with its date as `X-Maurice-Theme-Since`, under a reader's own `?theme=` and a cookie newer than the choice. Before that the engine chose from its environment and the picker did nothing at all; then the year-long cookie the app's own `/login?…&theme=` had set outranked every later pick.
- **Live activity indicator is transient.** `web/src/pages/garden-activity.json.ts` reports notes edited in the last ~30s by reading a `/tmp` file the garden tool writes; there's no persistent history. (It is polled often enough to be the loudest line in the API log.)
- **Search index is single-locale.** One `/search-index.json` (English); no per-locale or per-member variants.
