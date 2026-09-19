---
title: The MCP tool ecosystem
date: '2026-09-19'
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

100+ tools would drown a model (and a small local one especially). **Tool families** group tools by server prefix and gate which a turn may use, resolved in order: **conversation override → persona → household default → tier default**. The tier default is now *empty* for every model, cloud or local: only the always-on families (`web`, `signals`) are unioned back in, so everyday tools are opt-in per chat. The `garden` family is itself sub-split (`garden-notes`, `garden-journal`, `garden-people`, `garden-fragments`, `garden-media`, `garden-publish`, `garden-other`) in `server/src/services/toolFamilies.ts` so a persona can grant, say, journalling without publishing.

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

## The domain proposal tools — `domains__propose`, `domains__adjust`, `domains__adopt`

Three more native tools since the night of 19 September 2026 (P2-B of the domains roadmap, `server/src/services/domainProposals.ts`), and the first ones **granted by the conversation rather than by a family**: they exist in exactly one place, the conversation Maurice opened at night to propose [[maurice-domains|domains]], while at least one proposal in it is still open — and nowhere else, whatever the member's families or experimental flag say. `domainToolsFor(conversationId, memberId)` answers the three or nothing; the check is made again inside every call, on the conversation itself, so a stale roster cannot reach them. They are appended after the MCP roster so an ordinary conversation's cached prefix does not move, and the roster notice lists them as *Domain proposals* (a `domains` family that is `core` in `toolFamilies.ts`, so the experimental gate never withholds them).

- **`domains__propose`** — `list` (default) the open proposals with their sample conversations; `show` one in full, with every conversation it holds (up to 200, with ids — what a split needs); `add` a domain the member named that the night did not find.
- **`domains__adjust`** — `rename` (name and/or summary), `merge` several into one new proposal (the sources are marked `superseded`), `split` one into parts, each with the conversation ids that go to it (what is not assigned stays in the original), `dismiss` — the member says it is not a domain: it is put away and its conversations never come up in a mapping again.
- **`domains__adopt`** — the only thing that creates a domain from a proposal, and the prompt section of that conversation says it plainly: never on a hint or an "ok" to something else, only after the member's explicit yes. It creates the row of `maurices` (kind `domain`, created by the member, the summary as its statement, the three closest conversations baked into its context), binds every conversation of the proposal to it (`conversations.maurice_id`, when not bound elsewhere), and starts the first brief in the background through the briefs service — on the night model, charged to the ledger's `system` spender. The tool answers at once and Maurice is told to say the brief will appear on the domain's page shortly.

The night's own corpus tool sits behind them: **`corpus__map_conversations`** (`tools/corpus/src/mcp_server.py`, the arithmetic in `src/domain_map.py`) groups the caller's conversations by their vectors — one centroid per conversation on the roles asked for, spherical k-means, a merge of close centroids, a second level on any group above `split_above` — and returns groups of conversation ids ordered by closeness with their cohesion, no names, no dates. It reads the member's file only, through the store's `conversation_centroids`, so the gateway stays the only process that opens the stores; the step-0 script `map_domains.py` calls the same code. What the server does with the groups is in [[maurice-server]] and [[maurice-domains]].

## Ships vs. exists — and it's enforced in code

The public/private boundary is not aspirational; it is in `.gitignore` and `tools/README.md`:

- **Public (ships):** `garden`, `corpus` (since September 2026 — it came in with its history and a test suite; its data, logs and `config/corpus.yaml` stay ignored, a `corpus.example.yaml` ships), `shared`, `mcp_gateway`.
- **Private overlay (gitignored — the `maurice-tools` repo):** `tracks`, `health`, `signals`, `tasks`, `calendar`, `contacts`, `calibre`, `readwise`, `compte`, `social`, `layouts`, `thoughts`, `mail` (September 2026), and `pipelines`.

**Secrets live in `.env`, never in a tracked config file.** Both repos load one with `python-dotenv`, walking up from the source file to the first `.env` found; `maurice-tools/.env.example` documents the variables the overlay needs (`NEBIUS_API_KEY` for Calibre chapter summaries, `CALIBRE_API_KEY` for the book-browser artifact). Tracked config files hold only non-secret defaults — models, base URLs — and a missing key now fails with a named error instead of a `KeyError`. This replaced two credentials that had been committed to the private repo (September 2026).

The gateway auto-discovers whatever directories are present, so a public checkout runs **garden-only**, while the home install overlays the private tools. This is exactly the *chat + garden ship first, the rest roll out gradually* line, made concrete at the filesystem level.

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
  contextvar is checked on every call.
- **Read-only for now.** `write_enabled = false`; what ships is a nightly
  launchd job (`com.maurice.mail-proposal`) that produces a *triage proposal* —
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

- **The gateway enforces none of this.** Families and the experimental flag live only in the Bun server. A client that authenticates straight to the MCP gateway — a member token, an OAuth custom connector — gets the *complete* mounted roster, whatever the member was granted in the app. Closing that is its own piece of work. (The native tools — `maurice_docs`, the three `domains__*` — are the exception by construction: they live in the server's loop and the gateway never sees them; `corpus__map_conversations`, though, is mounted like any corpus tool and reads whatever member the caller claims.)
- **`web` and `signals` can't be turned off.** They're re-unioned into every resolution, so unticking them in the picker does nothing.
- **Family selection is coarser than it looks.** `toolInFamilies` still accepts the parent prefix for back-compat, so a conversation holding `"garden"` opens all 54 garden tools at once, sub-families included.
- **No per-tool sandboxing.** A tool runs with the gateway's process privileges; the only access control is the member contextvar and tool-family gating, not OS-level isolation.
- **Discovery is positional.** A tool is "installed" by being a directory under `tools/`; there's no manifest or version pinning across the public core and the private overlay.
- **The roster drifts from this doc.** Treat [[maurice-knowledge]] and [[maurice-life]] as the live capability list; this note is the wiring.
- **Not everything is a tool.** The articles pipeline, résonances and flashcards are TypeScript services in the server's data-api, called by [[maurice-carnet|Carnet]] and the clipper over HTTP; the garden MCP tool reaches the articles endpoint, but résonances and flashcards have no MCP face yet.
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
