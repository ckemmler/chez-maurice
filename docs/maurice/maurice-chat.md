---
title: The chat experience
date: '2026-09-26'
flags: []
locale: en
description: Streaming render, tool-result data cards, math, markdown, images, dictation,
  the model switcher, the cost meter and its per-conversation summary — the native chat surface.
tags:
- maurice
- documentation
- feature
- chat
- app
icon: message-circle
parent: maurice-docs
---

# The chat experience

The chat surface is native SwiftUI (`app/Maurice/Views/ChatView.swift`, with streaming in `Services/ChatService.swift`). It consumes the [[maurice-server|server's stream]] and renders it the way a thoughtful reader wants: text that arrives at a human pace, tool results you can trust, math that looks like math.

## Finding a past conversation

The sidebar's bottom bar carries a magnifier (facing the household switcher);
tapping it opens a full-width search field in its place — the iOS 26
"minimized search" idiom, drawn in our own bar and morphing on OS 26. Two
characters in and the list becomes hits — the room plus the passage that matched, matched words
bracketed — from `GET /api/conversations/search`, a **full-text search over
messages** (an FTS5 index kept in step by triggers, see [[maurice-data-model]]),
scoped to the member's own rooms and never matching a turn by someone they have
blocked. A title match counts too. Clearing the field brings the recency list
back. The [[maurice-composer|composer]]'s picker reaches into the same index.

## The conversation header and its details sheet

There is no title bar over the stream. On iPhone the header is two floating
glass groups — back on the left, "add someone" + "…" in a capsule on the right;
on iPad and macOS the same actions sit in the system toolbar (macOS with an
explicit sidebar toggle). "…" opens the **details sheet**: the title, editable —
Save sends `PATCH /api/conversations/:id` and the sidebar follows in place —
plus the metadata the old bar showed (Maurice, model, created, last message,
message count, the room's people) and the room actions (edit Maurice, review
reports for the operator, leave the room). When the cost meter is on, the sheet
also carries the conversation's totals (see below).

## What Maurice knows before you type

In a conversation you have alone with him, Maurice reads the briefs of your [[maurice-domains|domains]] — the short texts he keeps on the parts of your life he follows — under one budget, after the persona and whatever the [[maurice-composer|composer]] loaded. Never in a room. What he read is what the domain page shows, so a correction there is what he reads from the next turn on.

## A conversation Maurice opens

Since 19 September 2026 a conversation can begin with Maurice. The server creates it for one member with a first message in his voice (`conversations.opened_by = 'maurice'`, `server/src/services/openedConversations.ts`), gives it a title (the one asked for, else the first line of the message), and leaves it unread: the member's global socket receives a `conversation_opened` event, and a member with no socket live gets an APNs push ("Maurice: …"), the way a room notifies its members. In the sidebar the row carries one quiet caption under its title, "Opened by Maurice" — the first author tells it apart, not a colour — and the unread dot until it is opened; the list rows carry `unread` so a cold start shows the dot too, and the foyer badge counts it. Opening it marks it read; replying is an ordinary turn, charged to the member. [[maurice-carnet|Carnet]] lists and reads these conversations too (since 19 September 2026, on its Domains shelf) and registers for the push under its own platform, `carnet-ios`; it cannot answer, and the push reaches it only once the server sends under Carnet's own APNs topic.

**The mailbox in numbers** (26 September 2026, the second night that opens one; `services/mailScan.ts`, the text in `services/mailOpener.ts`): once a member's mail header walk is done ([[maurice-tools]]), and once per member, Maurice opens a conversation titled *Your mailbox, in numbers* — four short paragraphs, rendered by the server in the member's language with no model: what the box holds ("164 194 messages in all, 134 488 of them newsletters and notifications"), how many real exchanges the last three years hold, what reading them gives ("I can read them, over three or four nights, and tell you who matters to you and what is going on" — the nights in words, never "tomorrow morning"), and *Shall I read them? Yes or no.* **No money in it**, by decision the same evening: spending is abstract to a member and the household's cap is the only ceiling, so the cost range the server computes (`readingCost`, the light pass alone → the light pass plus a full reading on the everyday model) goes to the log for the operator and never to the member; the yes is consent to read, not a purchase. No sender, no subject, no thread: that is the report, asked for by name. Settled the same day: it walks **past the opening guard** (`force`) — a walked mailbox is worth the exception — and it is opened once, recorded in `<app dir>/mail-nightly.json` and, since the evening, linked to its member in `mail_conversations`. **The yes** (lot 3, the same evening): in that conversation, and there alone, Maurice holds one native tool, `mail__approve_reading`, granted by the conversation the way the domain tools are ([[maurice-tools]]); the prompt tells him to call it on an explicit yes or no only — never on a hint, an "ok" to something else, or his own judgement — and, after a no, never to ask again. The yes is a consent, not a purchase: it leaves a `reading` job approved in the member's own mail store for the night of lot 4, spends nothing, and Maurice answers that the reading happens at night, from the next one, and that he will come back with what he understood. The member can also answer from the card under *Settings → Mail* (approve, or withdraw), and what they did there appears in the thread as a message of Maurice's, rendered by the server in their language — the same motif as the domains' drawer.

What the model sees: the history would start with an assistant turn, which the Messages API refuses, so one constant user lead (`[Maurice opened this conversation on his own. His first message follows.]`) is placed before it, after the context window is cut, for every provider.

Who may receive one: never a child (`users.is_child`, a box in the console's member page), never a guest (their life is in another household), and never twice within the household's number of days (fifteen by default; "Days between two conversations Maurice opens" in the console's settings). Two callers open one: the operator — `POST /api/admin/conversations/open` with `{username | member_id, text, title?, maurice_id?, force?, dry_run?}`, or `scripts/open-conversation.sh <username> "<text>"`, no model called — and, since the evening of 19 September 2026, **the night that proposes [[maurice-domains|domains]]**: since 20 September 2026 its first message is **rendered by the server** from what the mapping found — the model writes only the introduction, the nuances and the invitation; the server writes what a domain is and what it feeds, then every alive proposal with its weight on five dots, its conversations, its share and its recent ones, the lived ones named apart — the row carries the proposals, and in that conversation alone Maurice holds four tools — propose, adjust, adopt, seed — to settle them in the member's words; nothing becomes a domain without their yes ([[maurice-tools]]). Under that first message the app draws one button, **"Define my domains"**, for as long as the server lists open proposals (`GET /api/domains/proposals` — the state is the route's, never read off the text), which opens the drawer described in [[maurice-domains]]; what the member decides there comes back into the thread as a message of Maurice's, over the room channel. Replying is an ordinary turn on the member's own model.

## Streaming

The client reads the newline-delimited `StreamEvent`s and reacts per type: `text_delta` appends to the live text, `thinking` raises a "Thinking" activity label until the first visible word (reasoning models such as GLM go quiet for a while before answering, see [[maurice-personas-hats]] for the dial — since 24 September 2026 a turn that made no choice is sent `reasoning_effort: low` on Z.ai rather than nothing at all, because GLM cannot be told not to reason and its own default is a minute of it: a seeded domain, which carries no choice, was answering in two minutes on GLM-5.3-Flash where the same model answers in ten seconds), `ping` is a server keepalive and shows nothing, `tool_call` feeds the turn's activity line (below), `tool_data` appends a structured result (rendered as a **source card** for a corpus or web search since 20 September 2026, see below), `usage` is kept for the cost meter, `done` captures the `message_id`, `error` surfaces a banner. Image generation shows a spinner while it runs, then drops the image inline.

Two touches make it feel alive rather than mechanical:

- **Variable-speed reveal** (`StreamingRow`): a 0.01s timer advances the visible text by 1–3 characters a tick, faster when the buffer is deep — roughly 100–300 chars/sec, so it reads like typing, not like a progress bar.
- **Respectful auto-scroll**: the view follows the bottom only while you're near it (within ~120pt); scroll up to re-read mid-answer and it won't yank you back; scroll back down to re-engage.

**One line for what the turn is doing, 23–24 September 2026.** Each call used to set an activity label and clear it on the way out, so a turn that searched three times and read the corpus once flashed four labels under the answer, one after another, while the source pills landed live underneath them and a wave of three dots had greeted the turn before any of it: the work Maurice was doing read as agitation, and two progress marks were often up at once. What a turn does now folds into **one row** (`TurnActivity` in `ChatService`, `TurnActivityRow` in the view), from the first instant of the turn to its end: the **source pills** found so far (tap: the drawer), then the steps done — the same tool twice counted rather than repeated, *Recherche web ×3* — then, after a dash, the one running (*Recherche sur le web…*, or *Réflexion…* while a reasoning model is quiet), then the **pulse** and a clock from the start of the turn. The pulse is the turn's only progress mark: the three dots are gone, and until the choice is settled the member picks the pulse in Settings › Activity among four candidates (halo, orbit, stroke, the hat — `ThinkingPulse`, a device preference). A tap on the words opens the row into a list, one step per line. When the turn ends the row **stays under the reply**, pulse and clock stopped, pills included — the record of what the answer took — and the reply draws its sources nowhere else. That recap is session-lived: the server persists data blocks, not the tool trail, so a thread reloaded from scratch shows its pills alone and no recap. The names are tensed — *Recherche sur le web* while it runs, *Recherche web* once done — and an MCP tool is named by its server segment (*Outil corpus*).

Two failure modes fixed in September 2026: deleting a thread while Maurice was still answering left the [[maurice-server|server]] running its tools for a room that no longer existed (a fragment landed in a garden fiche a minute after the delete), so the app now stops the stream before deleting; and a room that answers 404 — deleted here, or from another device — is dropped along with its socket, where before the socket reconnected with backoff forever and refetched the vanished conversation for hours.

**A reply survives the cut (19 September 2026).** A turn belongs to the conversation, not to the request that started it (see [[maurice-server]]). When the member switches app or locks the screen while Maurice is answering, the iPhone app first asks iOS for a few seconds of grace (short replies finish normally); if the connection is lost anyway, the activity line under the reply says "Connexion perdue, Maurice continue…" and the app re-attaches to the turn with `GET /api/conversations/:id/turn`: it receives everything produced meanwhile (text, data blocks, the tool at hand, the cost) and then the rest live, and the reply goes on on screen as if nothing had happened. If the server answers that nothing is running any more (`204`), the thread is reloaded: the reply, if it was finished and persisted during the absence, is there. Coming back to the foreground reconnects both live channels (room and member) at once instead of waiting out their backoff — and since 20 September 2026 a reconnect that missed nothing changes nothing on screen: the list and the thread it re-reads are assigned only when a row differs, where before every reconnect rebuilt the sidebar, the header and every message row — and re-attaches the same way to a turn started in the last five minutes whose end was never seen. The error banner (an orange capsule with an icon since 20 September 2026, no longer a red slab over the composer) only appears when the re-attach itself fails three times or the server refuses, and it stays until the member taps it or sends again — a refresh that succeeds no longer wipes it, which was the origin of the red "flash" that hid every error until then. That stickiness is for the reply only: a **background load** that the network drops (the list of conversations, a thread, a room action — the phone waking up, the radio switching) shows a quiet capsule above the composer, "The network did not answer", cleared by the next load that goes through or a tap (20 September 2026; before that the system's "The request timed out." painted the composer red and stayed).

**Stop.** Since generation no longer stops when a client disconnects, ⏹ first tells the server (`POST /api/conversations/:id/turn/stop`), then cancels the local stream; what was produced reaches the thread over the room channel. Leaving the thread or deleting the conversation mid-reply goes the same way.

**One reply at a time.** Sending while Maurice is already answering in that conversation (a previous request the server picked up, or another device) gets a `409`: the app removes the refused message from the thread, says calmly "Maurice est déjà en train de répondre dans cette conversation." and re-attaches to the reply in progress to show it.

## Tool-result data cards

When a turn calls a data-returning tool, the result rides the `tool_data` channel and renders as a **data card** (`DataCardStack`) beside the prose, titled `"{tool} · {n} rows"` (e.g. `signals · 12 rows`), capped at 50 rows with a "+ more" tail. This is deliberate: the rows are drawn **from the data the tool returned**, not from the model's retelling — so Maurice can't silently misreport what a tool found. It is the floor under tool-result hallucination. A fiche the garden tool opens comes back the same way, as a card you can act on.

## Math

LaTeX renders properly. `renderMathMarkup()` preprocesses the text *before* MarkdownUI sees it: a regex picks out `\(…\)` (inline), `\[…\]` and `$$…$$` (display), **skipping fenced and inline code**, and rewrites each into an image tag `![](maurice-math:<base64url>)`. Two providers then draw them with **SwiftMath** — `MathInlineImageProvider` in text style, `MathBlockImageProvider` in display style (falling back to monospaced source if a formula won't render).

## Markdown, code, images

Prose is **MarkdownUI** themed to the Maurice palette (code spans and blocks in `codeInk`/`codeBg`, blockquotes with a rule-coloured border, links in `ink`). Inline images use `![](/api/images/…)` rendered via `ChatImageView`. Text selection is native click-drag on macOS; on iOS a long-press on a message offers **Copy** or a **"Select text…"** sheet where a selection can span paragraphs. Each Maurice answer carries **Copy** (strips image markup, text only) and **Regenerate** (last turn only, disabled mid-stream). Since 24 September 2026 the same arrow also sits under the member's **own last message when no reply followed it** — an error, a refusal, a lost connection — so a turn that stuck can be played again; switching the model in the composer pill first plays it on another one. The server drops the previous answer only when the thread actually ends on one (until then it took the most recent assistant message wherever it stood, so a retry after a failed reply erased the answer before it). Photos are sized to the vision tier's ceiling before upload, in the app and again on the server. A photo reaches the composer from the camera, the photo library, or the **clipboard**: ⌘V in the field on macOS (pixels, or a copied image file), ⌘V from a hardware keyboard on iPad when the clipboard holds an image and no text, and a *Paste Image* item in the paperclip menu on both platforms, shown only while there is an image to paste.

## Dictation

Since August 2026 the composer takes **dictation**: on-device speech recognition in the member's language (any regional variant), text shown as it is spoken, inserted at the caret, listening through pauses, and a manual edit winning over the transcript. Apple's servers are used only for languages with no local model, and only if the member allows it in Settings. On iPhone the **Action Button** opens a fresh thread and starts listening (`DictateIntent`).

The composer's input row keeps one **+** on the left (camera, photos, files, pasted image, add context, the conversation's tools) and puts the **mic beside the send button**. While listening, the gap between the model pill and the mic shows the microphone's **loudness as a scrolling waveform** (25 September 2026): the audio tap reduces each buffer to its RMS and hands the view one value every ~50 ms, never the audio itself. An input that changes mid-sentence (AirPods connecting; the Simulator rebuilding its device) no longer ends dictation: the engine restarts on the new input and what was heard is kept, up to three times a session; a call or Siri still stops it. A multi-channel input (a USB interface on iPad, the Simulator's ten channels) is reduced to its first channel before recognition, which otherwise returned nothing at all.

## Model switcher

The composer's model pill opens a Menu grouped by provider (Anthropic, OpenAI, Mistral, Z.ai, Ollama), each with its brand-coloured dot, limited to the providers the household has a key for. The choice persists onto the active Maurice — the member's everyday preference, or the persona's own `model`. See [[maurice-personas-hats]].

## The cost meter

Off by default; "Show what each reply cost" in Settings turns it on. A coin then joins the copy and regenerate controls under each of Maurice's replies, with the turn's cost and the share of the prompt served from cache beside it; tapping the coin drops down a popover with the token split, the uncached figure for comparison, the number of rounds and the model (a popover on the phone too, not a sheet, and the transcript never reflows). Local models are free; cloud models show a figure when their price is on file (Anthropic, Mistral Medium, GLM-5.3 and Flash), token counts otherwise — never a bare "$0.00" for a model nobody has priced. The data is the `usage` event the [[maurice-server|server]] emits and stores on the message.

The same switch adds a **"Cost and tokens" section to the details sheet** behind "…": the whole conversation folded into one figure per column. Total cost first (with how many of the metered turns were priced when the sum doesn't cover them all), the average and costliest turn, what the thread would have cost without cache and what the cache saved; then the number of metered turns (with the count of turns that carry no usage — local models before the server recorded it), the model calls, the share of all prompt tokens served from cache, the prompt split (fresh / from cache / written), reply tokens and the grand total; and one line per model that answered, with its turns and its share of the cost. It is computed client-side (`ConversationUsage`) from the usage persisted on each assistant message, so it is exact for the messages on screen and needs no route; a conversation with no metered turn says so instead of showing zeros. Cost and token figures are spelled by one `UsageFormat` helper, so the coin and the summary can't disagree on rounding.

## Platform

The app adopts **Liquid Glass** on iOS/macOS 26 (a material fallback before; the deployment target stays iOS 17 / macOS 14) through one shared helper file, `app/Maurice/Views/Glass.swift`: the composer floats over the stream as a glass panel on every platform, custom controls (icon buttons, pills, fields) are interactive glass, `.bordered` buttons take the system glass styles, and the split view's sidebar keeps the system material. This deliberately goes further than Apple's "use sparingly" guidance — glass sits on glass in the composer — and every helper can be dialled back per call site. "Reduce transparency" in Accessibility renders it all opaque. Composing context for a turn is the [[maurice-composer|context composer]].

## Ships vs. exists

The chat surface — streaming, data cards, math, markdown, images, dictation, model switching, the cost meter and its conversation summary — is **core and ships**. Data cards will show results from any tool, but most data-returning tools are the experimental [[maurice-tools|fleet]]; with garden-only, you mostly see prose plus the occasional garden result.

## Gaps & notes

- **Image generation has no progress** — a spinner and label, not a percentage.
- **Files reach a chat only through the composer's omnibox**, not a drag onto the transcript (see [[maurice-files]]).
- **Regenerate is single-step** — it re-runs the last turn; there's no branch/alternatives history.
- **No web chat client.** The only conversational surface is the native app; the web is the garden.
- **No cross-conversation cost view** — the summary is per thread; there is no household or monthly total anywhere in the app yet.
- **The screen "flashing in dark tones" on the iPhone (20 September 2026)** while the owner read the opening message is diagnosed, not seen: the server log shows the app re-reading the list and the thread every ~150 s in front, which is both sockets dropping (a silent WebSocket closed on the path) and reconnecting, each time replacing `conversations` and `messages` wholesale — a full re-render of the split view and of a long markdown message under Liquid Glass. Two fixes shipped (the server's keepalive, the app's restraint on reassignment); whether the flash was that re-render or the glass sampling a rebuilt backdrop is to be seen on the phone.
- **The mail conversation's yes triggers no reading yet** (lot 4): Maurice says "from the next night on" and the night does not read. Tested on the owner's real thread the same evening: on "Oui, lis-les." the model called the tool once (70 ms) and answered in two rounds; the job sits `approved` in the store, `job_id` null on the turn's ledger row.
- **The details sheet does not say who opened a conversation** — only the sidebar caption does; and the user lead placed before Maurice's opener is one English sentence the model reads as the member's turn, to be watched on the first real exchanges.

## Source cards — what a search found *(ships, 20 September 2026)*

A search answers with a list of things to go and look at, and the app used to render that the way it rendered every other tool result: a folded disclosure triangle over a key/value dump, forty fields a row, three of them useful. The web search rendered as *nothing at all* — its result never became a data block (`executeTool` set no `data` on that branch), so the only trace of twenty-seven pages read was whatever the model chose to retype.

Both now produce one payload, `card: "sources"` (`server/src/services/sourceCards.ts`), drawn by `SourcesCard.swift`. What stays in the transcript is a **line of pills**: four overlapping 20-point thumbnails and a count, the height of a line of text. Tapping it opens a **drawer** holding every source at a readable size — cover, title, where it came from, and the passage that matched — where a web source is a link and a garden one is not, having nowhere to open to. The first version drew the cards inline, in a scrolling row, and took more room under every reply than the reply itself: evidence should be at hand, not in the way.

Three things the first run against the real index taught, all of them now pinned by tests:

- **The cover is stated more often than derived.** The garden's frontmatter names an image in four incompatible dialects — a local `image` on cards and article fiches, a Google Books `thumbnail`, a TMDB `poster_path`, a Wikimedia `image_filename` — and only the first resolves without inventing a CDN prefix. The first draft derived the path from `resource_collection` + `locale` + `resource_id` and found no cover at all, because a *card* says `translationKey`, not `resource_id` — and carries `image` outright anyway. So: the frontmatter first, the conventional name as fallback, and the file stat-ed either way. A card with a broken image is worse than a card with an icon in a box. The URL handed over is the open twin, `/api/garden-images/…`, since an `AsyncImage` sends no credentials and the authenticated `/images/…` would 403.
- **A source is not a chunk.** One Guardian article came back four times, being four passages of the same file; a conversation came back three times under three chunk ids. Results are de-duplicated by `conversation_id`, else file path, keeping the best-scoring passage, and the count reported is of distinct sources.
- **An article remembers where it was read.** A garden card keeps the `url` it came from, which becomes the card's link — the one kind of corpus hit that has somewhere to open.

Tavily gives neither image nor favicon, so a web source shows its domain and the site's initial: what we actually know, and no request from the member's phone to twenty-seven third parties.

The model sees none of this — it keeps receiving the tool's own text, the card rides the parallel `data` channel — but `TOOL_DATA_DIRECTIVE` was narrowed: the sources are shown, so it should not list them back, while what they *say* is still prose only it can convey. Naming a source in a sentence, to make clear where a fact came from, is not listing.

**One row per place searched, and a budget on the searching, 21 September 2026.** A card is drawn per *search*, and nothing capped how many a turn could run: asked what Scoodle, Plantyn and Capture were, a turn ran **six web searches and two corpus ones over five rounds** — three of the six about the word *Capture* alone — and the answer, which was good, arrived under eight rows of pills and forty sources, ten of them noise from the corpus. `MAX_TOOL_ROUNDS` (six) was the only guard, and a round may hold any number of calls, so the real ceiling was none. Two halves fix it, one on each side:

- **A budget per turn**, in `server/src/services/searchBudget.ts`: **four web searches, three corpus ones** — one per layer the prompt asks for — and a **repeat check** on the query itself, which answers a reworded search from the one already run. The threshold is the content-word overlap: of the fifteen pairs that turn produced, 0.56 for the pair that is the same search reworded, then 0.42 and down, so it sits at **0.55**, in the gap. A first pass put it at 0.6 and caught nothing at all. Neither refusal is an **error** — a model told "error" here reaches for the other search tool, or rewords again — both come back as an ordinary result saying the budget is spent and to answer with what it has.
- **One row per origin** in the app (`DataCardStack.typedItems`): however many searches a turn ran, the member sees one line of pills for the web and one for the corpus, at the point where the first of them appeared, the same page found twice counted once (by URL for the web, by title and source otherwise). The drawer lists **every query that was asked**, which is the honest account of how the answer was arrived at, and the only place with room for it.

Two prompt lines came with it, both about the same habit. The corpus is **not** a way to check an outside fact — what a school's app is, what an error code means — which the web answers and a member's own writing does not, and it is **not an afterthought**: search it in the first round, while it can still shape the reply, since a search run after the answer is written adds nothing but a row of sources under it. And the tools are to be used *quietly*: the app shows the member every search, so "let me check", "I'm looking into this" and "one more search to be sure" are lines they read between their question and the answer — over five rounds they accumulate into a running commentary, which is what that turn actually shipped.
