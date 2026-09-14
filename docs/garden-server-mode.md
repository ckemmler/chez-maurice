# The garden engine, out of the dev server

Status: plan, 2026-09-14. Owner: Candide. Sessions pick up from the phase table.

## Why

Each member's garden runs its own `astro dev` (Vite) process, ~270 MB, started
at boot whether anyone reads it or not. A household of four is ~1.1 GB of Vite;
87 % of an instance's memory. Hosting friends and demos on Scaleway is priced
by memory, so this is the bill.

The constraints that led to `astro dev` are real and stay:

- **No regeneration.** A garden can reach thousands of pages. A note edited by
  Maurice or by the owner must show on the next request without rebuilding
  anything. Notes already do this: `web/src/lib/notes-fs.ts` reads the `.md`
  off disk per request. The rest of the collections still go through Astro's
  content layer, which is a build-time store.
- **Live theme switching**, per reader, no rebuild. Already per-request
  (`theme-registry.ts`, `middleware.ts`); survives a server build as is.
- **The owner's toolbar** (toggle public/private, delete, reorder, translate,
  publish) — today 11 Vite middlewares in `web/src/integrations/dev-tools.ts`
  that do not exist in a build, carry no auth, and POST to root-absolute
  `/_dev/*` URLs that under `/g/<member>/` reach the wrong engine.
- **The browser refreshes** when a file changes — today Vite's HMR socket,
  proxied through Bun with its own idle-timeout plumbing.

## What it becomes

One `node` process per household, built once, serving every member's garden:
the member is chosen **per request** from the `/g/<member>/` prefix (Bun strips
it and forwards `X-Maurice-Garden`), not from a process-level `GARDEN` env. The
same bundle, the same `/_astro/*` assets, one content cache. Target: ~100 MB
for the whole household instead of 270 MB × members.

| Today (dev server) | Tomorrow (server build) |
|---|---|
| `import.meta.env.DEV` = "show drafts, show toolbar" (55 gates, 43 files) | `Astro.locals.owner`, set from `X-Maurice-Owner` that Bun sends after auth. Same meaning made explicit: the owner is looking at their own garden. Public/static publish: never owner. |
| `/_dev/*` Vite middlewares, no auth | `/api/v1/gardens/:member/*` on the Bun server, owner-only, called by the toolbar through the base-aware API base. The python-spawning ones (translate, social publish, adherence) live there too, where the venv is. |
| `getCollection` for blog / essays / pages / fiches / 7 resource collections (42 files) | `content-fs`: disk readers per collection, schema from `content.config.ts`, same markdown processor as `notes-fs`, cached by mtime. `render()` in detail views → processor output. |
| HMR reload | A `garden-changed` event on `/api/me/ws` (Bun already watches gardens for activity); a 20-line client in `Base.astro` reloads when the page's own file changed. |
| `download-images` at `astro:config:setup` (rewrites garden `.md` at engine start) | Done by the Bun server at write time (MCP note write / entries), never by the engine. |
| `@astrojs/cloudflare`, `output` by `WEB_SSR` | `@astrojs/node` standalone when `WEB_SSR=1`; no adapter for the static publish. Cloudflare adapter goes unless `pages:dev` still needs it. |
| `encrypt-private` at build (static publish only) | Unchanged — static publish keeps it; the SSR engine is behind Bun's auth gate. |
| `start-garden.sh` symlink shells, `GARDEN_PORTS`, one port per member | One port. `gardens.json` keeps `base` for link rewriting; `port` becomes unused. Bun forwards `/g/<m>/…` → engine `/…` + header; `/_astro/*` and `/_image` straight through. |
| Search index recomputed per request, drafts by DEV | Two cached indexes (public / owner), invalidated by the same change events. |

The static publish (`scripts/publish-web.sh`, candide.me) is untouched in
behaviour: `output: "static"`, no owner, fiches off, encryption on.

## Phases — each ends with the e2e battery green

| # | Phase | Ends when | Est. |
|---|---|---|---|
| 0 | **E2E battery** (Playwright, chromium) against today's stack, through the Bun proxy, on a seeded throwaway household enriched with every collection. | The battery describes today's behaviour; it is the reference. | 2 d |
| 1 | **Owner mode.** `locals.owner` from Bun's header replaces every `import.meta.env.DEV`. Still on `astro dev`. | Battery green; `grep import.meta.env.DEV web/` empty. | 1 d |
| 2 | **Toolbar → Bun API.** The 11 `/_dev` routes become authenticated routes in `server/src/routes/`; `DevToolbar.astro` and `NoteDetail.astro` call them base-aware; `dev-tools.ts` deleted. | Battery green; `web/src/integrations/dev-tools.ts` gone. | 2 d |
| 3 | **Disk readers for every collection**; `download-images` moved to the server; search index cached. | Battery green; `grep getCollection web/` empty outside `content.config.ts` (kept for the static publish's schema only, or dropped). | 4 d |
| 4 | **Server build.** Node adapter, per-request garden, one engine per household, reload events, new `start-web.sh`, container image runs `node dist/server/entry.mjs`. | Battery green **against the build**; memory of a 4-member household measured and written here. | 4 d |
| 5 | **Cleanup + docs.** Symlink shells, `GARDEN_PORTS`, cloudflare adapter, HMR proxy code; `maurice-web-garden.md` and `maurice-server.md` rewritten. | Nothing dev-server-shaped left in `server/index.ts`. | 1 d |

Phases 1–3 land on `main` one by one; each is safe on the dev server and
improves it. Phase 4 is the switch.

## The e2e battery (phase 0) — what it must pin down

Runs in `web/e2e/` with Playwright, against a Bun server started on a free port
with `MAURICE_DATA_DIR` / `MAURICE_GARDENS_DIR` pointing at a throwaway seed
(`server/scripts/seed-demo.ts` + an e2e enrichment: a book, an article, an
essay, a blog post, a page, a fiche, a person, a podcast, a movie, a series, a
game, notes in en and fr with wikilinks, a private note, a draft, an image,
a MOC). Sessions are created through `/api/auth` like the apps do.

1. **Rendering, every collection, both locales** — list and detail pages
   return 200 and contain the title; wikilinks resolve to the right member's
   base; images load; `search-index.json` lists the entry.
2. **Live content** — write a new note file, reload: it is there. Edit its
   title: the new title shows. Delete it: 404. No restart, no rebuild.
3. **Themes** — `?theme=newsprint` renders the newsprint layout and sets the
   cookie; the next request without the param keeps it; every shipped theme
   renders the home and a note.
4. **Visibility** — as the owner: drafts and private notes in nav, lists,
   search, detail. As another member: only shared notes, 403 elsewhere. As a
   guest: 403. Unauthenticated: redirect to login.
5. **Toolbar actions** — as the owner: toggle public (flag written, git
   commit made), toggle private, delete note (file, image and backlinks gone),
   reorder children (`order:` written — pins the current no-op as a known
   bug to fix in phase 2). As another member: 403.
6. **Activity & sockets** — `garden-activity.json` reflects a recent write;
   the page's websocket upgrade through the proxy succeeds.
7. **Static publish** — `publish-web.sh`'s build still produces the same set
   of pages for the public garden (a smoke, not a full diff).

Memory is measured, not tested: `docker stats` of the demo household before
phase 0 and after phase 4, recorded below.

### Phase 0 — done 2026-09-14

`web/e2e/`: `stack.ts` (seed + Bun server + one engine per member on
ephemeral ports, `E2E_ENGINE=dev|server`), `fixtures/seed.ts` (the household
above), `helpers.ts` (a page logged in as a member, file helpers),
`playwright.config.ts`, `npm run e2e`. Five specs, 55 tests, ~25 s:
`rendering`, `live`, `visibility`, `toolbar`, `activity`. Item 7 (static
publish smoke) is deferred to phase 4, when builds become central.

Four tests are `test.fail()` — they pin bugs the battery found in today's
engine, to be fixed in the phase that touches the code, at which point they
flip to plain tests:

- **Note images are broken under `/g/<member>/`.** The base-prefixing
  middleware rewrites `/api/images/<name>` (what Maurice writes) to
  `/g/<member>/api/images/<name>`, which the engine 404s. (rendering)
- **Text before a wiki-link is dropped in the browser.** The MOC-card script's
  "mixed paragraph" branch keeps only what follows the link. (rendering)
- **`reorder-children` writes nothing** — resolves under the empty
  `web/src/content`. (toolbar)
- **The toolbar's own switches fail under `/g/<member>/`** — they POST to
  root-absolute `/_dev/*`, which the proxy hands to the default garden's
  engine. (toolbar)

Also observed, pinned as current behaviour rather than failed: `delete-note`
strips only a wiki-link standing alone on its line; a deleted note that was
never committed makes the backlink commit fail silently (`git add -A` on a
gone untracked path).

### Phase 1 — done 2026-09-14

`Astro.locals.owner` replaces every `import.meta.env.DEV` (55 occurrences, 47
files). The Bun proxy sets `X-Maurice-Owner: 1` when the session user is the
garden's owner and `X-Maurice-Shared: 1` on a note page shared with a
non-owner, after deleting any such header a client sent; `middleware.ts`
reads them into `locals.owner` / `locals.shared`. `GARDEN_OWNER=1` makes a
bare `astro dev` (no proxy) act as the owner. `getStaticPaths` filters are
plain `isPublic` (a static build has no request), and `buildSearchIndex`
takes the flag from its route.

Side effect worth the phase on its own: a non-owner member could fetch
`/g/<other>/search-index.json` (not a document navigation, so the proxy let it
through as an asset) and get that garden's drafts and private notes. Under
owner mode they get the public index. Two new tests pin it, and the shared
note. 57 tests; the static publish build was smoked on the seeded garden and
carries no draft, no private note, no toolbar.

## Measurements

| When | Household | Engine RSS | Note |
|---|---|---|---|
| 2026-09-13 | Aline's rehearsal container (1 member) | 786 MB total | `astro dev` |

## Decisions log

- 2026-09-14 — one engine per household, member per request, is the target;
  not per-member builds.
- 2026-09-14 — `owner` replaces `DEV`; there is no "dev mode" concept in the
  engine any more.
