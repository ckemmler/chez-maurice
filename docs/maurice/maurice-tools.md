---
title: The MCP tool ecosystem
date: '2026-09-26'
flags: []
locale: en
description: 'The gateway that gives Maurice his capabilities: discovery, per-member
  context, auth, tool families, and the public/private split.'
tags:
- maurice
- documentation
- architecture
- tools
- mcp
icon: toy-brick
parent: maurice-docs
---

# The MCP tool ecosystem

Everything Maurice can *do* beyond talking — read and write the garden, search a corpus, log a signal, check sleep — is an **MCP tool**. The tools are Python servers under `tools/`, fronted by a single **gateway** the chat engine calls over a loopback connection. This note is the *mechanism*; the capabilities themselves are in [[maurice-knowledge]] and [[maurice-life]].

## The gateway

`tools/mcp_gateway/server.py` discovers every tool server at startup and exposes them as one MCP endpoint over Streamable HTTP.

- **Discovery** (`discover_tool_specs()`) scans `tools/`, skipping `shared/` and `mcp_gateway/`. Each server is imported via one of three shapes: a `gateway_context` async context manager, a module-level `app` (`MCPServer`), or a FastMCP `mcp`.
- **Multiplexing** (`UnifiedMCPServer`) aggregates them and **namespaces every tool** as `{server}__{tool}` — e.g. `garden__create_note`, `signals__signal_log`. Both a unified endpoint (`/{base}/mcp`) and per-server endpoints (`/{base}/{server}/mcp`) are served.
- **Per-member context** (`MemberContextMiddleware`) reads the `X-Maurice-Member-Id` header into a `member_id_var` contextvar; every tool resolves the caller through `tools/shared/context.py` (`get_member_id()` / `require_member_id()`), so the same tool scopes to whichever household member is asking.
- **Auth** — two paths: a bearer token (`MAURICE_MCP_TOKEN` / `AKITA_MCP_TOKEN`, constant-time compared) for the loopback caller, and a full **OAuth 2.1 / PKCE** flow (`oauth.py`) that also accepts members' `maur_*` API tokens. That OAuth surface is what lets Maurice be added as a *custom connector* by an external Claude client.

## Shared infrastructure

`tools/shared/` is the common ground (not a capability):

- `context.py` — the `member_id` contextvar and accessors.
- `config_loader.py` — reads `~/.maurice/config.toml`, resolves the data dir and per-tool DB paths, and the timezone (default `Europe/Paris`).
- `model_config.py` — `resolve_model(invocation)` answers with the admin's choice first: the invocation's pin in `ancillary_models`, else the household's ancillary model, both read read-only from `maurice.db`; `models.yml` is the last resort for a checkout with no database. See [[maurice-server]].

A tool server itself is small: a `Server("…")` with `list_tools()` / `call_tool()` decorators and a `_handle_*` dispatch (the pattern is clearest in `tools/garden/server.py`).

## How the engine reaches the tools

The [[maurice-server|chat engine]] holds a minimal MCP client (`server/src/services/mcpClient.ts`) pointed at the gateway proxied under `/mcp/*`. Per turn it lists the tools, filters them by the conversation's **tool families**, and calls the survivors. Structured results come back and become the `tool_data` rows the app renders as [[maurice-chat|data cards]].

## Tool families

100+ tools would drown a model (and a small local one especially). **Tool families** group tools by server prefix and gate which a turn may use, resolved in order: **conversation override → persona → household default → tier default**. The tier default is now *empty* for every model, cloud or local: only the always-on families (`web`, `signals`, and `corpus` since 20 September 2026) are unioned back in, so everyday tools are opt-in per chat. The corpus joined them because a memory you have to remember to switch on is not one: it was experimental, off by default, and absent from every conversation the owner held, so a question falling squarely into a domain could not be followed up even though the index held the answer. It carries two guards no other always-on family needs. It is **member-private** (`PRIVATE_ONLY`): withheld the moment a conversation has a second participant, since the turn is taken on behalf of whoever spoke and an unguarded search would read their private conversations out to the room — the same rule the domain briefs follow. And only part of it is handed over: its nine **writing** tools (index, prune, reindex, import, map) are never offered to a model at all, whatever the selection says, because the server calls them itself and a wrong guess costs the index; a turn that did not ask for the family by name gets the two tools remembering needs, `corpus__search` and `corpus__get_chunk_context`, and the rest of the reading roster waits for a conversation that selects the family outright. Hence `selectedFamilies` beside `resolveFamilies`: *the turn chose this family* and *the turn holds this family* stopped meaning the same thing. The `garden` family is itself sub-split (`garden-notes`, `garden-journal`, `garden-people`, `garden-fragments`, `garden-media`, `garden-publish`, `garden-other`) in `server/src/services/toolFamilies.ts` so a persona can grant, say, journalling without publishing.

Two gates sit on top of the families, both in `toolFamilies.ts`. Everything that isn't `web`, `signals`, `garden-notes` or `garden-journal` is **experimental**, and a member only sees it once an admin ticks *experimental tools* on their admin page (`users.experimental_tools`; admins always have it). The filter is applied twice — when listing families for the picker, and tool by tool just before the roster is handed to the model (`claude.ts`), so an ungated member can never be passed an experimental tool even through a stale conversation override.

**The prompt says what it holds** (September 2026). The system prompt used to promise "tasks, calendar, contacts, notes, health, books, and more" in a hard-coded sentence, written before the families were resolved — so a member granted none of them was told they had all of them, and, asked what tools he had, Maurice recited the promise instead of his actual roster. The sentence is gone: `toolRosterNotice()` now names the families actually present in the turn's filtered roster (plus web search only when Tavily is configured), and says plainly that nothing else is reachable. The image-generation directives are likewise appended only when a fal key exists, instead of teaching the model a `[IMAGE: …]` protocol that nothing downstream would honour.

## The documentation tool — `maurice_docs`

Since the evening of 19 September 2026 (roadmap P3-A, [[maurice-domaines]] 4e) a question about Maurice himself is answered by a **tool**, not by a persona. `maurice_docs` is built into the chat engine beside `web_search` (`server/src/services/mauriceDocsTool.ts`, wired in `claude.ts`): it is in **every roster**, for every member, guests included, in every conversation, whatever the tool families say — a member may always ask Maurice about Maurice — and the *Your tools* section of the system prompt names it and says that such questions go to it, never to memory. The loop calls it on the strength of its description alone: what he can do, how a feature works, how to set something up, what is built and what is not, why it was designed so.

**What it does.** Given a `question`, it runs a **sub-turn**: one ancillary completion (`ancillaryComplete`, invocation `maurice_docs`) whose system prompt is the head that used to be Maurice Maurice's — ground everything in the notes, name the note, say what is experimental or not built, answer in the question's language — followed by the **digest** and the notes newer than its `covers` (`docsForContext()`, `internal: true` notes never; the reader and its daily refresh are in [[maurice-server]]), and whose prompt is the question as the everyday Maurice phrased it. The answer comes back as the tool result, prose, no data card, and Maurice relays it in his own voice. Given a `note` (a slug, listed in the description: `server`, `domains`, `carnet`…), it returns that note **in full**, no model call, for the detail an answer left out. The system prompt is byte-stable between two questions on the same set, and the sub-turn asks the provider to cache it (`cacheSystem`: Anthropic's breakpoint, the prompt-cache key where a provider takes one), so the second question within the cache's life reads the ~22 000 tokens of documentation at a tenth of the price.

**The model** is what Maurice Maurice's was: a strong cloud model of the household's own provider first, never a local one (`docsModel()`), applied as the invocation's computed default and shown in the admin's ancillary card as its effective model; a pin overrides it, and the seed advises nothing for it (see [[maurice-server]], *Ancillary models*). **The ledger** knows it: the sub-turn is a call the member's turn provoked, so the fuse is consulted for that member before it runs — their own cap, the household's, the instance's — and what it cost is recorded under their id; it is the first ancillary call charged to a member.

**What a question costs, measured on the evening of the 19th** on a copy of home (documentation on Sonnet 4.6, the everyday Maurice on GLM 5.3 Flash), *Comment Maurice sauvegarde-t-il ?*:

| | Before — a turn of Maurice Maurice | After — the everyday Maurice + the tool |
|---|---|---|
| First question | 22 655 tokens written to cache + 577 out on Sonnet: **9.4 ¢** (7.7 ¢ uncached) | chat turn 0.09 ¢ + sub-turn 8.0 ¢ (the same 22 000 tokens, cache written): **8.1 ¢** |
| A question answered by a note in full (*Et Carnet ?*) | a Sonnet turn again, ~3 ¢ | **0.13 ¢** — no sub-turn, the Carnet note in the chat model's context |
| Next questions within the cache's life | ~2.3 ¢ of cache read + the answer | 1.6 ¢ and 2.5 ¢ per sub-turn (0.7 ¢ of cache read + the answer) + a tenth of a cent of chat |
| A conversation that never asks about Maurice | — (one had to open Maurice Maurice to ask) | **0**: the documentation is loaded only when asked |

Per question the first is barely cheaper — at Sonnet's prices the answer's output is what costs — but the structure is: nothing is paid until a question is asked, the answer arrives in an ordinary conversation, the note-in-full path is free of the sub-turn, and the sub-turn's model is a pin the admin can move (Mistral Medium 3.5 on Scaleway would bring a fresh question to ~2 ¢). The GLM turn asked good questions of it, twice in one round when the member asked two things at once.

**What a small model sees.** Every roster now holds one tool, so an Ollama turn always offers tools; a local model that cannot take them pays one refused request before the loop retries without (the path that existed). The tool's description names the notes of the set actually read, so it moves only when the documentation set does — daily at most.

## The domain proposal tools — `domains__propose`, `domains__adjust`, `domains__adopt`, `domains__seed`

Three more native tools since the night of 19 September 2026 (P2-B of the domains roadmap, `server/src/services/domainProposals.ts`), a fourth since the evening (P2-C), and the first ones **granted by the conversation rather than by a family**: they exist in exactly one place, the conversation Maurice opened at night to propose [[maurice-domains|domains]], while at least one proposal in it is still open or an adopted domain's garden notes still wait for the member's word — and nowhere else, whatever the member's families or experimental flag say. `domainToolsFor(conversationId, memberId)` answers the four or nothing; the check is made again inside every call, on the conversation itself, so a stale roster cannot reach them. They are appended after the MCP roster so an ordinary conversation's cached prefix does not move, and the roster notice lists them as *Domain proposals* (a `domains` family that is `core` in `toolFamilies.ts`, so the experimental gate never withholds them).

- **`domains__propose`** — `list` (default) the open proposals with their sample conversations; `show` one in full, with every conversation it holds (up to 200, with ids — what a split needs); `add` a domain the member named that the night did not find.
- **`domains__adjust`** — `rename` (name and/or summary), `merge` several into one new proposal (the sources are marked `superseded`), `split` one into parts, each with the conversation ids that go to it (what is not assigned stays in the original), `dismiss` — the member says it is not a domain: it is put away and its conversations never come up in a mapping again.
- **`domains__adopt`** — the only thing that creates a domain from a proposal, and the prompt section of that conversation says it plainly: never on a hint or an "ok" to something else, only after the member's explicit yes. It creates the row of `maurices` (kind `domain`, created by the member, the summary as its statement, the three closest conversations baked into its context), binds every conversation of the proposal to it (`conversations.maurice_id`, when not bound elsewhere), and starts the first brief in the background through the briefs service — on the night model, charged to the ledger's `system` spender. The tool answers at once and Maurice is told to say the brief will appear on the domain's page shortly — and that no note was written: that is the next tool's.
- **`domains__seed`** — the garden seeded on consent (`server/src/services/domainSeeding.ts`, [[maurice-domains]]): for a proposal adopted in this conversation, and only after the member said yes to the notes themselves — the description and the prompt section both say an adoption is not that yes — one call to the night model on the domain's bound conversations, then a hub note and up to three topic notes in the member's garden, every one marked `meta.opened: false` with its provenance. It runs inside the member's turn and is charged to them (`recordSpend(usage, memberId)`, under their fuse), takes up to a minute, and returns the notes with their links for Maurice to give. `action: "decline"` records that the member does not want notes, so the offer is not repeated and the tools can go. A seeded or declined domain is refused a second time.

The night's own corpus tool sits behind them: **`corpus__map_conversations`** (`tools/corpus/src/mcp_server.py`, the arithmetic in `src/domain_map.py`) groups the caller's conversations by their vectors — one centroid per conversation on the roles asked for, spherical k-means, a merge of close centroids, a second level on any group above `split_above` — and returns groups of conversation ids ordered by closeness with their cohesion, no names, no dates. It reads the member's file only, through the store's `conversation_centroids`, so the gateway stays the only process that opens the stores; the step-0 script `map_domains.py` calls the same code. What the server does with the groups is in [[maurice-server]] and [[maurice-domains]].

## Ships vs. exists — and it's enforced in code

The public/private boundary is not aspirational; it is in `.gitignore` and `tools/README.md`:

- **Public (ships):** `garden`, `corpus` (since September 2026 — it came in with its history and a test suite; its data, logs and `config/corpus.yaml` stay ignored, a `corpus.example.yaml` ships), `email` (25 September 2026, below), `shared`, `mcp_gateway`.
- **Private overlay (gitignored — the `maurice-tools` repo):** `tracks`, `health`, `signals`, `tasks`, `calendar`, `contacts`, `calibre`, `readwise`, `compte`, `social`, `layouts`, `thoughts`, `mail` (September 2026), and `pipelines`.

**Secrets live in `.env`, never in a tracked config file.** Both repos load one with `python-dotenv`, walking up from the source file to the first `.env` found; `maurice-tools/.env.example` documents the variables the overlay needs (`NEBIUS_API_KEY` for Calibre chapter summaries, `CALIBRE_API_KEY` for the book-browser artifact). Tracked config files hold only non-secret defaults — models, base URLs — and a missing key now fails with a named error instead of a `KeyError`. This replaced two credentials that had been committed to the private repo (September 2026).

The gateway auto-discovers whatever directories are present, so a public checkout runs **garden-only**, while the home install overlays the private tools. This is exactly the *chat + garden ship first, the rest roll out gradually* line, made concrete at the filesystem level.

## `email` — anyone's mail, read-only

Public since 25 September 2026, and the answer to *most of people's data is in
their mail*. `mail` (next section) is one person's triage method; `email` is the
access layer anyone can use, and assumes no method at all. It reuses `mail`'s
hostile-input handling and nothing of its vocabulary.

- **Six reads, no writes.** `list_accounts`, `list_folders`, `search`
  (envelopes only, newest first, across all the member's accounts by default),
  `get_message` (headers, body as text, the list of attachments),
  `get_attachment` (text, HTML, PDF text layer, forwarded message) and `stats`
  (counts per main folder, top senders and domains, from headers alone). No
  send, move, flag or delete: absent, not disabled.
- **Nothing is marked read.** Folders are opened with EXAMINE, every fetch is a
  `BODY.PEEK`; the test fake raises on anything else.
- **An account is an address and a password.** Host, port and transport come
  from the domain (`providers.py`: Gmail, iCloud, Fastmail, Yahoo, Proton via
  Bridge, Orange, Free, SFR, La Poste); a Workspace address says
  `provider = "gmail"`, anything else names its host. Outlook.com is recognised
  and refused with the reason — Microsoft takes only OAuth over IMAP.
- **Folders by role.** SPECIAL-USE flags (`\All`, `\Sent`, `\Trash`…) with usual
  names as a fallback, so `[Gmail]/Tous les messages` and iCloud's
  `Sent Messages` are found without anyone spelling them. The default search
  scope is the `\All` folder where there is one (Gmail, Proton), the inbox
  elsewhere; on Gmail the search fields become Gmail's own syntax (`X-GM-RAW`).
- **Member-private twice.** The tool opens only the accounts of the member the
  gateway names (no member, no mail; no owner override), and the server lists
  `email` in `PRIVATE_ONLY`, so the family is withheld from any conversation with
  a second participant. `mail` joined it the same day: its own guard admitted
  only the owner, but in a room where the owner spoke a turn holding it could
  have read the owner's mail out to the others.
- **Blocking IMAP off the event loop.** Calls run in a worker thread, one lock
  per account session, so a slow mail server does not stall the other tools.
- **A narrow search answers on its own.** When the whole search — every
  account, every folder — comes back with three messages or fewer, each
  envelope carries `preview`, the first 1 200 characters of the body, wrapped
  in the same untrusted markers as `get_message`. It costs nothing on the wire —
  the text slice rides on the `BODY.PEEK[TEXT]<0.n>` of the FETCH the headers
  already needed — and it spares a whole turn. `preview` forces it
  either way.

### The header store — lot 1 of the mail import (26 September 2026)

The first built piece of `specs/mail-import.md` (*knowing, not finding*): a
member's whole mailbox walked into a store of parsed headers, free, resumable,
and with nothing of the bodies kept. Three tools join the roster —
`scan_mailbox` (starts the walk in the background, or joins the one running),
`scan_status` (the job, its counts, where it is, what the store holds) and
`scan_stop` (pause at the next checkpoint) — the same start-then-poll shape
as the corpus's `index_conversation` / `reconcile_status`, because a first
pass over years of mail outlives any request.

- **One SQLite file per member, `<app dir>/mail/<member id>.db`**, written by
  the `email` tool and by nothing else — never `maurice.db`. Four tables:
  `jobs` (the import as an object: state, counts, bytes, seconds, last error),
  `cursors` (`{uidvalidity, highest_uid_done}` per account and folder),
  `messages` (the parsed headers) and `locations` (where each message was
  seen: account, folder, uidvalidity, uid).
- **The identity of a message never depends on its folder.** Members
  reorganise folders, with Maurice's help; a moved message or a renamed
  folder must not become a second message. In order: `X-GM-MSGID` on Gmail
  (`gm:…`), `EMAILID` where the server announces OBJECTID (`oid:…`), else a
  fingerprint of the normalised Message-ID + From + Date (`fp:…`), and
  without a Message-ID a fingerprint of Date + From + To + Subject (`fp2:…`,
  marked *weak*). A folder is only a location attached to the message; met
  again elsewhere, the message gains a location, not a row.
- **UIDVALIDITY is handled, not hoped about.** Each folder walk starts with a
  fresh EXAMINE; a UIDVALIDITY that differs from the cursor's means the folder
  was renumbered — cursor back to zero, the old generation's locations purged,
  in one transaction, and the folder rescanned. Skipping this is how mail gets
  dropped in silence.
- **Batches of 500, one transaction each** — rows, locations, the moved
  cursor and the job's checkpoint together. Every write is idempotent
  (`INSERT … ON CONFLICT DO UPDATE`), so a batch replayed after a crash is
  harmless: a connection dropped mid-FETCH is retried once after the session
  reconnects; a failure while writing fails the job, and the next start
  resumes from the cursor, replaying exactly the interrupted batch. One
  folder the server refuses is named in the job and skipped, not the forty
  after it; an account that refuses the login ends that account's walk.
- **The job row is a lease.** Its `updated_at` moves at every batch and is
  the heartbeat: a `running` job with a fresh one is another walker — this
  gateway's thread, or the CLI beside it, on the same file — and is joined,
  not doubled; one whose heartbeat is ten minutes old is a process that died,
  and is marked `paused` by whoever looks next. The walk runs on IMAP
  sessions of its own, so a search meanwhile does not fight it for the
  connection and a password changed in the app closes only the shared one.
- **The subject is sealed; the structural fields are not.** Same key, cipher
  and envelope as `mail_accounts.secret` (`services/mailAccounts.ts`:
  household key, AES-256-GCM, `v1:` + base64 of IV ‖ tag ‖ body), now in
  Python too (`tools/email/sealing.py`, on `cryptography`); a seal made by
  either side opens on the other, and a test proves it. From, to, cc, date,
  message-id, list-id and references stay in clear and indexed, along with
  `List-Unsubscribe` and `Precedence` for the triage to come — all parsed
  from the header block the FETCH already carried, no extra round trip.
- **Folders walked** are the ones "everywhere" means: `\All` on Gmail, every
  selectable folder but junk, trash and drafts elsewhere.

Measured on the day against the owner's Gmail, twenty years of mail: **164 194
messages** walked end to end, the process killed outright twice along the way
and resumed each time from its cursor without a duplicate; the last stretch
of 136 982 messages took 13 min 18 s — about 170 a second — for 500 MB of
headers on the wire (3 kB each, the `Received` chain mostly), and the store
weighs 164 MB, about 1 kB a row: a 100 000-message archive is roughly
100 MB, three times the spec's estimate, most of it `References` and the
sealed subject. Every message carried an X-GM-MSGID; 132 had no subject. One
real-world limit found and fixed on the spot: `UID SEARCH UID 1:*` on the
archive answers over a megabyte of UIDs, which imaplib refuses as a single
line; the walk asks in windows of ten thousand UIDs up to the folder's
UIDNEXT instead (and for the last UID alone on a server that omits UIDNEXT).
No model reads anything and no euro is spent; what runs on its own, and what
the store says about a mailbox, is the next section.

Verified against the real Proton mailbox through Bridge on the day: roles read
from the flags, 103 messages found since 20 September in `All Mail`, a
newsletter read and still unread afterwards, a PDF invoice's text extracted,
Outlook signature images (`image001.jpg`, referenced by Content-ID) no longer
listed as attachments. iCloud could not be tried: the stored app-specific
password is refused, which is also why the `mail` tool keeps that account
disabled.

### The walk wired, the triage, the reconciliation, the estimate — lot 2 (26 September 2026)

Settled with the owner on the day and built the same afternoon: the free
header pass runs **unasked** — it costs nothing, reads no body, writes only
the member's own file, and asking first would leave Maurice's first message
about a mailbox empty of facts. Three moments start it, all through the tool,
as the member (`server/src/services/mailScan.ts`): **as soon as a mail account
is created** (after the login check in `POST /api/mail-accounts`,
fire-and-forget through the member's gateway session); **every night at
03:00**, at the corpus's rendezvous and in its shape — start, then poll
`scan_status` until `running` is false; the last run in
`<app dir>/mail-nightly.json`, `MAURICE_MAIL_NIGHTLY=off` to disable, a run
in flight shared, the log `[mail] nightly: N mailbox(es) walked, S member(s)
without mail, F failed, M message(s) in the stores, R reconciled, O
conversation(s) opened, in Ss`; and **on demand** — `scan_mailbox` in a
conversation, or the card under *Settings → Mail* in the app (`MailPane`),
which reads `GET /api/mail-accounts/scan` (the tool's status flattened:
`state` ∈ `running`/`paused`/`done`/`failed`/`idle`/`none`, the counts, the
store's totals), refreshes every five seconds while the walk runs, and
restarts it with `POST …/scan` — "Start", "Resume" after a pause or a
failure, "Pick up new mail" once done. While the walk runs, only that card
speaks.

Five tools join the roster, all free, none calling a model:

- **`triage_mailbox`** — bulk or correspondence, every message, from the
  headers alone (`tools/email/triage.py`), kept in a `triage` table with the
  reason, recomputable. `List-Id`, `List-Unsubscribe`, `Precedence:
  bulk|list|junk` and an address that says nobody reads it (`no-reply@`,
  `notifications@`, `mailer-daemon@`) make **bulk**; a sender the member has
  written to (in the To or Cc of a message whose From is the member), one of
  their contacts, or the member themself make **correspondence** — the person
  wins over the mark, a friend's mail through a group is still a friend's;
  what has neither is **other**. `contacts` is a list of addresses the caller
  passes, empty today (the gap below).
- **`mailbox_report`** — the free report, a deliverable apart from the first
  message: who writes (senders of correspondence and other, with whether they
  were ever answered), what fills the box (bulk sources by messages and by
  bytes), which threads are alive (three messages or more, one in the last
  ninety days, grouped on the first `References` id; the subject unsealed for
  those alone), who never got an answer (wrote twice or more, never in the
  member's To/Cc). Over the last three years by default; runs the triage
  first when nothing was.
- **`reconcile_mailbox`** — the store trimmed to what the mailbox still holds
  (`reconcile.py`): LIST, then for every folder the cursor knows, `UID
  SEARCH` in windows of ten thousand up to UIDNEXT and **no FETCH at all** —
  seconds even on 164 000 messages; the locations of UIDs gone are dropped, a
  folder that left LIST loses its locations and its cursor (back under the
  same name, it is walked afresh), a renumbered folder is reset for the next
  walk, and a message left with no location is marked `gone_at` — its row,
  its triage, the threads it is in stay true; seen again, the mark goes. A
  job of kind `reconcile` with the same lease as the walk; never at the same
  time as a walk on the same store (the walk adds what the listing would not
  know and would remove); a stop mid-listing removes nothing. The night runs
  it **once a week** per member.
- **`calibrate_reading`** — bytes → tokens, measured (`calibrate.py`): a
  hundred bodies of the reading window sampled among correspondence and
  other, one location each, the first 16 kB of text fetched on the header
  FETCH (`BODY.PEEK[TEXT]<0.16000>`, nothing marked read), turned into plain
  text as `get_message` would, counted with `tiktoken` (`o200k_base`) — **a
  proxy** for Mistral's tokenizer, within ten to twenty percent, said in the
  output — and **nothing kept** but one row of ratios (`calibration`: sampled,
  complete, bytes, tokens, tokens in the first 600 characters). `tiktoken`
  joins `requirements-tools.txt`.
- **`estimate_reading`** — the numbers behind the quote: messages in the
  window by kind, how many a reading would open, the tokens of the light pass
  (60 of headers plus the preview's, per message) and of a full reading (the
  bytes on the wire times the ratio), and the nights from a stated capacity
  of 1 500 messages a night — an assumption until lot 4 measures it. **No
  price: the tool never prices**, the server does from `pricing.ts`.

The same five from the CLI (`triage`, `report`, `reconcile`, `calibrate`,
`estimate`). Measured on the owner's Gmail on the day, from the store alone:
164 194 messages — **134 488 bulk, 19 825 correspondence, 9 881 other**
(101 754 by `List-Id`, 32 550 by `List-Unsubscribe`, 13 940 answered
senders, 5 885 the owner's own); the last three years hold 2 131, 466 of
them to read (this Gmail is a legacy box: Facebook, Medium and Uber fill it);
the calibration on a hundred bodies gave **18.9 tokens per kB** on the wire
and 139 tokens in a preview, 44 of the hundred read whole — so a full reading
is about 449 000 tokens, the light pass 93 000, one or two nights.

**Then Maurice opens the conversation** ([[maurice-chat]] has the surface;
`services/mailOpener.ts` the text): once per member, only when the walk is
done, past the opening guard by decision, short, and **with no money in it**
— the cost range the server computes from the calibration and `pricing.ts`
goes to the log alone (`[mail] nightly: … 466 to read, cost: 0.014–0.250 €
(mistral-small → mistral-medium)`), the operator's view; the member is asked
for consent to read, not for a purchase (Candide, 26 September 2026: spending
is abstract to a member, the household's cap is the only ceiling). The "yes"
is lot 3, below.

### The yes — lot 3 (26 September 2026, evening)

Decisions of the day, built the same evening (`specs/mail-import.md`, lot 3;
`server/src/services/mailApproval.ts`, `tools/email/reading.py`). The yes is
a **consent to read the bodies, not a purchase**: no money in the message,
the tool, the prompt or the app; no ceiling per job — `spend_cap_system_daily`
is the household's only one and the member never sees it. It is given **in
the conversation Maurice opened** ("Your mailbox, in numbers"), by one native
tool granted by that conversation and nowhere else, on the exact model of
`domains__adopt`: **`mail__approve_reading`** (`action` ∈ `approve` /
`decline`), in the roster only when the turn's conversation is the member's
mail one. The link that grants it is `mail_conversations` in `maurice.db`
([[maurice-data-model]]) — written when the night opens the conversation,
filled once at boot from `mail-nightly.json` for the ones opened before, and
mirroring the reading's state (`pending` / `approved` / `declined`) so the
prompt section can say where things stand without a gateway call. The prompt
section carries the domains' rule: never on a hint, an "ok" to something
else, a question or the model's own judgement — an explicit yes only — and,
after a no, **never ask again** (the member may still say yes later,
unprompted, here or in the app; the tool then turns the same job around).

On the tool side, two words join the `email` tool — `approve_reading` and
`decline_reading` (service, MCP, CLI `approve-reading` / `decline-reading`)
— which create or re-mark **one** `reading` job per member in their store:
`JOB_STATES` gains `approved` and `declined`, `budget_eur` stays NULL, the
window sits in `cursor` as `{"years": N}`, and `scan_status` reports it under
`reading`. A second yes marks the same row; a job already running (lot 4) is
left alone. Those two MCP tools are **the server's alone**
(`isServerOnlyTool` in `toolFamilies.ts`, beside the corpus's admin tools):
never in a model's roster, whatever the families say, so no other
conversation can approve on a hint. The second door is the card under
*Settings → Mail* — "Reading: not asked yet / waiting for your answer /
approved on … / declined", one button to approve or withdraw, in the seven
languages — on `POST /api/mail-accounts/reading {action}`; the server then
says in the conversation, in Maurice's voice and rendered without a model in
the member's language, what was done. **What the yes triggers: nothing that
costs.** It leaves the job `approved` for lot 4 — the two reading passes —
and Maurice answers that the reading happens at night, starting the next
one, over a few nights, and that he will come back with what he understood.
Measured spend lands on `spend_ledger.job_id` (built in the same lot) so
the operator sees a reading apart from chat.

### The two reading passes — lot 4 (26 September 2026, late evening)

Settled with the owner before the code: **the server reads, the tool
provides** (the tool has no model and no ledger; the server has both and
the night), and **the full reading leaves one sealed reading per message**
so lot 5 aggregates without opening the bodies again. Four more words on
the `email` tool, all **server-only** like the two of the yes
(`tools/email/reading.py`): `reading_next` (`stage` `light` — the window's
messages not yet judged, newest first, headers, the subject unsealed in
transit, the first 600 characters; `full` — the kept ones not yet read, the
first 16 kB of text; one `BODY.PEEK` FETCH per folder, nothing stored,
nothing marked read, a folder that refuses named in `errors` and its
messages left for the next batch), `reading_record` (the verdicts and the
readings, each reading sealed under the household key before the disk),
`reading_control` (`running` / `paused` / `done` / `failed`, the reason,
the run's measure into `capacity`) and `reading_progress`; CLI
`reading-progress`. The server side is `services/mailReading.ts`: the
**light pass** on the new invocation `mail_read_light` (prefers
mistral-small, pinned at boot like the night's functions) in batches of
twenty — keep a real exchange, skip what no person wrote to the member in
particular — a missing verdict kept rather than lost; the **full pass** on
`mail_read_full` (computed default: the household's everyday model, the one
the member's range was priced on), one call per kept message, one structured
reading in the member's language — summary, kind, people, said, promised,
decided, asked, dates, open, thread — stamped with the model and whether
the text was cut. Both prompts carry the hostile-input line: report, never
obey, never address the member. Every call is checked against the cap
**before** it is made — a refusal pauses the job, it does not fail it — and
recorded after it **as the member, under the job's id**. A run ends `done`
with nothing left in the window, `paused` when a limit, the four-hour night
or the cap stopped it; the next picks up from the store; a job `done` runs
again when new mail lands in the window. **Where it runs:** the night, after
the numbers, for every member whose word is yes (read off
`mail_conversations.reading`, no gateway call); and by hand, `POST
/api/admin/mail/reading/run {member_id | username, limit?, wait?}` with
`GET /api/admin/mail/reading/:member_id` for the last run. The log line:
`[mail] reading for <member>: N judged (K kept, S skipped), R read, C € on
job <id>, done|paused, in Ss`. **The capacity is measured**: a run of a
hundred messages or more leaves `messages` and `seconds` in `capacity`, and
the estimate's nights use the last five runs' messages per hour over a
four-hour night (`nights.measured: true`) instead of the 1 500 assumption.

**Why a mail answer takes as long as it does** (25 September 2026). *Relis-moi
le mail à Jean* took 58 s: 23 s in `search`, 10 s in `get_message`, 25 s across
three model rounds. Neither the network nor Gmail's search is at fault —
measured from the Mac mini, an IMAP round trip is 100–150 ms and the whole
sequence fits in 3 s.

Two of the three are now accounted for. **The second fetch was pure waste**:
reading a 1.9 kB message took a second model round and a second IMAP fetch to
return what the first could have carried, which is what the preview above
removes. **The model is the larger half**: the same question, twice each,
against three models — `glm-5.3-flash` 45 and 51 s wall (30 and 36 s of them
inside the model, 5 to 6 rounds), `mistral-medium-latest` 18 and 22 s (4.6 and
6.8 s), `deepseek-v4-flash-0731` 17 and 27 s (4.7 and 8.6 s). A factor of five
to seven per round, and Flash also takes the most rounds, so it pays twice. It
is the member's own `everyday_model`, so it is the member's lever.

**The third is still open, and one hypothesis has already been buried.** The
23 s looked like the price of a reconnect after eleven idle minutes, and a
keepalive was written for it. An A/B settled it: the same session left idle for
fifteen minutes answered in 1.33 s *without* a keepalive — Gmail had not hung
up — and `lsof` shows the gateway holding a single IMAP connection across
hours and dozens of calls. There was no second login. The keepalive was
dropped. What is left unexplained is a per-call IMAP latency that swings from
0.6 s to 10.3 s on a warm connection with no reconnection in sight, for a 1.9 kB
message — visible in the gateway and in a standalone process alike, which
points away from Maurice and towards Gmail throttling the account. Not
measured, not fixed.

**Where the accounts come from — two sources, merged per member.** Since step 2
(the evening of 25 September 2026) the ordinary one is the **server**: the member
adds a mailbox through `/api/mail-accounts` (see [[maurice-server]]), the
password sealed under the household key in `mail_accounts` (see
[[maurice-data-model]]). The server logs in *through this tool* before keeping
it — one IMAP implementation, in Python: it asks the gateway for the member's
`email__list_accounts` and reads back the new address's state, so a password the
mailbox refuses is never stored and the member sees the reason at once. The tool
reads the accounts, passwords included, from `/api/local/mail-accounts/<member>`
(loopback and the gateway's `MAURICE_MCP_TOKEN`), afresh on every call: an
account removed is gone from the next one, and a new password opens a new
session (the session key carries a fingerprint of host, port, login and
password). A name already taken gets a suffix (`gmail-2`). A gateway started
without the key sees only the file's accounts, and the tool says so instead of
"you have no account".

The second source is the admin's: `email.toml` beside `maurice.db` (`~/.maurice`
on the Mac, the data volume in the container), passwords in the Keychain
(`maurice-email`, the address as account) or `MAURICE_EMAIL_<NAME>_PASSWORD` —
for what the API cannot describe, Proton through Bridge with its Keychain entry
above all. The production image ships the tool (`!tools/email` in
`Dockerfile.dockerignore`); `list_accounts` says for each account whether it was
`added_from` the app or the file.

**The member does it from the app** (step 3, the same evening): *Settings → Mail
→ Mailboxes* in the Maurice app (`MailPane` in `SettingsView.swift`) lists the
member's mailboxes with their state and **Check again / New password / Remove**,
and adds one: the address is typed, the provider is recognised from the domain
(`MailProvider`, the same table as `providers.py`) and its instructions shown,
with a link to the page that makes the password (Google's app passwords, the
Apple Account, Yahoo's security page); Outlook is said to be impossible for now;
an unknown domain asks for its server, or *a Gmail address at work or school*
(Workspace). **Connect** posts to `/api/mail-accounts`, which logs in first; the
screen distinguishes *the mailbox refused this password* (the tool reports an
IMAP `LoginError` as `refused`, "the mailbox refused the login", no longer as
"unreachable") from *Maurice couldn't reach this mailbox*, the mailbox's own
words underneath. Strings in the app's seven languages.

**The family follows the mailbox.** A member with at least one account in
`mail_accounts` holds the `email` family in every private turn
(`hasMailAccount` in `toolFamilies.ts`, unioned in `resolveFamilies`), and the
family is no longer experimental: it is granted by the member's own act of
adding a mailbox, not by the admin's tick. Rooms still withhold it.
Accounts that live only in `email.toml` are not seen by that rule; their owner
picks the family by hand. **The picker says so** (`familiesForMember`, the same
evening): with a mailbox, Email is listed among the always-on families
(*Always on · Web search · Corpus · Signals · Email*); without one it is offered
in the experimental section, for an admin whose mailbox is in the file; a member
with neither sees nothing. The first version made it a "core" family that was
not always-on, which the app shows nowhere — Email was invisible in the picker.
The private `mail` family is titled **Mail triage** there, so the two are not
confused.

**Next**: OAuth for Gmail and Outlook, then optional indexing into the corpus.

## `mail` — the first tool built around a hostile input

Added to the private overlay in September 2026, and the one tool whose design is
driven by its threat model rather than by its capability. It reads two mailboxes
identically — Proton through Bridge on `127.0.0.1:1143` (STARTTLS, self-signed,
the password Bridge generates) and iCloud over TLS with an app-specific password
— and can file a message, narrowly.

- **Lopsided surface.** `list_accounts`, `list_mailboxes`, `search` (envelope
  metadata, never a body), `get_message`, `stats` are general. The only write is
  `triage(account, uid, action)`, where `action` is a key of a **closed
  vocabulary in the config**, never a mailbox name. Each key maps per account to
  one `UID MOVE` (the action-state folders `01 · Répondre` … `Archive`) or one
  `UID COPY` into `Labels/…` (Proton labels, which leave the message in place).
  iCloud has no labels, so the `label_*` actions are *declared* unsupported there
  rather than silently turned into a move. No send, no delete, no arbitrary move.
- **Two axes, since 16 September 2026.** A message has one **state** — where it
  sits in the workflow — and at most one **topic**, the label laid on top. They
  are independent, and that is the whole reason the write path has both `move`
  and `copy`. The classifier shipped asking for a single answer, so the state
  won every time and the ten `label_*` actions were **never proposed once**
  against a real mailbox: ten entries of dead vocabulary. It now returns `state`
  plus `topic` from one call — two calls would double a nightly run for nothing
  — and `topic` may be null, which is a real answer, unlike on the state axis
  where nothing fitting means `unplaceable` and a human looks. Which axis an
  action is on is inferred from its shape (an action that only ever copies is a
  label, and a label is a topic), with `axis = "state" | "topic"` to override.
  **The order of application is load-bearing:** `UID MOVE` takes the message out
  of the source mailbox and its UID with it, so the label is copied on *first*;
  `triage_many` re-sorts defensively so a caller that gets it wrong still lands
  both.
- **The two accounts are not symmetric, and the config says so.** Proton carries
  the action-state reorganisation, so all 14 actions map there; iCloud maps
  exactly one (`archive`), because the state folders do not exist in it and
  inventing their names would only make `validate` fail on day one. The nightly
  proposal never suggests, for a given account, an action that account cannot
  perform. One asymmetry is absorbed in code instead: `UID MOVE` is an extension
  (RFC 6851) — where it is missing a move becomes `COPY` + `\Deleted` + **`UID
  EXPUNGE`**, and only with UIDPLUS; without both, the tool refuses rather than
  improvise a bare `EXPUNGE` that would take other messages with it. An account
  can be parked with `enabled = false` — never contacted, reported as `disabled`
  rather than as a failure, and still bound by the one-member rule.
- **A message body is attacker-controlled text.** `get_message` returns bodies
  HTML-stripped, truncated, and wrapped in untrusted-content markers a body
  cannot forge; nothing a message references is ever fetched. The closed enum is
  the containment boundary: the worst a persuaded model can do is misfile the
  message. There is an injection test that says so.
- **One member, no override.** The config must name exactly one member's
  accounts or the tool refuses to load — v1 declines to ship a weak version of
  the isolation promise rather than fake a partition. The gateway's member
  contextvar is checked on every call. **That check was comparing two different
  namings** until 21 September 2026: the contextvar carries a member *id*
  (`c7267630-…`), `owner_member` in `~/.maurice/mail.toml` is a *username*
  (`candide`), so every call made from the chat was refused — including the
  owner's own, which is the only kind there is. The tool looked alive (it is in
  the roster, Maurice describes it correctly from its schemas) and had never
  once run from a conversation; the CLI and the nightly pass, which have no
  member context at all, went straight through and reported nothing. The name is
  now resolved against `users` in `maurice.db` at load time and the resolved id
  is what the guard compares; `mail.cli validate` prints it beside the name. An
  unreachable registry leaves it unresolved and denies every id-shaped caller —
  the guard fails closed. The lesson is the one the tool families already teach:
  a tool that is *listed* is not a tool that *works*, and nothing between the
  roster and the mailbox was exercising the gateway's own header.
- **Nightly, at 03:30, since 21 September 2026.** The launchd job
  (`com.maurice.mail-proposal`) had been written, documented and never
  *installed*: no plist, nothing loaded, and the last proposal on disk dated
  from the 16th — the same failure shape as the guard above, a piece described
  in the present tense that no machine was running. It is in `launchctl` now,
  every night at **03:30** for the inbox's next 100 messages (~4 minutes at 2.3
  s a message). The half hour is not cosmetic: the server's own passes are on
  the hour — corpus 03:00, briefs 04:00, mapping 05:00 — and share this
  machine's Ollama, so a job on the hour means two local models competing for
  it. And `propose` now **exits non-zero** when every account was skipped for a
  fault and nothing was classified: a night that reached no mailbox used to
  write an empty proposal and return success, which reads exactly like a quiet
  night with no mail to sort.
- **The write path.** `write_enabled` started at `false`; what ships is that
  nightly job producing a *triage proposal* —
  message, suggested action, one-line reason — classified by the local
  `qwen3.6:35b-a3b` through Ollama, with escalation to a larger model opt-in and
  flagged per line. Reasoning is switched **off** in the request (`think:
  false`): qwen3.6 has it on by default, and the chain of thought was being
  generated, paid for, and thrown away unread — only the enum value is parsed.
  Leaving it on cost **58 seconds a message**; without it the same batch runs at
  **2.3**, which is what makes a pass over the whole 3509-message inbox a
  ~2¼-hour overnight job instead of a 57-hour one. Approving replays the proposal through `triage`; every
  attempt, dry run included, appends to `~/.maurice/mail-audit.jsonl`. Each line
  carries the message's **Message-ID** as well as its UID, and `apply` checks it
  first: a UID identifies a message only within one incarnation of a mailbox, so
  a Bridge re-sync between the proposal and the approval turns those lines
  `stale` instead of filing whoever now sits at that UID. A read tool,
  `latest_proposal`, hands that file back — counts per action, what could not be
  placed, what was escalated — so **Maurice gives the morning briefing himself,
  in chat, in his own words**, without opening a mailbox. Its subjects and
  senders carry the same untrusted label a body does: a subject line is a fine
  place to hide an instruction.
- **Rules first, model second.** `[rules]` in the config is a deterministic pass
  that runs before the model: sender address, sender domain, subject substring
  or the presence of a `List-Id`, naming a state, a topic, or both, first match
  winning. It takes **46% of the inbox** (1491 of 3210) — and those are exactly
  the messages a model handles *worse*, since near-identical prompts do not
  yield identical answers even at temperature 0: seven identical eBox notices
  had come back split across two states. `python -m mail.cli sieve` renders the
  same section as a Proton filter, so one source governs both the mail already
  in the mailbox and the mail still to arrive — maintained separately they
  drift, and a Sieve rule that no longer matches fails silently. Domain matching
  lands on a DNS label boundary: `notgithub.com` ends with `github.com` and is
  registrable by anyone, so a suffix test would have handed an attacker
  automatic filing — one message in the real inbox was passing through that hole.
- **A shadowed stdlib module made the classifier lie.** `maurice-tools/` holds a
  tool directory named `calendar/`, and the documented way to run this one is
  from that directory — so a bare `import calendar` found the tool, not the
  standard library. `httpx` needs `calendar.timegm` two levels down, so **every**
  call to Ollama raised ImportError, the classifier caught it, and 150 messages
  came back `unplaceable` as though the model had read them and given up. The
  package now seats the real module in `sys.modules` before anything else, and a
  proposal counts its failed model calls: when all of them fail it says so in
  the header, because "down" and "undecided" must not look alike.
- **The reading horizon, and the first real run.** On 16 September the tool was
  pointed at the actual inbox for the first time: 3510 messages. The classifier
  filed **247 of the first 300 as "to read", 235 of them from 2025** — every call
  defensible (they are newsletters) and the aggregate absurd, because a reading
  queue is a promise to come back and nobody returns to a newsletter from
  eighteen months ago. A date needs no model to be read, so this became a rule
  rather than a prompt: past its horizon a queued message is demoted to
  `archive`, its age written into the line's notes, its topic label untouched.
  Horizons are **per state** because the costs are not symmetric — 120 days for
  `to_read` and `to_waiting`, **180 for `to_reply`**, since archiving a stale
  newsletter costs nothing while burying a real question costs a lot. With the
  rule applied, the same 300 messages came out as 259 archived, 34 automatic,
  and **seven** that actually wanted something from the owner.
- **First write, same day.** 380 operations, no failure, no stale line: INBOX
  3510 → 3210, Archive +259, `04 · Auto` +34, and the three action-state folders
  populated for the first time. The label-before-move ordering held on real
  mail. `write_enabled` is now `true`.
- **The descriptions in the config are the classifier.** Nothing else tunes this
  tool as much, because that text *is* the prompt. It shipped with `"topic:
  enfants"` and three states that each said "no action needed" in different
  words; eleven identical messages from one sender landed in three different
  folders. Rewriting each description to name what belongs in it, with examples,
  put all eleven in the same — correct — folder, with no code change. Read the
  vocabulary before blaming the model.
- Deterministic sender routing stays in the Proton Sieve filter, which runs
  server-side whether or not the mini is awake. The tool is for the residue.
  `mail/zero-inbox-routage.sieve` is that filter, written from the real sender
  histogram (1073 messages, June→September 2026): GitHub, statuspage, the NYT,
  Substack, bpost and the rest — about a third of the intake, filed on the sender
  alone. It has to be pasted into Proton by hand, since Sieve lives in the
  account rather than on the mini, and it only ever applies to newly delivered
  mail: the existing pile is the tool's job. Its header records why the commune,
  the single biggest sender of the residue, is deliberately *not* in it — the
  same address sends "Dossier en cours de traitement" (wait) and "Information
  manquantes" (they need an answer) on the same day, and a rule keyed on the
  address buries the one that mattered. The local model split those two
  correctly; that is the line between the two halves of the triage.

Its one dependency worth noting is `imapclient` — mailbox names here carry `·`
and accents, which is modified UTF-7 on the wire, and bare `imaplib` would get
them wrong. On **Python 3.14** that dependency needs help: 3.14 turned
`imaplib.IMAP4.file` into a read-only property backed by `_file`, and imapclient
4.0.1 still assigns to `file` after wrapping the socket — so STARTTLS completes
the handshake and *then* raises, leaving a connection that is encrypted and
unusable, reported as `unreachable` as though Bridge were down. `imap.py` carries
a `_starttls()` that does the same two steps and writes to whichever attribute
the interpreter has, refusing if the failure came before the handshake. Drop it
when imapclient ships the fix.

## Gaps & notes

- **The gateway enforces none of this.** Families and the experimental flag live only in the Bun server. A client that authenticates straight to the MCP gateway — a member token, an OAuth custom connector — gets the *complete* mounted roster, whatever the member was granted in the app. Closing that is its own piece of work. (The native tools — `maurice_docs`, the four `domains__*`, `mail__approve_reading` — are the exception by construction: they live in the server's loop and the gateway never sees them; the nine server-only `email__reading_*` / `email__documents_record` words, though, are mounted like any tool and a caller with a member token could speak them for that member — approve, or read that member's bodies; `corpus__map_conversations`, though, is mounted like any corpus tool and reads whatever member the caller claims.)
- **A hosted household's gateway answered anyone, until 25 September 2026.** The server proxies `/mcp` to the gateway verbatim, and `start-mcp-gateway.sh` turns auth on only when `MAURICE_MCP_TOKEN` (or an OAuth password) is set — which nothing set in the container. So `https://<household>/mcp` accepted MCP calls with no credentials at all, for whatever member id a caller put in `X-Maurice-Member-Id`: every member's garden and corpus were readable from the internet (found while wiring the mail tool, before any mailbox was added on the fleet). `infra/container/entrypoint.sh` now gives each household a key of its own (`~/.maurice/mcp.token` in the volume, generated once, exported before supervisord); verified the same day: anonymous `/mcp` is 401 on both hosted households, the server's own calls 200. Nothing records whether the hole was used before — the gateway logged requests but not their origin.
- **`email` cannot reach Outlook.com.** Microsoft takes only OAuth over IMAP; not built. Nor does it index mail: search is IMAP's own (Gmail's is good, others' less so). The header store (above) is not a search index either: bodies are never kept, and a subject can only be read by unsealing it.
- **The triage knows no contacts.** `triage_mailbox` takes a list of addresses and nobody passes one: the `contacts` tool is private (vCard, `maurice-tools`) and the public `email` tool cannot import it. A single reconciled list of a member's contacts is a design of its own (26 September 2026); until then only "replied" and "sent" make a person, and a contact who never got a reply is "other".
- **The calibration's tokenizer is a proxy** (`tiktoken`), not Mistral's; **a night's reading capacity is assumed** (1 500 messages) until lot 4 exists. The range is wide enough for the first; nothing yet checks the second.
### The documents — lot 5 (26–27 September 2026, night)

Settled with the owner, built the same night (`server/src/services/mailDocuments.ts`; `tools/email/reading.py` for the material). **What is written**: a fiche per person with two read messages or more — a relationship, not a portrait: since when, who they are to the member, what is going on, what was promised and by whom, what is left open — and a digest per thread with two or more: what it is about, a dated timeline, the decisions, the open questions; the rest lives in the fiches. **Where**: notes in the member's garden, `notes/<locale>/`, tagged `mail` + `correspondent` / `thread`, under a hub "My mail" (a MOC, `mail-hub`), with the seeding's marks — `meta.opened: false`, `meta.author: maurice`, `meta.origin: mail`, the source `key` and the cited message ids in `meta.sources` — and a "where it comes from" section that carries the **disclaimer** on the page (*Part of this note was written by a machine reading your mail. Every line points to the message it comes from.*), the model, the date, the messages read. **The pointer**: the model ends every line with the indices of its sources; the server turns them into *(22 Sept 2026, Jean Derély, « Toujours à Bruxelles ? »)* after the line, keeps French spacing before `;` and `:`, and **drops a line with no source**. `get_by_id` (member-facing, the seventh read of the `email` tool) reads a message by the id a note carries, so Maurice can check a line against its message in a conversation. **Before writing**: the full pass now cuts the quoted part of a reply (`strip_quoted` — every `>` line, and everything from the line that introduces a quoted or forwarded message in the house's languages, when the message's own text precedes it), reads 48 kB instead of 16, and no longer lets the model assume the member's gender; `reading_reset` (server-only) forgets the readings whose text was cut so the next pass reads them again. Three more server-only words: `reading_material` (every reading unsealed, with its thread root — the report's grouping), `reading_reset`, `documents_record`. **Second runs**: `artefacts` in the store, keyed on the source (the address, the thread root) — a note the member threw away is found missing once, marked, and never written again; a note still there is rewritten only when new messages joined its sources; the hub is refreshed when anything was written. The model is the night's (`mail_write`, DeepSeek V4 Flash by preference), on the ledger as the member under the reading job's id. The night writes after a reading that read something; by hand, `POST /api/admin/mail/documents/run {member_id | username, wait?}` and `GET …/:member_id`. Then **Maurice comes back** in the mail conversation, without a model, in the member's language: how many fiches and digests, the hub's path, the titles — the promise of lot 3, kept.

- **Half the readings are cut** on the owner's first real run (26 September 2026: 318 judged, 82 kept and read, 0.09 €, 303 s — 4 075 messages an hour, so the estimate now says 16 300 a night, measured): 42 of the 82 bodies went past the 16 kB slice, HTML and quoted threads mostly, and the reading said `truncated`; lot 5 cut the quoted part and widened the slice to 48 kB, and those 42 were read again.
- **The documents' limits** (lot 5). The disclaimer marks the note, not its sections; the one-click source in the app does not exist (the pointer is readable, the id is in the frontmatter, `get_by_id` resolves it in a conversation); a person on two addresses is two fiches until a contact list exists; a member's only way to say "no more about this person" is to delete the fiche once, which holds. A reading the model cannot shape is left for another night, twice per batch, with no ceiling on how many nights. The Settings card shows the walk and the word, not the passes' progress nor the notes; the cost range and `spentOnJob` live in the log and the ledger only, no console card yet. A member's yes given from the card before any conversation was opened is kept but said nowhere. Notes written by the server go straight to the files, as the seeding's do, so they reach the corpus index only at the next reindex, not through the garden tool's write hook.
- **`web` and `signals` can't be turned off.** They're re-unioned into every resolution, so unticking them in the picker does nothing.
- **Family selection is coarser than it looks.** `toolInFamilies` still accepts the parent prefix for back-compat, so a conversation holding `"garden"` opens all 54 garden tools at once, sub-families included.
- **No per-tool sandboxing.** A tool runs with the gateway's process privileges; the only access control is the member contextvar and tool-family gating, not OS-level isolation.
- **Discovery is positional.** A tool is "installed" by being a directory under `tools/`; there's no manifest or version pinning across the public core and the private overlay.
- **The roster drifts from this doc.** Treat [[maurice-knowledge]] and [[maurice-life]] as the live capability list; this note is the wiring.
- **Not everything is a tool.** The articles pipeline, résonances and flashcards are TypeScript services in the server's data-api, called by [[maurice-carnet|Carnet]] and the clipper over HTTP; the garden MCP tool reaches the articles endpoint, but résonances and flashcards have no MCP face yet.
- **The garden tool knows the unreviewed mark** (19 September 2026): `list_notes` answers `unreviewed: true` for a note carrying `meta.opened: false` (one Maurice seeded at a domain's adoption, [[maurice-knowledge]]), `get_note` shows the `meta` block as it is, and `update_note` with a `body` clears the mark — rewriting the note through Maurice is the member's review of it (`reviewed` in its `updated` list). `create_note` does not set it: only the server's seeding writes a note nobody dictated.
- **The repo venv's Python is patched by hand.** Homebrew's `python@3.14`
  bottle (3.14.5 and 3.14.7 both) builds `pyexpat` against a recent expat but
  links it to `/usr/lib/libexpat.1.dylib`, which macOS 26 ships older. The module
  then fails to load on a missing symbol — and since `plistlib` imports it and
  `platform.mac_ver()` reads a plist, **`pip install` dies at startup and `uv`
  rejects the interpreter outright**, for every tool in the venv, not just
  `mail`. `scripts/fix-python-expat.sh` repoints the module at Homebrew's own
  expat and re-signs it. It lives in the Cellar, so **every `brew upgrade
  python@3.14` undoes it**; re-run the script after one, and delete it once a
  bottle links expat correctly.
- **Every tool call is logged** to the API log since August — which tool, its arguments, whether it failed, how long it took — so the next post-mortem of a bad turn isn't done by hand.
