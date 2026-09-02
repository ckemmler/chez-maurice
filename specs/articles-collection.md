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

Forty-five were fixed. They are grouped by how they were found, because that
turns out to be the useful axis — and by the end the axis says something
uncomfortable: only 22 of the 45 were caught while building. The rest surfaced
when someone read the code, when a query was watched instead of assumed, or when
a test was finally written for the input a hand-edited garden really contains.

### Fixed while building

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

### Fixed by code review

Two passes, one over the Carnet commit and one over the PR.

| # | Where | What was wrong |
|---|---|---|
| 23 | `ShareViewController` | `completeRequest` fired 0.8s after Save while the send ran in a fire-and-forget `Task` — and completeRequest tears the process down, so the Task went with it. Survivable when the payload was a bare URL and the request usually won that race; with megabytes of rendered DOM it never does. The item stayed queued, the app re-sent the same megabytes, and the "bookmark" outcome was never seen |
| 24 | `SharedContent.swift` | Reading attachments gave up on a provider as soon as one of its types matched. One attachment often carries several representations, so when Safari's JavaScript results came back unusable the URL on that same provider was never tried and the share was reported as "nothing shareable" |
| 25 | `ShareViewController` | The highlighted passage was pre-filled into the comment box *and* sent as `selection`, writing the same text into the fiche twice |
| 26 | `gardenFiche.ts` | **`yamlScalar` omitted the YAML indicators `[` and `{`.** A title of the form "[Analyse] …" or "{Tribune} …" — ordinary in the French press — opened a flow sequence and made the whole fiche unparseable: invisible to dedup (so every re-share made a twin), empty to `isStub` and `readStoredSummary`, rejected by Astro's schema. The highest-severity defect in the whole build, and it shipped |
| 27 | `gardenArticles.ts` | A slug collision on a long title produced `…derni--2`, which `assertSlug` rejects — a 500 for a save that only needed a suffix |
| 28 | `gardenArticles.ts` | Completing a bookmark kept the stub's path but took the locale from the request, so a completion from a differently-configured client stamped `locale: en` on a fiche living in `fr/`, wrote its cover under the other prefix, and answered with paths that do not exist |
| 29 | `gardenArticles.ts` | `input.title` overrode extraction, and the browser clipper sends `document.title` on every save — so `og:title` lost to "Real Title \| Le Monde", in the fiche and in the slug derived from it. It is a fallback now |
| 30 | `garden-articles.ts` | Summarisation was scheduled for bookmarks, guaranteeing a re-fetch of the site that had just refused us — which is the reason the bookmark exists |
| 31 | `web-clipper/popup.js` | Same selection duplication as 25, on the browser side |
| 32 | `web-clipper/popup.js` | `chrome.runtime.sendMessage` *rejects* when the service worker cannot start — routine after eviction. Unhandled, it left the popup stuck on "Saving…" with the button disabled for good |
| 33 | `articleSummary.ts` | A summary that hit `max_tokens` was committed as if complete — and stuck, since regeneration is skipped when a summary exists, so a retry without `force` returns the same half sentence |
| 34 | `gardenFiche.ts`, `tools/garden` | `writeFragment` escaped only `"`, so a backslash or a newline in the publication name broke the scalar the Python side parses as YAML. Both sides fixed |
| 35 | `articleExtract.ts` | Three fallbacks referenced meta keys the extractor never sets, one of them ahead of a term that could therefore never lose to it — the code read as if a meta-tag publication name took precedence when it could not participate |
| 36 | `articleExtract.ts` | `decodeEntities` used `String.fromCharCode`, mangling any codepoint above U+FFFF: an emoji in a headline became a lone private-use character, in the title and in the slug |

### Fixed by writing the suite

| # | Where | What was wrong |
|---|---|---|
| 37 | `src/services/gardensRoot.ts` | The function cached `MAURICE_GARDENS_DIR`, so it kept answering with whatever the first caller in the process resolved. Under `bun test`, where every file shares one process, a suite setting the variable got someone else's answer — and wrote its fixtures into the checkout at `web/gardens/candide/`. Found by this suite doing exactly that. The variable is now read on every call; the cache remains for the filesystem probe it was actually for |

### Fixed by verifying something else worked

Point C asked whether the model reaches for `filters` (it does, 4 questions out
of 4). Getting an answer meant watching real queries, and two of them came back
wrong for reasons that had nothing to do with the model.

| # | Where | What was wrong |
|---|---|---|
| 38 | `corpus/src/utils.py` | A published card names its publication `source`; a fiche names it `publication`. A filter on either saw half the collection — and the model, reading the documented keys, reasonably chose `publication` and got nothing |
| 39 | `corpus/src/processor.py` | That same frontmatter key was overwriting the corpus's own: the payload said `source: "the Guardian"` where it meant `garden-cards`, so filtering by which source indexed a document was broken and the provenance was a lie |
| 40 | `corpus/src/orchestrator.py` | Nothing ever removed index entries for files that no longer exist. The gardens moving out of the checkout had left **171 notes** indexed under the old path, so search had been answering with stale copies of the reader's own notes — invisibly, since a result carries its text, not its age. `prune` finds and drops them; only filesystem-backed units are considered, since a conversation's key is `msg:<uuid>` |
| 41 | `corpus/src/mcp_server.py` | No way to apply a change in how metadata is *rendered* into the index: the hash store skips unchanged files, so 38 and 39 could not take effect on anything already indexed, and neither could the metadata preamble on notes indexed before it existed. Hence `force` on reindex |

### Fixed by the suite, on its first run

| # | Where | What was wrong |
|---|---|---|
| 42 | `corpus/src/utils.py` | Malformed frontmatter raised; the caller logged it and moved on, so the **whole document dropped out of the index** — findable by nothing, with one line in a log nobody reads. A typo in a hand-edited file was enough |
| 43 | `corpus/src/processor.py` | Chunking an empty body returned one *blank* chunk rather than none. It masked the empty-body fallback, and it is a misalignment waiting to happen: the embedder drops blank strings, so the vectors would be shorter than the chunks and every payload after it would carry someone else's vector |
| 44 | `corpus/src/utils.py` | `source` sat in the preamble's facet list. Fixing 39 filled that key with the source *name*, so every preamble had been reading "… — Anil Seth, Dutton, garden-fiches — book" — constant noise in every vector. A regression two commits old, caught on the suite's first run |
| 45 | `corpus/src/orchestrator.py` | The index-state path was hardcoded, so a suite had nowhere to put its own but the real one — the same shape of trap that sent an earlier suite's fixtures into the checkout. `MAURICE_CORPUS_DATA_DIR` now overrides it |

### Open

| # | What | Why it is not fixed |
|---|---|---|
| C | Conversations still outnumber the garden 85,849 chunks to 1,220, so an unfiltered semantic search is dominated by them | **Measured, not assumed.** Given the real tool schemas and five questions a reader would actually ask, the model narrowed on 4 of the 4 garden questions — twice with `filters`, twice by choosing a better tool (`search_by_author`, `list_fiches`) — and correctly left the one conversation question unfiltered. Replaying its calls against the household index returned the right documents. The imbalance is still there; the bet that the model works around it holds. Watch it in use; if it slips, a dedicated `search_garden` pre-filtered to fiche/card/fragment is the fix |
| E | The share extension's on-screen layout with the keyboard up is unverified | Accessibility automation cannot see inside the iOS share sheet. Verify on first real use; if cramped, shrink the field to ~72pt or wrap it in a `UIScrollView` |
| F | The first real Safari capture stored a **truncated URL** — `…/make-ai-work-for-everyone/rea`, apparently a cut-off `/reader`. The article extracted correctly, so the DOM was whole; only `document.URL` was short | Cause unknown — possibly captured mid-navigation. Watch whether it recurs. Defect 22 limits the damage for ordinary variants but cannot match a truncated URL against the full one, so a re-capture would make a second fiche |
| G | `data-api/services/signalParser.ts` pins `claude-sonnet-4-5-20250929` | Out of scope. Stale relative to the current family; `budget_tokens` is now rejected on 4.7+ |
| H | `server/` has 110 pre-existing `tsc` errors, `web/` 153 (no `@types/node`) | Pre-existing. The rewrite of `articles-api.ts` removed 39 of them |
| I | Chrome removed `--load-extension` in v137 | Testing only. Loading unpacked from `chrome://extensions` still works. The extension test suite runs on Chrome for Testing 127 |
| J | The corpus `reindex` tool replies `"reindex started"` but actually awaits completion | Cosmetic |
| L | `test/composer` has two failing tests on `main`, unrelated to this work (`an encrypted note resolves…`, `encrypted flag survives…`) | Confirmed pre-existing by stashing this branch's changes and re-running. Not investigated |
| M | Four of the eight suites written during the build are still gone — the HTTP routes, the summary, the Chrome extension driven over CDP, the Swift-to-server round trip. And the iOS share-payload test (16 assertions) still lives in a temp directory | Two have been rewritten into their repos: `server/test/articles.test.ts` (23 tests) and `corpus/tests/test_indexing.py` (42 checks). The share-payload one needs an Xcode test target in `carnet`; the others are lower value — the Chrome one especially, being expensive and brittle for 400 lines of extension |
| K | The web clipper is untested on Firefox | `background.service_worker` needs to become `background.scripts` for Firefox's MV3 |

---

## Verification

277 assertions ran during the build and passed. Only some are still runnable —
see open point M:

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

Of those, what lives in a repo and can be run again:

- `server/test/articles.test.ts` — 23 tests, 52 assertions, `bun test`. The
  frontmatter titles that used to break parsing, slug collisions, canonical-URL
  dedup, the bookmark and its completion, JSON-LD `@graph`.
- `corpus/tests/test_indexing.py` — 42 checks, no framework and no network.
  Source routing and its exclusions, the corpus vocabulary being unoverwritable,
  the preamble riding along without being stored, `force`, `prune`, filters, and
  the frontmatter a hand-edited garden really produces. Found three defects on
  its first run.

The iOS share-payload test (16 assertions) still needs a home.

Live checks after deployment: the API answers 401 (not 404) on the new routes;
the gateway exposes `corpus__index_path` and a `corpus__search` carrying
`filters`; the web engine renders the byline, the summary block and — for the
first time — a fragment.

Three real Anthropic API calls were made during development (~7 cents total) to
verify the request shape and the summary's quality in French and English.
