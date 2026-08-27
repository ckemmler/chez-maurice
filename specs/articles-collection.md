# The articles collection — implementation record

Saving an article to the garden, from three capture surfaces, as a fiche.
Built August 2026 in six lots. This file is the durable record: what was built,
what was found broken along the way, and what is still open.

---

## What it does

One gesture — share sheet, browser button, or MCP tool — produces one markdown
fiche in the member's garden:

```
<garden>/articles/<locale>/<slug>-fiche.md            the fiche
<garden>/articles/<locale>/<slug>-fiche/_fragments/   the article's full text
<garden>/images/resources/articles/<locale>-<slug>.jpg
```

The frontmatter carries what a service gave us (author, subtitle, publication,
publication date, excerpt, language, word count, and the AI summary once it
exists). The body carries what the reader brought: a lead quote and the comment
written at the moment of saving.

**There is no table.** The markdown is the only source of truth — deliberately.
The vector store is a rebuildable projection; a table would be a second source
with nothing to rebuild it from, and no other collection (books, movies,
podcasts) has one. Duplicate detection is a filesystem scan of the collection,
which is cheap because the article's text lives in a fragment, not in the fiche.

The point of bascule, if it ever comes: when Carnet needs server-side
list/filter/paginate over several thousand fiches. The answer then is a
**derived cache over every collection**, rebuildable by a `reindex`-style
command — a projection, not a source.

---

## The pieces

| Where | What |
|---|---|
| `server/data-api/services/articleExtract.ts` | Fetch + extraction (OG → JSON-LD → Readability → meta), SSRF guard, URL canonicalisation |
| `server/data-api/services/gardenFiche.ts` | Writing into a garden from Bun: paths, block YAML, atomic writes, fragments, images, git |
| `server/data-api/services/gardenArticles.ts` | Orchestration: dedup, slug, fiche + fragment, comment, status |
| `server/data-api/services/articleSummary.ts` | The AI summary, generated after the save has answered |
| `server/data-api/services/gardenIndex.ts` | Pushing writes into the semantic index across processes |
| `server/data-api/routes/garden-articles.ts` | `POST /`, `GET /lookup`, `POST /:slug/summary` |
| `server/data-api/routes/articles-api.ts` | Legacy `/scrape` shim, delegating |
| `clients/web-clipper/` | Chrome MV3 extension |
| `carnet/CarnetShareExtension/` | iOS share sheet + `ShareExtensionPreprocessor.js` |
| `web/src/lib/fiche.ts` | Fragments + `meta:` rendering, shared by every theme |
| `maurice-tools/corpus/` | `garden-fiches`, `garden-fragments`, `garden-cards` sources; metadata head/prose; `filters`; `index_path` |

### The API

```
POST /api/v1/garden/articles
     { url, html?, selection?, comment?, tags?, locale, title?, source_client? }
GET  /api/v1/garden/articles/lookup?url=…
POST /api/v1/garden/articles/:slug/summary   { locale?, force? }
```

`html` is the whole trick: when present the server parses the DOM the caller
already rendered instead of fetching the URL. It is the only way past a paywall
or a bot check, and both the browser extension and the iOS share sheet send it.

**On iOS only Safari sends it.** `NSExtensionJavaScriptPreprocessingFile` is run
by the *sharing* app, and third-party browsers — Brave, Chrome, Firefox — hand
over a bare URL. Verified the hard way: a Gates Notes share from Brave produced
two 502s, the same article from Safari extracted cleanly. Sharing from anywhere
but Safari therefore falls back to a server fetch, which is fine for most sites
and lands on a bookmark (defect 21) for the ones that refuse robots.

### Three decisions worth remembering

**The summary is asynchronous and writes only into frontmatter.** A share sheet
must close in well under a second; a summary takes six. By the time it lands the
body may carry a second comment or a hand edit, so the file is re-read from disk
and only `meta` is touched.

**The save runs where it can finish.** In the browser extension that is the
service worker, because a popup is destroyed the moment it loses focus. On iOS
the item is queued first and sent best-effort, with the rendered DOM stored
beside the manifest so a retry does not fall back to a server-side fetch.

**The metadata preamble is split in two.** A short *head* (title, byline, kind,
year, tags) rides on every chunk at embed time; the *prose* (subtitle, summary,
blurb) is indexed once as its own chunk. See defect #18 for why.

---

## Defects found along the way

Twenty-two were fixed as part of the work. They are listed because most were
long-standing and silent, and because the pattern in several of them —
a path that stopped being true when gardens moved out of the checkout — is
likely to recur elsewhere.

### Fixed

| # | Where | What was wrong |
|---|---|---|
| 1 | `articles-api.ts` | Wrote into `web/src/content/` (the source checkout) instead of `gardensRoot()`, and had no notion of which member was saving |
| 2 | `articles-api.ts` | `content=["']([^"']*)["']` truncated every value at the first apostrophe: *Le titre de l'article* → *Le titre de l*. Systematic on French titles |
| 3 | `articles-api.ts` | No `resp.ok` check — a 404 page was saved as an article. This is how `client-challenge.md` and `security-verification.md` entered the garden |
| 4 | `articles-api.ts` | `<meta http-equiv="refresh">` redirects not followed — GitHub Pages and many CMSes saved a 0-word page titled "Redirect" |
| 5 | dedup | Only `-fiche.md` was scanned, so re-sharing any of the 8 existing article cards would have made a twin |
| 6 | SSRF guard | A blocked (loopback/private) target returned 502 instead of 400 |
| 7 | `ShareViewController` | Stack centred vertically — with a multi-line comment field the form sits behind the keyboard |
| 8 | `ShareViewController` | After a successful immediate send it dequeued `pendingItems().last` — **deleting someone else's queued work** whenever the queue was not empty |
| 9 | `ShareViewController` | Two `return`s left the sheet spinning on a disabled button |
| 10 | summary prompt | "3 to 5 sentences" with no word ceiling produced 1339 characters — four enormous sentences. A 110-word cap halved it |
| 11 | `web-clipper/options.js` | Listeners attached after `await loadConfig()` — buttons rendered but inert until storage answered |
| 12 | `ShareViewController` | Stopped at the first matching attachment provider. Safari sends the rendered DOM **and** a plain URL, so this would have discarded the DOM depending on order |
| 13 | `SharedContent.swift` | Cast the URL item to `URL` alone. `loadItem` may hand back `NSURL`, `Data` or `String` depending on how the sharing app registered it — other apps' shares were silently dropped |
| 14 | **both themes'** `FicheDetail.astro` | Looked for fragments under `process.cwd()/src/content`. **No fragment had rendered on any theme since gardens left the checkout.** Each theme carried its own copy of the code |
| 15 | `build-search-index.ts` | Fiches were indexed with title + tags only — not the author, not the publication, not the summary |
| 16 | `tools/garden/server.py` | `_push_note_to_corpus` hardcoded `garden-notes`, so every fiche/fragment/card write was routed to a source that filtered it out and **thrown away** |
| 17 | `tools/garden/server.py` | `_write_fragment` and `_handle_publish_content` never pushed to the corpus at all |
| 18 | `corpus/src/processor.py` | First version of the metadata preamble prepended the whole blurb to *every* chunk. 400 characters of Google Books marketing copy drowned the body: "la théorie de l'information intégrée et phi" returned the wrong book. Split into head + prose |
| 20 | `articleExtract.ts` | A refusal read like a dead link. `403 Forbidden` said nothing about the one thing that works — reopening the page in a browser. Refusal statuses (401/402/403/407/429/451) now throw a typed `ArticleRefusedError` carrying that advice |
| 21 | `gardenArticles.ts` | A site that refuses robots cost the reader the **whole save** — URL, comment, gesture. A refusal now writes a bookmark (`status: needs-capture`, the reason recorded, no invented title, no fragment); a later capture from a browser **completes it in place**, keeping its path and its accumulated comments. Only refusals qualify: a 404 or a DNS failure is still an error, because a bookmark to a dead URL is the junk defect 19 removed |
| 22 | `gardenArticles.ts` | The page's `rel=canonical` was extracted and then discarded — dedup ran on the shared URL alone, so the same article saved from a tracking link, an AMP variant or a mobile host produced a second fiche. The page's own name for itself is now the key, and a match is tried against both |
| 19 | the garden itself | `articles/fr/client-challenge.md` and `security-verification.md` — a Cloudflare interstitial and an FT 403 page, saved as articles in April 2026 by the route defect #3 describes. Both were already flagged `status: discarded`. Removed from the garden (commit `bf56cd9`, pushed) and unindexed. Their two URLs are real articles and can be captured again: the Le Monde one now extracts cleanly, the FT one needs the browser extension |

### Open

| # | What | Why it is not fixed |
|---|---|---|
| B | The corpus file watcher is off in the gateway (`corpus_server_context(watch=False)`) and no separate watcher runs | Mitigated: the Bun server and the garden MCP tool both push explicitly. But a **hand edit in Vim, or a `git pull` into the garden, is still not indexed** until the next `reindex` |
| C | Unfiltered semantic search is dominated by conversations — 85 849 chunks against 196 for the garden. "Le livre d'Anil Seth" returns conversation messages, not the fiche | Filters answer it (`{source_type: "fiche"}`), and the tool description documents them so the model reaches for them. If that proves insufficient in use, the fix is a dedicated `search_garden` tool pre-filtered to fiche/card/fragment |
| D | Notes carry no metadata preamble | The hash store skips unchanged files, so a `reindex` does not re-embed them. Needs a hash purge and a re-embed of 172 notes |
| E | The share extension's on-screen layout with the keyboard up is unverified | Accessibility automation cannot see inside the iOS share sheet. Verify on first real use; if cramped, shrink the field to ~72pt or wrap it in a `UIScrollView` |
| F | The first real Safari capture stored a **truncated URL** — `…/make-ai-work-for-everyone/rea`, apparently a cut-off `/reader`. The article extracted correctly, so the DOM was whole; only `document.URL` was short | Cause unknown — possibly captured mid-navigation. Watch whether it recurs. Defect 22 limits the damage for ordinary variants but cannot match a truncated URL against the full one, so a re-capture would make a second fiche |
| G | `data-api/services/signalParser.ts` pins `claude-sonnet-4-5-20250929` | Out of scope. Stale relative to the current family; `budget_tokens` is now rejected on 4.7+ |
| H | `server/` has 110 pre-existing `tsc` errors, `web/` 153 (no `@types/node`) | Pre-existing. The rewrite of `articles-api.ts` removed 39 of them |
| I | Chrome removed `--load-extension` in v137 | Testing only. Loading unpacked from `chrome://extensions` still works. The extension test suite runs on Chrome for Testing 127 |
| J | The corpus `reindex` tool replies `"reindex started"` but actually awaits completion | Cosmetic |
| K | The web clipper is untested on Firefox | `background.service_worker` needs to become `background.scripts` for Firefox's MV3 |

---

## Verification

243 assertions, all passing:

| Suite | Assertions | What it covers |
|---|---|---|
| Extraction + YAML | 29 | Canonicalisation, slugs, entities, JSON-LD `@graph`, block YAML round-trip through both `Bun.YAML` and PyYAML |
| Garden service | 51 | End-to-end on a throwaway garden with a git repo: fiche, fragment, dedup, comments, slug collisions, status, errors |
| HTTP routes | 36 | Both routes, auth, validation, the legacy shape |
| Summary | 39 | Generation, idempotence, `force`, concurrent edit, card vs fiche, failure modes, background scheduling |
| Swift → HTTP → route | 15 | `CarnetAPI` compiled for macOS against the real server code |
| Chrome extension | 35 | Real Chrome over CDP: options page, DOM capture, worker save, dedup, failure reporting |
| iOS share parsing | 16 | Fabricated `NSExtensionItem`s: Safari's shape, DOM-vs-URL precedence, oversized page, file fallback |
| Corpus | 22 | Real garden indexed into an isolated store: flattening, preamble, filters, empty-body fiches |

Live checks after deployment: the API answers 401 (not 404) on the new routes;
the gateway exposes `corpus__index_path` and a `corpus__search` carrying
`filters`; the web engine renders the byline, the summary block and — for the
first time — a fragment.

Three real Anthropic API calls were made during development (~7 cents total) to
verify the request shape and the summary's quality in French and English.
