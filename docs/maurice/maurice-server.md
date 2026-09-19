---
title: The server
date: '2026-09-19'
flags: []
locale: en
description: 'The Hono/Bun engine: API surface, the streaming agentic loop, prompt
  caching and the context window, provider selection, auth, MCP execution, rooms,
  and push.'
tags:
- maurice
- documentation
- architecture
- server
icon: server
parent: maurice-docs
---

# The server

A single **Bun** process running **Hono**. It is the whole backend: the native [[maurice-chat|app]] and [[maurice-carnet|Carnet]] hold no authoritative state — they send and render what streams back. Everything else lives here and on disk.

The process has two halves, both mounted in `server/index.ts`:

- **`server/src`** — the **chat engine**: auth, users, conversations, personas, files, gardens, the composer, models, tool families, moderation reports, and the streaming loop that calls the LLM and runs tools.
- **`server/data-api`** — the **personal-data layer** at `/api/v1/*`: health, tasks, signals, tracks, coaching, Calibre, places, uploads, bank — and the garden's media (articles, entries, résonances, flashcards). Part of it backs the experimental [[maurice-tools]]; the garden-media part backs [[maurice-carnet]] and ships with the garden.

The process listens on `PORT` (3001 at home), serves generated images and avatars, proxies `/mcp/*` to the MCP gateway, serves each member's garden under `/g/<member>/` by proxying to that member's Astro engine, and upgrades WebSocket connections for live rooms. At home it runs as the `com.maurice.api` launchd agent, and since 9 September 2026 also as a **Linux container** on :13001 — the shape the product ships in, running beside the Mac on a copy of the data until the port is validated (see [[maurice-architecture]]). The proxies to the gateway and to Astro are hardcoded to `127.0.0.1`, which is why the container holds all three processes rather than splitting them.

## The API surface

Route groups mounted from `server/src/routes` (chat engine):

| Group | File | Purpose |
|---|---|---|
| `/api/auth` | `auth.ts` | Setup, login, device enrollment, invite/pairing codes |
| `/api/users` | `users.ts` | Member roster, profiles, avatars, preferences, API tokens, guest contacts |
| `/api/conversations` | `conversations.ts` | Threads and rooms, messages, **streaming replies**, participants, read state, per-conversation tool-family overrides, `/search` (full text over a member's own rooms) |
| `/api/maurices` | `maurices.ts` | Specialized [[maurice-personas-hats|personas]] (name, hat, prompt, model, bound context); the list is headed by **Maurice Maurice**, the built-in specialist of Maurice, who has no row, refuses `PATCH` and `DELETE` (403), and answers from the documentation in `docs/maurice/` (or `MAURICE_DOCS_DIR`) on a model the server picks |
| `/api/files` | `files.ts` | The [[maurice-files|files library]] — folders and uploads |
| `/api/v1/gardens` | `gardens.ts` | [[maurice-shared-gardens|Shared gardens]] — per-note sharing, web theme per audience |
| `/api/v1/composer` | `composer.ts` | The [[maurice-composer|context composer]] — omnibox search and context assembly |
| `/api/models` | `models.ts` | Available models per member; everyday-model preference |
| `/api/tool-families` | `toolFamilies.ts` | Tool groupings the conversation/persona may use |
| `/api/reports` | `reports.ts` | Operator-only moderation of reports filed in shared rooms |
| `/admin`, `/login` | `admin.ts`, `web-admin.ts`, `web-login.ts` | Household admin web UI: members, models and their context windows, provider keys, Calibre library, access matrix, spending caps, the docs refresh, the household export |
| `/api/admin/export` | `admin.ts` | The household archive (`maurice-archive` v1, `services/archive.ts`), `application/gzip`, streamed; admin token. `GET /admin/export` is the same behind the console cookie — see [[maurice-households-rooms]] |
| `/api/me/usage`, `/api/admin/usage` | `me.ts`, `admin.ts` | What a member spent today and this month against the tightest cap that applies to them; the admin's view of everyone — see *The spending fuse* |

The **data-api** mounts under `/api/v1/*`:

| Group | Purpose |
|---|---|
| `health/*`, `signals`, `coaching`, `tasks`, `tracks`, `dossiers`, `layouts`, `dashboard`, `places`, `uploads`, `compte`, `bank-transactions` | The [[maurice-life|life capabilities]] and dashboards |
| `garden-tools/*` | The garden owner's toolbar — toggles, delete, reorder, editor targets, publishing. Each route acts on the **caller's own** garden (no member in the URL); see [[maurice-web-garden]] |
| `calibre/*`, `books` | Books, chapters, summaries, covers, highlights, reading position, bookmarks — [[maurice-carnet|Carnet]]'s reading backend |
| `garden/articles` | Save a page as an article fiche (share sheet, clipper, MCP), list and read them, summaries, highlights, notes |
| `garden/entries` | Every entry of a member's garden, all collections, with its card, fiche and flashcard faces |
| `garden/links` | Résonances — `[[wiki-links]]` written into the target's markdown |
| `garden/cards` | Flashcards — generate, list, review, edit |
| `articles/scrape` | Legacy alias of `garden/articles`, kept for older Carnet builds |

The garden-media routes are documented from the feature side in [[maurice-knowledge]].

## The streaming chat protocol

A turn is one HTTP request that streams back many events. The client POSTs to `POST /api/conversations/:id/messages`; the server stores the message and returns a `ReadableStream` of **newline-delimited `StreamEvent` JSON** (`server/src/services/claude.ts`). The event types are exactly:

- `text_delta` — a chunk of the model's prose
- `thinking` — the model is reasoning and nothing visible is coming yet. Raised from an OpenAI-compatible provider's `reasoning_content` deltas (GLM, DeepSeek-style), throttled to one a second; the reasoning text itself is never forwarded. Anthropic and Ollama turns don't emit it (Ollama runs with `think:false`).
- `ping` — keepalive, sent after 15s without any other byte on the wire. The app's stream request gives up after 180s of silence, so without this a long reasoning phase or slow tool would leave the reply in the database and a timeout on screen.
- `tool_call` — `{ status: "start" | "end" }` around a tool invocation
- `tool_data` — the **structured result** a tool returned (JSON rows), rendered by the app as a data card beside the prose
- `usage` — what the turn cost, summed over its agentic rounds: input, output, cache reads and writes, rounds, and a priced figure when the model has a price on file (`pricing.ts`). Emitted once, before `done`, and stored on the message.
- `done` — turn complete, with a `message_id`
- `error` — fatal error with a message

**A turn belongs to the conversation, not to the request that started it (19 September 2026).** `services/turns.ts` keeps, in memory, the reply in flight for each conversation: the text sent so far (the same `text_delta` chunks the client received), the `tool_data` blocks, the tool at hand, the usage once reported, the terminal event and the `AbortController` the generation runs under. The pump behind `POST /api/conversations/:id/messages` records every event there before writing it, and writes only while the request is still attached: a client that vanishes — iOS suspending the app when the member switches away or the screen locks, which is how a reply "never arrived" while the server had finished it — no longer stops the reply, which runs to the end, is persisted and fanned out over the room socket as before. A client whose stream died re-attaches with `GET /api/conversations/:id/turn`: `204` when nothing is known, otherwise NDJSON opening with a `resume` line (`text`, `data`, `tool`, `usage`, `started_at`, `finished`) followed by the live events to `done` or `error`, with the same 15 s `ping`. A finished turn stays reachable for 60 s and answers `resume` (`finished: true`) plus its terminal event. Stopping is explicit: `POST /api/conversations/:id/turn/stop` aborts the generation and keeps what streamed (`{ ok: true }`, or `404` when nothing runs) — cutting the request no longer stops anything. One reply at a time per conversation: a summons or a regenerate while one runs is `409 { error: "A reply is already in progress" }`; the human message is still stored and broadcast, only the summons is refused.

The `tool_data` channel is deliberate: tool results are rendered deterministically from the data, so the model's prose can't silently misreport what a tool returned. See [[maurice-chat]] for the client side.

## The agentic loop

For each user turn (`streamResponse` in `claude.ts`):

1. Build the **system prompt** — household context, the member's profile, and the bound persona if one is armed, then the [[maurice-composer|composer context]], then a non-negotiable content-safety floor, always last. A multi-human room uses a variant that prefixes each human line with the speaker's name and frames Maurice as a *summoned participant*.
2. Build the **messages** from the conversation history, with the clock as a trailing system-reminder turn (never in the system prompt — a minute-ticking prefix would make the whole prompt uncacheable). An assistant turn that called tools carries a compact **tool trail** — its stored `messages.data` results, six at most, 240 characters each — appended to its text, so the next turn reuses what the last one found (the book's calibre id, the reader's chapter) instead of looking it up again. Before this (September 2026) every turn of a reading companion started over: three tool rounds and thirty seconds to rediscover the book.
3. Resolve the usable model and provider.
4. Fetch the MCP tools the conversation is allowed (filtered by tool families) via `server/src/services/mcpClient.ts`, sorted by name so the roster is byte-stable from turn to turn.
5. **Fit the conversation to the model's context window** (`contextWindow.ts`). The roster's `ctx` for the model, less the head (system prompt + tools), less a reply reserve (the household's `max_tokens`, capped at a quarter of the window), less a margin, is what the history may occupy. Over that, the oldest turns are dropped down to 70% of the budget — hysteresis, so a drop buys many turns — and the cut is stored on the conversation (`context_from`) so the next turn sends the same prefix. The window always opens on a user turn; the turn being answered and the clock are never dropped. A constant note in the system prompt tells the model the beginning is missing.
6. Stream to the provider; relay `text_delta`s; on a tool-use block, run the tool (web search or an MCP `callTool`) and feed the result back. Tool results are minified (pretty-printed JSON loses its whitespace) before they go back. The member's ⏹ Stop (the request's abort signal) reaches the provider call on every path — Anthropic, OpenAI-style and Ollama — and is checked again between two tool calls, so a writing tool never runs for a thread that was stopped or deleted under it. An OpenAI-style round that sends no byte for **180 s** is given up with a named error rather than hanging the turn.
7. Loop up to **`MAX_TOOL_ROUNDS = 6`**, then stop.

Every model request logs one `[round]` line (`convo`, provider, model, round, `ms`, prompt/cached/output tokens, tool calls), every tool call a `[tool]` line, and every request line carries an ISO timestamp — a 42-second turn used to be invisible in a log with no clock.

## The spending fuse

`budget.ts`. Off by default, and on a household paying its own provider it stays
off: with neither `MAURICE_SPEND_CAP_USD` (total, over the instance's life) nor
`MAURICE_SPEND_CAP_DAILY_USD` (rolling 24 hours) set, every function in it is a
no-op. It exists for instances whose inference is paid by somebody else — the
demo fleet, where every household runs on Candide's key, and any hosted instance
sold with a bundle.

It is not the cost meter. `pricing.ts` *measures*, and that figure is
information for the person spending their own money; this *refuses*.

Three things about it are load-bearing:

- **The check is at the top of every agentic round, not once per turn.** Six
  tool rounds are six billed requests; a cap consulted only before the first
  would let the other five through, which is the runaway it exists to stop. The
  cost the turn has already run up is passed in, because the ledger does not
  learn about it until the turn is persisted.
- **Under a cap, a model with no price is refused.** `pricing.ts` is deliberate
  that an unknown model prices at `null`, never zero — right for a meter, a hole
  in a fuse, since such a model would spend real money against a ledger stuck at
  zero and the fuse would never blow. The refusal says to add the model to the
  price list. That is what put Scaleway's grid into `PRICES` on 18 September
  2026, before the demo fleet of [[maurice-scaleway-and-container]] opens: the
  ten seeded models carry the September 2026 sheet, in euros converted at one
  fixed rate written beside them, because a meter that drifts with the exchange
  rate cannot be reconciled against a bill. A model added by hand is still
  unpriced, and a capped instance still refuses it — which is the right order
  of operations before opening a demo fleet.
- **Ollama is exempt by *provider*, not by model name**, the same way
  `priceUsage` decides it. Two places disagreeing about what is free is how a
  fuse quietly stops working.

A refusal emits the turn's usage and then an `error` event carrying prose meant
to be read by the person refused — the allowance is spent, nothing is lost, the
conversation and the garden are still there. §4 of [[maurice-commercialisation]]
calls that moment the one that decides whether people trust the meter.

Spend is recorded in `spend_ledger` by `addMessage` — the one place every
persisted turn passes through, whichever route produced it. See
[[maurice-data-model]].

Since 17 September the two variables travel through `compose.household.yml`
(they did not: the file lists its environment explicitly, and a cap set in a
household's env file went nowhere), and the fleet host's `defaults.env` sets
`MAURICE_SPEND_CAP_DAILY_USD=10` for every household it starts — these
instances think on Candide's keys. Raise or drop it per household in its own
env file.

**Since 19 September the fuse has three layers, and the tightest wins.** The
instance's env caps stay the operator's fuse, summed over the whole household.
Below them the household carries its own daily cap
(`households.spend_cap_daily_usd`, the "Daily spending cap" field on the
console's settings card), also summed over everyone; and each member can carry
theirs (`users.spend_cap_daily_usd`, on the member's edit page), summed over
that member's turns alone. The verdict weighs them most-specific first, so a
refusal names the cap closest to the person reading it — "You have reached
your daily limit…", "This household…", "This instance…" — and `remainingUsd`
is the tightest headroom. Ollama stays exempt; an unpriced model under any cap
is still refused. `spend_ledger` now records `user_id` — the member whose turn
it was, in a room whoever sent the message Maurice answered — and both agentic
loops hand that id to the verdict every round. A member reads their own
situation on `GET /api/me/usage` (`today_usd` over 24 rolling hours,
`month_usd` over the calendar month at the server's clock, `cap_daily_usd` =
the tightest daily cap that applies to them or null, `remaining_usd` or null);
the admin reads everyone's on `GET /api/admin/usage`, and the console shows
each member's spend today in the members list, with today and this month on
their page. What is still missing is above the fuse: a balance, a statement a
customer can read, and a quota that is money someone paid rather than a limit
someone set — §4 of [[maurice-commercialisation]].

## Prompt caching

Anthropic caches by prefix, at explicit breakpoints, and bills a cached read at a tenth of a fresh token. The loop is what makes this worth doing: every round re-sends the system prompt, the tool roster and the whole history. Three breakpoints, inside the cap of four: on the last system block (which covers the tools, rendered ahead of it), on the end of the conversation history (carries from one turn to the next), and on the growing tool-result trail (moved along each round). Placement only lands on blocks the server builds itself, never on a history message, so the cache key is computed from bytes that don't change. The cost meter shows what caching saved next to what the turn cost.

Z.ai's cache is implicit — no markers, and the cached reads come back in the standard OpenAI usage field, which the OpenAI-style loop already reads.

**Mistral caches nothing unless the request carries a `prompt_cache_key`.** Nobody had sent one, so over 430k input tokens of Mistral Medium turns not a single one was served from cache; the OpenAI-style loop now sends the conversation id as the key (`PROMPT_CACHE_KEY_PROVIDERS`: Mistral and OpenAI — Z.ai and Scaleway cache on their own and are not sent a field they might reject). Measured the day it landed: a two-round turn's second round read 34,816 of 34,994 tokens from cache, halving the turn's cost. A 400/422 retry drops the key along with `stream_options`.

**Scaleway** caches automatically, per project, with no parameter (its FAQ: the cache is persisted and evicted by request frequency, 50–90% hits on recurring prefixes, not guaranteed, at a discounted rate). Measured on 18 September 2026 from maurice-fleet, straight against the API: **only DeepSeek V4 Flash reports it** — `prompt_tokens_details.cached_tokens` plus a `created_cache_tokens` of its own, in the streamed usage chunk too, so the loop's OpenAI-style reading works unchanged and the meter prices the read at 0.2 (€0.08 over €0.40). The nine other models return `prompt_tokens_details: null`: whatever they cache is invisible in the response and shows, if anywhere, only in Cockpit. How DeepSeek's cache behaves there: hits are counted in 64-token blocks and only on a prefix that has become *hot* — a fresh 3.3k-token system prompt missed its first four to ten sends, then hit on roughly half of them, and after some forty sends hit nearly every time; the tail added to a hot prefix (the conversation's own turns, a tool round's results) went on missing across fifteen re-sends. So the household-wide prefix (persona, tools, loaded context shared by many turns) is what gets served from cache, and the per-conversation, per-round remainder is paid at full price — unlike Anthropic, where the trail breakpoint catches every round. `prompt_cache_key` is accepted (200) but documented as unsupported, so there is no sticky routing to ask for; time to first token showed no cache signal on Llama 70B or Mistral Small.

## Providers

The provider is chosen per resolved model (`models.provider`), not failed-over automatically:

- **Anthropic** (default for cloud models) — the native streaming + tool loop, with caching.
- **Ollama** (local models) — its own loop, `ollama.ts`; the request asks for a 32k window and the context-window fit respects that.
- **OpenAI / Mistral / Z.ai** — the Chat-Completions message shape, `openaiChat.ts` (`api.openai.com/v1`, `api.mistral.ai/v1`, `api.z.ai/api/paas/v4`). Z.ai's GLM-5.3 and GLM-5.3-Flash were added in September 2026, with their 1M-token windows and their prices (Flash priced at list, not at the promotion running to 2026-09-09). GLM-5.3 is text-only; Flash is the multimodal one of the pair and is the only GLM carrying the `vision` flag — but a Z.ai key only reaches the models its package covers, and a key good for GLM-5.3 can be refused on Flash. GLM-5.3 always reasons and its reasoning tokens arrive as `reasoning_content`, which the client drops: the answer is correct and the cost meter counts them (Z.ai bills them as output), but the first visible character can be several seconds late.

  **The reasoning switch** (18 September 2026). The reading companion on GLM-5.3-Flash was taking four minutes a turn, and the `[round]` lines said why: one round of 196 s for 10 809 output tokens, of which the visible answer and the fragment it wrote were a quarter — the rest was the reasoning phase, which Z.ai runs unless told not to and which Maurice had never told anything. Three parts now: the roster says whether a model reasons and whether that can be switched (`models.thinking`, see [[maurice-data-model]]); a persona records its choice (`maurices.thinking`, null / on / off) and the household records one for the everyday Maurice (`households.everyday_thinking`, a factory setting seeded to "answer directly", editable in the admin console beside the max tokens, since the conversation with no persona has no editor in the apps); and each provider path translates the choice into the one field it reads, sending nothing when the persona made no choice or the model has no switch. Z.ai gets `thinking: {type: enabled|disabled}` (through `openaiTurn`'s `extraBody`, so the client stays provider-neutral); Anthropic 4.6+ gets `thinking: {type: adaptive}` — the fixed budget is gone from the newer models, sampling parameters are refused beside it on 4.7+, so the persona's creativity yields to its choice to reason — or `{type: disabled}`, and the thinking blocks that come back are kept with their signature and replayed unchanged in the tool rounds; Ollama gets `think: true|false` (it was hard-wired `false`, and a model's `thinking` capability is read at discovery). Scaleway's reasoning models are `always`: they stream a `reasoning` delta and document no switch, so the setting is ignored there. Only the reasoning *activity* reaches the client, on every path, never the text.

- **Scaleway** (added 17 September 2026) — Generative APIs, the same Chat-Completions shape at `api.scaleway.ai/v1`, served from Paris; the European half of the chain [[maurice-scaleway-and-container]] describes, now real in the server. Ten models are seeded once (`scaleway_seeded` in `db.ts`): Mistral Small 3.2 — the everyday default, reads images — Gemma 4 26B, Qwen 3.6 35B, GPT-OSS 120B, DeepSeek V4 Flash, Qwen 3.5 397B, Qwen 3 235B, Llama 3.3 70B, Mistral Medium 3.5 and GLM 5.2: what Scaleway serves in Serverless mode, minus the two it has already deprecated (Pixtral 12B and Qwen3-Coder, end of life 2026-10-01). The vendor column names the maker, the provider names the host. Every one of them is priced in `pricing.ts`, in dollars, converted from the euro sheet at the ECB reference rate of 2026-09-16 (`EUR_USD`, fixed on purpose: a meter that drifts with the exchange rate reconciles against no bill) — which is what lets the fuse below work on them. Three things the build taught: a key whose IAM policy is scoped to one project is refused on the plain `/v1` root (403, "insufficient permissions") and must name its project in the URL, `api.scaleway.ai/<project>/v1` — so the admin stores a **project id** beside the key (`scaleway_project_id`), empty for an organization-wide key; the reasoning models (GPT-OSS, Qwen, DeepSeek, Gemma 4) stream their thinking under `reasoning` rather than `reasoning_content`, and the loop now reads either; and the per-minute token quota answers 429 "INSUFFICIENT QUOTA — You exceeded your current quota of tokens per minute", which contains OpenAI's out-of-credits sentence word for word and means the opposite errand, so rate-limit wording is ruled out before the billing ones. Serverless caps the output per model (16k or 32k tokens); tool calls stream by index as everywhere else; `stream_options.include_usage` is honoured, so the meter sees every round.

A provider refusing a turn on billing grounds now answers in plain language rather than a raw status line, on the OpenAI-style path as it long has on Anthropic's. The two cases are kept apart: an account that is definitely empty, and Z.ai's code 1113, whose one sentence ("Insufficient balance or no resource package") covers both an empty account and a model outside the package — reporting that as "credits ran out" would send an admin to recharge for nothing.
- **Echo mode** — if no Anthropic key is configured, the server echoes the last message back; a dev/demo fallback, not a real model.

API keys live on the single `households` row (`api_key`, `openai_api_key`, `mistral_api_key`, `zai_api_key`, `scaleway_api_key` with its `scaleway_project_id`, `fal_api_key`), set from the admin dashboard. The OpenAI-style providers share one door: `isOpenAIStyle()`, `openaiStyleBaseUrl()` and `openaiStyleKey()` in `claude.ts`, used by the chat and by the ancillary path alike, so the next provider of that shape is a column, a base URL and a price list. Each model's context window (`models.ctx`, in k tokens) is editable there too, since it now bounds what is sent. See [[maurice-data-model]].

**A key is what makes a model exist**, and since 18 September 2026 every surface says so the same way. `configuredProviders()` — a provider is configured when its key column is filled, Ollama always — already gated the apps' roster (`availableModels`) and the ancillary pins, but not the admin's "who can use what" grid, which drew a tick box per member for all twenty seeded models whatever the household could call. Ticking one promised access to something the apps never offer and a turn could never run. The grid now lists callable models only, says in a line underneath how many are left out and for which providers, and shows "no key" where a provider's model row used to claim so many members could use it. Two consequences worth knowing: saving the grid replaces a member's whole allow-list, so the rows for models it does not show are carried over rather than wiped (`accessOutside`), and a key taken out for an afternoon therefore loses nothing; and an admin still counts as allowed everything, which is a statement about permission, not about what can be called.

### Ancillary models

Everything that calls a model and is not the chat — conversation and article summaries, flashcards, signal parsing, and the Python tools' classifiers and syntheses — used to name a model in a constant and call `api.anthropic.com` by hand, so a household whose key was for Z.ai, or whose only model was local, could not run any of them and nothing said why. Since 2026-09-13 each such function is an **invocation** (`services/ancillary.ts` lists twenty-two: five on the server, the rest the tools' `models.yml` assignments) and goes through one door, `ancillaryComplete()`, which resolves the model and dispatches through the same three backends the chat uses.

Resolution is forced: a **pin** for that invocation (`ancillary_models`) → the household's **ancillary model** (`households.ancillary_model`, backfilled from the chat default on installs that predate it) → the chat default — skipping anything not in the roster or whose provider has no key, so a pin to a model whose key was since removed does not take the function down with it. The admin's card lists every invocation with what it is for, a light/standard/heavy hint, and a select limited to callable models. The Python tools read the same two tables (`tools/shared/model_config.py`), with `models.yml` as the last resort for a checkout with no database.

**Preferred models, 18 September 2026.** The resolution above was honest and the defaults were not: `ancillary_model` is backfilled from the chat default, so *every* invocation ran on the household's flagship. Naming a dossier on Opus, or on GLM 5.3, costs a flagship's output price for one sentence and is no better at it. Each **tier** now has a list of preferred models in `ancillary.ts`, best first, and an invocation takes the first entry its household can actually call. A list rather than a range per provider, and Aline is why: her chat runs on GLM, so a rule that asked "which provider does this household belong to" advised GLM for everything, while her household holds a Scaleway key and Mistral Small 3.2 was sitting right there, cheaper and the right size. The question is what should summarise a conversation here, not whose customer this is. Scaleway leads all three tiers — Mistral Small 3.2 for the one-liners, GPT-OSS 120B for the prose, Qwen 3.5 397B for flashcards, the one job that reasons — then Anthropic's Haiku and Sonnet, then OpenAI, then Mistral. **Z.ai is in no list**: GLM 5.3 and its Flash are both large, so a household with only that key is advised nothing and keeps its own model, which the screen says in a line naming the keys that would help. The choices are written in as ordinary pins, because the Python tools read `ancillary_models` straight from maurice.db and would never see a rule that lived in this file. Each pin records **who chose it**: `auto` is this file's opinion and is realigned at every start when the opinion changes, `admin` is a decision and is never moved again; saving the form with the advised value counts as agreement and stays `auto`, and a pin the admin deleted is never re-created. The first-start seed pins only what has no pin at all — a start is nobody pressing a button, so a pin set by hand through the form (which predates all this by five days) is left alone. Rows written before the `source` column existed are sorted the one time the column is added, by whether the seed had already run on that instance: if it had, they are its own and follow the advice; if it never had, a person wrote every one of them and they are marked `admin`. That is what carried Aline's five pins off GLM and onto Scaleway on the next deploy, with nobody pressing anything. **A household is only offered the functions it has.** Thirteen `tools/*` entries are symlinks into the private maurice-tools repo and the image's dockerignore drops them, so a hosted household ships `corpus`, `garden`, `mcp_gateway` and `shared` and nothing else — Aline's console was listing seventeen tool functions of which fourteen were served by code that is not on her machine. Each tools invocation declares the directory that runs it, and the screen, the seeding and the save all work from what is present. Three entries nothing resolves at all were dropped outright (`translation`, `briefing_synthesis`, `research_orchestration`, leftovers of `models.yml`).

**The tools ask the server for their turn now** (18 September 2026, `POST /api/ancillary`). Until then each built its own `anthropic.Anthropic` client around the id the admin had chosen, so the choice was honoured in name only: a Scaleway id went to api.anthropic.com and failed there, and a household without an Anthropic key could not run those functions whatever it had picked. The route takes an invocation and a prompt, resolves the model and dispatches through the same backends the chat uses; `tools/shared/model_config.complete()` is the client, and the garden tool, calibre's classifier and the git scanner use it. Access is **loopback only**, the same three-signal test the admin dashboard uses (see Auth below) — shared in `middleware/loopback.ts` — because a tool runs beside the database it already reads directly; no token to mint, store twice, or leak. The test spent its first hours on two signals, `Host` and the Cloudflare header, which left this endpoint — it spends the household's credit and has no login of its own — one forged `Host: localhost` away from any machine on the LAN, the tailnet, or behind Caddy; the socket peer closed that the same day. Mounted outside `/api/v1/*` on purpose: that prefix demands an authenticated member, and a tool is not one. The ten research-pipeline invocations are marked `ownDispatch` and advised nothing: they still choose a provider from their own settings (`research_tracks/providers/base.py`), so a model id from here would only be sent to whatever that config names.

**The preferred lists are European.** Z.ai was out for size; Anthropic and OpenAI are out by decision — American, and dear for work a small model does as well. Scaleway leads every tier, Mistral follows, and a household whose only keys are the American ones is advised nothing, keeps its own model, and is told which key would change that. That is home's own case today: its pins still read Haiku and Sonnet, which nothing moves until a Scaleway key is added there. Aline, who has one, runs her summaries on GPT-OSS 120B, her signal parsing and her garden functions on Mistral Small 3.2, and her flashcards on Qwen 3.5 397B.

The section itself sits at the bottom of the dashboard, collapsed, under *Advanced*: a thing to know exists, not a thing to open.

## Multi-human rooms

A conversation can have several participants (`conversation_participants`). Humans talk to each other freely; Maurice replies **only when summoned** — `mentionsMaurice()` in `routes/conversations.ts` matches `@claude` / `@maurice`. The send affordance is content-first: the ➤ button posts `{ summon: true, maurice_id }`, the 💬 button posts a human-only message.

Liveness runs through an in-process pub/sub, `server/src/services/roomBus.ts` (`roomTopic`, `userTopic`), which drives two WebSocket channels: one per room (live messages and replies) and a per-user channel for activity notifications (new conversations, someone chatting with you). Members can **report** a message in a shared room, and block a participant; reports reach the operator through `/api/reports`, and never exist for a private 1:1. The UX side is [[maurice-households-rooms]].

## Auth

- **Admin** — created once at `POST /api/auth/setup`; logs in with username + password.
- **Standard member** — logs in with `user_id` + a **mandatory PIN** (`verifyPin`). The server is reachable from the public internet through the Cloudflare tunnel, and any member can read the roster of `user_id`s, so a `user_id` alone is never enough: an account with no PIN can only get in by enrolling a device. `POST /api/auth/login` is rate-limited per-IP like enroll, and answers "Invalid credentials" identically whether the user is unknown, has no PIN, or gave the wrong one — it never discloses which.
- **Device enrollment** — `POST /api/auth/enroll` (unauthenticated) redeems an **invite code**; because it's the public guessing surface, failed attempts are rate-limited per-IP and globally. **Pairing tokens** (`redeemPairingToken`) are the one-shot programmatic path.
- **Tokens** — opaque session tokens (`validateSession`) and `maur_*` **API tokens** scoped `mcp` / `health` / `full`. Since 2026-09-13 a `health` token is an operator's probe, not a credential: it opens only the full face of `/healthz` and is refused as a member everywhere else (`validateHealthToken` vs. `validateApiToken`). The `mcp` scope is still not enforced — an `mcp` token is a `full` token in practice.
- **Image references are confined.** A message body can carry `![](/api/images/<name>)`, and the name is member-controlled; every read out of the images directory — the HTTP route, the model's context builder in `claude.ts`, and the edit path's `loadImageAsDataUri` — goes through `resolveImagePath`, which only returns a direct child of that directory. A `../../.ssh/id_rsa` reference is dropped, never read and handed to the model. Covered by `server/test/image-path.test.ts`.
- **Roles** — `admin` / `standard` / `guest`; a guest keeps normal capabilities but a limited reach (an allow-list of people via `guest_contacts`, plus the personas an admin grants).
- **Admin dashboard** (`/admin/*`, holds every provider API key) is refused unless the request is genuinely local, on three signals since 18 September 2026: a loopback **socket peer** (Bun's `requestIP`, which Hono sees because `index.ts` hands it the server as env), a loopback `Host`, **and** no Cloudflare edge header (`cf-ray` / `cf-connecting-ip`). None alone is enough. The tunnel terminates at `localhost:3001`, so its peer is 127.0.0.1 and only the CF header tells it apart; `Host: localhost` can be forged by anyone on the LAN or the tailnet — the server listens on 0.0.0.0 — and by whatever Caddy forwards, which is what the peer catches. A server that cannot name the peer refuses rather than guesses; a test harness driving the app without a socket has no env at all and is judged on the headers, which is what those tests exercise.

Schema in [[maurice-data-model]]; the member-facing flows in [[maurice-households-rooms]].

The garden proxy (`app.notFound` in `index.ts`) tells the engine who is asking and whose garden to serve: `X-Maurice-Garden` (the member) and `X-Maurice-Base` (`/g/<member>`, which the proxy strips from the path before forwarding), `X-Maurice-Theme` (the look its owner picked in the app), plus `X-Maurice-Owner: 1` when the session user is that garden's owner and `X-Maurice-Shared: 1` on a note page shared with a non-owner. All five are stripped from the incoming request first, since the engine trusts them. One engine serves the whole household. See [[maurice-web-garden]] (owner mode).

## Push

APNs dispatch lives in `server/src/services/push.ts` (+ `apns.ts`), keyed by `device_tokens` (platform, household tag). This is what notifies you when someone chats with you — including across households when you're a guest elsewhere.

## MCP execution

The engine reaches Maurice's capabilities over a **loopback MCP connection**: `mcpClient.ts` talks to the gateway proxied at `/mcp/*`. Tools are discovered per turn and filtered by the conversation's tool families. The tools themselves are documented in [[maurice-tools]].

## Health & operations

`GET /healthz` has two faces (`src/services/health.ts`). Since 18 September 2026 the `quick_check` verdict on the full face stands for five minutes (`DB_CHECK_TTL_MS`): the check reads every page of the file — a third of a second on home's 116 MB — on the thread that streams every chat, and with two towers polling every thirty seconds the server froze for that long four times a minute and the probe answered in one to two seconds. A verdict a few minutes old is as good as a fresh one for corruption, and the liveness half (`SELECT 1`) still runs on every probe.

 Public: `status`, `service`, `version` — for uptime probes and the apps' compatibility check. With a `health`- or `full`-scoped `maur_*` token: `git_sha`, `built_at`, `schema_version` (the `PRAGMA user_version` stamped by `SCHEMA_VERSION` in `db.ts`, bumped by hand with schema changes), `uptime_s`, `db` (a `quick_check`), `disk_free_mb`, and an **error rate** — `errors_1h` / `errors_24h` / `last_error_at` / `last_error_kind`, ticking on every `console.error` and every 5xx, keeping only the `[tag]` a log line opens with. Never a name, never content. `503` when degraded. `version` is `git describe` on `*v[0-9]*` tags, read from the checkout on the Mac install and from `server/build-info.json` (stamped by `scripts/build-info.sh` at image build) in the container; `MAURICE_VERSION` / `MAURICE_GIT_SHA` / `MAURICE_BUILT_AT` override. The order used to put the file before git, and the fleet table walked into the trap that follows on 18 September 2026: `build-info.sh` writes into the **checkout**, not into the image it is preparing, and nothing removes it — so an image built on the Mac left a stamp that outranked git for every later launchd restart, and the home row announced a four-day-old commit through eleven merges. Cleaned by hand at 11:03, back at 12:15 from the next deploy, which is what settled it: **git now comes first**, since a checkout answering `git rev-parse` knows what it runs, while an image ships without a `.git` and reads its stamp as before.

The operator side lives in `ops/` in the repo, outside the application: a hand-kept `fleet.yaml` inventory (each instance with its `deploy:` command, its `restart:` command and its `admin:` door), `fleet.ts` (inventory, tokens, one probe, and where each admin console is), `fleet-status.ts` (one table: version, schema, uptime, db, disk, errors per instance, exit 1 when anything is down or degraded), `tower.ts` (the same live in a TUI, error sparklines, `d` deploys the selected instance by running its command and streaming the output, `R` restarts it on the code it already has — the one to reach for when a household is wedged rather than out of date, since it cannot carry a half-finished checkout onto someone else's Maurice — and both then wait for that instance to answer `/healthz` again and say how long it took, because a command exiting 0 and an instance being back are two different claims; `a` opens its admin console — a terminal program on purpose, its access control being the shell it runs in, no daemon and no port of its own), `admin.ts` (the same door from the command line: `ops/admin.ts aline` forwards and opens, `--print` just says how), `recreate-container.sh` (the deploy primitive for a hand-started local container: rebuild the image, recreate with the same env/ports/volumes, wait for `/healthz`), `mint-health-token.ts` (a health token straight into a `maurice.db`), tokens in `~/.maurice/ops/fleet-tokens`, and a README naming the off-the-shelf stack (Uptime Kuma for paging, Dozzle for container logs, Sentry/GlitchTip *not wired* pending a decision on shipping traces off a friend's instance) and the hand-over procedure — copy `MAURICE_DATA_DIR` + gardens, move the name, revoke the token, drop the line. No discovery, no central registry, no fleet UI: those are decided against. **An admin console is never reachable by the name its household answers to** — `web-admin` refuses any request whose `Host` is not loopback and any request carrying a Cloudflare edge header, so `https://aline.chezmaurice.eu/admin` is a permanent `403`, and `admin:` in the inventory says how to get in instead: nothing at all for an instance whose url is already localhost, `ssh://<ssh-host>:<port>` for a household on a rented host, that port being the loopback one `ops/household.sh` allots it from 3101 up and now prints as a ready-made `fleet.yaml` entry. The forward is made with `ControlPath=none` on purpose (a forward asked of the multiplexed connection the deploys share outlives the process that asked for it, which would leave a console open on a loopback port), a port that already answers is reused rather than doubled, and a tower running over ssh into the mac mini prints the url instead of opening a browser that is on the wrong machine.

**The first rented host, since 17 September 2026: `maurice-fleet`.** A Scaleway BASIC2-A2C-8G — 2 ARM vCPU, 8 GB, 40 GB of block storage, Ubuntu 26.04, fr-par-1, 51.15.217.40 — prepared by `infra/cloud-init/maurice.yaml` exactly as written, carrying Aline's household and the App Review one as two compose projects behind one Caddy (`infra/container/MULTI-HOUSEHOLD.md`), each restored from a `VACUUM INTO` snapshot of its Mac-era data. The image reaches it through a private Scaleway registry, `rg.fr-par.scw.cloud/maurice`, and **`MAURICE_REGISTRY=rg.fr-par.scw.cloud/maurice scripts/deploy.sh maurice-fleet` is the whole update**: build here, push, recreate every household on the new image; `/opt/maurice/image.env` records what was shipped and `ops/household.sh` reads it on every `up`, `restart` and `add`, so a restart later lands on the deployed image rather than on whatever the household's env file remembered. An already-built tag is shipped as it is, which is also the rollback. On the Scaleway side everything sits in a project `maurice` of its own: an IAM application `maurice-fleet` whose one key can call Generative APIs and pull the registry and nothing else (project-scoped, hence the project id in every URL it uses — embeddings in `defaults.env`, chat in each household's admin), the registry namespace, the ssh key, the instance. The key lives in `~/.maurice/ops/scaleway-fleet.env` on the Mac and nowhere in the repo. Two things the first real host taught: `compose.caddy.yml` mounted the single-household Caddyfile and never passed Let's Encrypt a contact address — the multi-household edge had never been run against a real machine, and both are fixed; and a fresh public IPv4 is hammered on :22 within minutes of boot, enough to starve sshd's unauthenticated slots and drop the deploy's own connection (`Maxstartups` in the log) — `MaxStartups` raised and `LoginGraceTime` shortened in a `sshd_config.d` drop-in, and ssh multiplexed from the Mac so a deploy counts as one connection. And one on the Mac, found while taking the two names out of the tunnel: `brew services restart cloudflared` regenerates the launchd plist from the formula, whose service runs bare `cloudflared` — which, with a `config.yml` that names a tunnel, prints "Use `cloudflared tunnel run`" and exits — so `magik` went dark for a few minutes until `tunnel run` was put back in the plist by hand. The next restart through `brew services` will do it again.

**Documentation refresh, since 19 September 2026** (`services/mauriceDocsRefresh.ts`). `MAURICE_DOCS_URL` names where Maurice Maurice's notes are published — default `https://raw.githubusercontent.com/ckemmler/chez-maurice/main/docs/maurice`, i.e. the `docs/maurice/` directory of the repo as it stands on `main`; `off` makes no outbound call at all (also the default under `NODE_ENV=test`). Twenty seconds after boot, then every 24 h, the server GETs `manifest.json` (15 s timeout, 64 KB cap) through the same SSRF guard as article extraction; if its `generated_at` is newer than the manifest already in `<app dir>/docs/maurice` (or the bundled `docs/maurice/manifest.json` when there is none), it downloads each note whose sha256 differs (2 MB cap, hash verified), reuses the rest from the current set or the bundle, stages the whole set beside the target and swaps it in — a failure of any kind leaves the previous set as it was. `MAURICE_DOCS_ALLOW_LOCAL=1` lifts the guard for a mirror on a private address (the tests use it). The log says `[docs] refreshed to …`, `[docs] up to date (…)` or `[docs] refresh failed: …`. `docsDir()` then chooses `MAURICE_DOCS_DIR` if set, else the refreshed set when its manifest is at least as new as the bundle's, else the bundle. `GET /api/admin/status` carries `docs: { source, generated_at, last_check_at, last_error }`; the admin dashboard's last card shows the set's date and source with a "Check now" button (`POST /admin/docs/refresh`). Both production compose files pass `MAURICE_DOCS_URL` through from the household's `.env`.

## Backups

**Hosted households, since 19 September 2026.** Every household on a shared host is sent nightly to Object Storage with restic — `ops/backup.sh` and `infra/host/backup.sh`, described under *Gaps* below and in `ops/README.md`; `ops/backup.sh restore-test` is the rehearsal, and it has been run.

**The Mac.** `com.maurice.backup` snapshots `maurice.db` and `life.db` nightly into `~/.maurice/backups/db` (`scripts/backup-db.sh`), each under its own name, `VACUUM INTO` then an integrity check before the copy is kept. `life.db` — health, tasks, reading positions, highlights, dossiers — was only added on 2026-09-13; until then it was not backed up at all. The gardens rely on git — each member's garden is a repository, committed on every write and pushed when a remote exists. Still *not* covered: `compte.db` and `recommendations.db` under `~/.maurice/data/`, and the git-ignored flashcard files (see [[maurice-knowledge]]).

## Ships vs. exists

The **chat engine** (`server/src`) is core and ships with the server app, as do the garden-media routes. The rest of the **data-api** layer is the backend for the experimental [[maurice-tools]] fleet — present and in daily use at home, but those capabilities roll out gradually.

## Gaps & open questions

- **Git runtime.** The server performs git operations on the gardens, but whether git is bundled or assumed present on the host is unresolved — see [[maurice-architecture]].
- **The fuse knows the member since 19 September 2026** — per-member and per-household daily caps, and a usage view for each member and for the admin (see *The spending fuse*). A balance, a quota that is prepaid money, and a statement are still missing — see §4 of [[maurice-commercialisation]].
- **Scaleway's cache is invisible on nine models out of ten.** Measured 18 September 2026: only DeepSeek V4 Flash reports cached tokens, and only a hot, shared prefix hits; the other models' usage carries no cache detail, so their meter figure is the uncached one whatever Scaleway bills. Cockpit is the only place to see it.
- **The tool trail is text in the history.** A small model could imitate the bracketed block in its own reply; nothing strips it. Watch for it on Flash and local models.
- **The turn registry is memory only.** A server restart forgets every reply in flight; a client re-attaching afterwards gets a `204`, and the partial reply, if any, was never persisted.
- **No automatic provider failover.** Provider is selected by the resolved model; there is no resilient "try Anthropic, fall back to OpenAI on error" path beyond the no-key echo mode.
- **A hosted household's volume is backed up nightly** (closed 19 September 2026). `infra/host/backup.sh` runs from the host's crontab at 03:30 UTC: the running container writes a consistent copy of every SQLite database (`VACUUM INTO` through bun:sqlite; the image has no `sqlite3`), then restic — its own container, the volume read-only — sends the volume minus the live databases to one repository per host on Scaleway Object Storage (`maurice-fleet-backups`, project `maurice`), 14 daily / 8 weekly / 12 monthly kept, encrypted with a password only the Mac holds (`~/.maurice/ops/fleet-backup.env`). `ops/backup.sh restore-test <host> <name>` restores the latest snapshot into a throwaway household, boots it, prints what it holds and tears it down — rehearsed on both households the day it was written; `ops/backup.sh restore` does it for real. The Mac's own backup (`com.maurice.backup`) is still the partial one below.
- **A moved household keeps its local models.** The App Review roster still lists the Mac's Ollama model, which no longer exists where it runs; nothing prunes a provider that stopped being reachable. Its default was switched to Mistral Small 3.2 by hand.
- **Context estimation is by characters**, not counted tokens; the margin covers the difference, and the estimate ignores tool results appended during a turn. The cut never moves back when a bigger model is chosen later.
- **TLS / remote access** is operator-chosen plumbing (Tailscale or Cloudflare Tunnel), not managed by the server — see [[maurice-architecture]].
- **Backups are partial** — `maurice.db` and `life.db` only.
- **The `mcp` token scope is not enforced** (see Auth); only `health` is.
- **Hand-over of a hosted instance has its script since 19 September 2026**: the owner exports the archive from their own console, the new place imports it (`ops/household.sh add … --from`, `scripts/import-household.sh`, `scripts/container.sh import`) — the operator never opens the data. `resolveBuildInfo` moved to `services/buildInfo.ts` (no database import) so the archive's manifest can name the server version; `health.ts` re-exports it. An error collector is a decision still open.
- **data-api hardening (September 2026).** The `/reports/img` proxy now goes through the same SSRF guard as article extraction (DNS-resolved, private/loopback refused, timeout + size cap); the `uploads` and `bank-transactions` routes reject a filename that isn't a bare basename; and a `noPathTraversal` guard fronts the tracks/reports routers, whose `:planId`/`:trackId` params were concatenated into filesystem paths (Hono decodes `%2F`). Still open: those tracks routes carry **no member check** — they are Candide's own research pipeline today, but that's an assumption, not an enforced boundary.
