---
title: Maurice — architecture overview
date: '2026-09-19'
flags: []
locale: en
description: The five cooperating parts of Maurice, how a message flows end-to-end,
  and where each concern lives.
tags:
- maurice
- documentation
- architecture
icon: layout-dashboard
parent: maurice-docs
---

# Architecture overview

Maurice is five cooperating parts. Two native clients are pure clients — the **Maurice app** for conversation and **Carnet** for capture and reading — and all state lives in the **server** and on disk. The server is both a chat engine and a personal-data API. It reaches Maurice's capabilities through a fleet of MCP **tools**. And the private Markdown garden is rendered as a website by the **web** component.

```
┌─────────────────┐ ┌──────────────┐  HTTPS/WS   ┌──────────────────────────────┐
│  Maurice app    │ │  Carnet      │ ──────────> │  Server (Hono / Bun)         │
│  iPhone/iPad/Mac│ │  iPhone/iPad │ <────────── │                              │
│  chat · domains │ │  log · read  │  streaming  │  src/      → chat engine      │
│  composer       │ │  garden      │             │  data-api/ → personal data    │
│  dictation      │ │  share sheet │             └──────┬─────────┬─────────────┘
└─────────────────┘ └──────────────┘                    │         │
        ┌──────────────┐                     MCP (loopback)   Anthropic API
        │ web clipper  │ ────────────────────────┐   │         (+ Ollama / OpenAI /
        │ (browser)    │                         │   │          Mistral / Z.ai)
        └──────────────┘                  ┌──────┴───┴──┐
                                          │ mcp_gateway │
                                          │ garden ·    │
                                          │ corpus · …  │
                                          └──────┬──────┘
                                                 │
                                    ┌────────────┴────────────┐
                                    │ SQLite · Markdown garden │
                                    │ (git, ~/.maurice/gardens)│
                                    │ vectors · files · Calibre│
                                    └────────────┬────────────┘
                                                 │ Astro
                                          ┌──────┴──────┐
                                          │  web garden │  /g/<member>, Cloudflare
                                          └─────────────┘
```

## The five parts

**Maurice app** (`app/Maurice`) — Native SwiftUI, one multiplatform target for iPhone, iPad, and Mac. It renders the chat experience and never holds authoritative state: it pairs to a server, authenticates a member, and talks HTTPS + WebSocket. Since August it also dictates (on-device speech, with the iPhone's Action Button as a shortcut) and shows what each turn cost; since 19 September 2026 it shows **one Maurice** and, beside the conversations, the member's **domains** — the parts of their life he follows, each with the brief he keeps on it — where it used to offer a roster of specialized Maurices to summon. See [[maurice-chat]], [[maurice-domains]], [[maurice-personas-hats]] (what became of the personas), [[maurice-composer]].

**Carnet** (separate repo, `carnet/`) — The iOS/iPadOS companion, sharing the design system and the household identity with the Maurice app. Where Maurice is the conversational front door, Carnet is the pocket client for *capturing and consuming*: log signals, read books and articles, browse the garden, and save what you read into it through a share sheet. See [[maurice-carnet]].

**Server** (`server/`) — A single Bun process on Hono, split in two:
- `server/src` — the **chat engine**: auth, users, conversations, domains and reading companions (`maurices`) with their briefs, files, gardens, the context composer, models, moderation reports, and the streaming agentic loop that calls the LLM and executes tools.
- `server/data-api` — the **personal-data layer** mounted at `/api/v1/*`: health, tasks, signals, tracks/dossiers, coaching, Calibre, bank, layouts, places, uploads — and, since August, the **garden's media**: article saving, entries, résonances, flashcards. Same process, different concern.

See [[maurice-server]] and [[maurice-data-model]].

**Tools** (`tools/`) — Python MCP servers behind a single `mcp_gateway`. This is how Maurice *does* things beyond talking: read and write garden notes, semantic search (corpus), research (tracks), log signals, query health, manage tasks, and more. The server's agentic loop discovers and calls these over a loopback MCP connection. See [[maurice-tools]].

Two of them ship — **garden** and, since September 2026, **corpus** (moved into this repo from its own). The rest (Calibre, tasks, coaching, health, tracks, …) live in the private **`maurice-tools`** overlay, are in daily use at home, and roll out gradually as each is polished. The documentation distinguishes throughout between *what ships* and *what exists*.

**Web** (`web/`) — An Astro site that renders each member's garden as a browsable, themeable website under `/g/<member>`, with build-time encryption of private notes and Cloudflare deployment for the public one. See [[maurice-web-garden]] and [[maurice-shared-gardens]].

There is also a small **browser clipper** (`clients/web-clipper`) that saves the page you are reading — its rendered DOM, past any paywall — into the garden as an article fiche, the same way Carnet's share sheet does.

## How a message flows

1. The app POSTs a user message (optionally with an image) to `POST /api/conversations/:id/messages`.
2. The server stores it; in a multi-person room it fans the message to participants over WebSocket. Maurice only *replies* when summoned (`@claude`/`@maurice`); a plain "bubble" message is human-only.
3. The engine assembles a system prompt (household context, the member's profile, the bound domain or companion if any, the [[maurice-composer|composer context]], then — in a private conversation — the briefs of the member's [[maurice-domains|domains]]) and the conversation history. The history is **bounded by the model's context window**: when it outgrows what the roster says the model takes, the oldest turns are left out, the cut is remembered on the conversation so the next turn sends the same prefix, and the model is told the beginning is missing.
4. It resolves the usable model: the bound row's preference → household default → the member's best available, across Anthropic / Ollama / OpenAI / Mistral / Z.ai / Scaleway.
5. It discovers all MCP tools the conversation is allowed (filtered by *tool families*, sorted for a stable prefix), and streams a request to the model. On Anthropic the request carries **prompt-cache breakpoints** — on the system prompt and tool roster, on the end of the history, and on the growing tool-result trail — so each agentic round and each next turn re-read the prefix at a tenth of the price instead of re-paying for it. The clock rides at the tail of the messages, not in the system prompt, for the same reason.
6. As the model streams, the server emits newline-delimited `StreamEvent` objects: `text_delta`, `thinking` (a reasoning model at work, nothing visible yet), `ping` (keepalive after 15s of silence), `tool_call` (start/end), `tool_data` (structured rows), `usage` (what the turn cost, once, before `done`), `done`, `error`. Tool-use blocks are executed (web search or an MCP `callTool`) and fed back; the loop runs up to 6 rounds.
7. The app renders text live, shows tool activity, draws structured results as [[maurice-chat|data cards]] beside the prose — a deterministic channel that puts a floor under tool-result hallucination — and, if the member asked for it, the turn's cost under the reply.

## Where each concern lives

| Concern | Home |
|---|---|
| Chat, domains, composer, gardens, files, reports | `server/src/routes` + `server/src/services` |
| Health, tasks, signals, tracks, coaching, calibre, places, uploads | `server/data-api/routes` |
| Garden media: articles, entries, résonances, flashcards | `server/data-api/routes/garden-*` + `services/garden*.ts`, `flashcards.ts` |
| LLM call + agentic loop + cache + context window | `server/src/services/claude.ts` (+ `ollama.ts`, `openaiChat.ts`, `contextWindow.ts`, `pricing.ts`) |
| Tool capabilities | `tools/<server>` via `tools/mcp_gateway` |
| Auth (sessions, PINs, invites, devices) | `server/src/services/auth.ts` |
| Persistent state | SQLite (`maurice.db` for the engine, `~/.maurice/data/*.db` for the data-api), the Markdown gardens (git, `~/.maurice/gardens/<member>`), the corpus vectors, files on disk, the Calibre library |
| Public/garden rendering | `web/` (Astro → `/g/<member>` via the server, Cloudflare Pages for the public site) |

## Running it

**Maurice is delivered as a container, and only as a container** (decided
14 September 2026). The promise used to be the opposite — no Docker, a
notarized `.pkg`, a server you install like any Mac application — and that
promise is retired. One image is built here and run wherever it is meant to
live: a rented Linux machine, a client's own server, or a Mac through
OrbStack. What gets developed is what gets delivered, and there is no second
packaging to keep in step with the first.

What that cost to say honestly: the `.pkg` and its installer stop being the
distribution story, and anyone who wants Maurice needs Docker. What it buys is
one build, one set of dependencies, one place a bug can be, and a machine that
can carry twenty households instead of one.

The **home Mac is now the exception, not the model**: it still runs as launchd
agents, and migrating it into the container is the last step. Everything below
describes that install while it lasts.

At home the whole thing is a set of **launchd agents** (`scripts/service.sh`): `com.maurice.api` (the server, port 3001), `com.maurice.mcp-gateway`, `com.maurice.web` (the Astro engine), a nightly `com.maurice.backup` of `maurice.db`, and one extra `com.maurice.household.<name>` per additional household — each its own server process on its own port with its own `MAURICE_DATA_DIR`. They start at login and restart on crash; there is no process to babysit. The server reads `~/.maurice/config.toml` and `~/.maurice/.env`.

The apps ship through TestFlight. The server does **not** ship as a `.pkg` any
more: `infra/installer` built a notarized one and it worked, but maintaining a
macOS package beside the container meant two builds, two sets of assumptions
about what is on the host (a system `git`, a python, a node), and two ways for
an install to be subtly different from the one being developed. The container
is the single answer; the landing page's *Getting started* needs rewriting to
say so.

### The Linux container — the target, running beside macOS

Since 9 September 2026 the same server also runs as a **Linux container** (`infra/container/`, driven by `scripts/container.sh`). That container is the intended shape of the product: one image, whether it runs on the home Mac through OrbStack, on a throwaway demo instance, or on a client's own machine. What gets developed is what gets delivered.

**Both installs run at once, on purpose.** macOS is still production. The container publishes **:13001** while launchd keeps :3001, and it never touches `~/.maurice` — its data lives in a named volume filled from a *copy* (`container.sh seed`, which snapshots the live SQLite databases with `VACUUM INTO` over a read-only connection). Pointing a container at the live database would rewrite production, because `db.ts` migrates the schema at startup; and SQLite locking across a macOS→Linux bind mount is not reliable. This coexistence ends when the Linux side is validated and the data is migrated for real — not before.

It is **one container, not four services**, because the Bun server reverse-proxies the MCP gateway and every per-member Astro instance over `127.0.0.1` in hard code, and starts those instances itself from `gardens.json` — five Astro processes on 4321–4325 in this household. One network namespace keeps that true and needed no application change. `supervisord` runs the same `scripts/start-*.sh` the launchd agents run, so a fix to a launch script reaches both installs. There is no sidecar at all: the vector store has been **sqlite-vec** for a while — per-member DB files, no daemon — the `qdrant:` block still sitting in `corpus.yaml` is a migration reference, and the stale docstring in `tools/corpus/src/store.py` ("Today only Qdrant exists") is worth deleting before it costs someone else a wasted sidecar. Only :13001 is published, because there is only one ingress: Astro and the gateway bind `127.0.0.1` and are reached through the server's authenticated reverse proxy.

**What the port cost, in code:** almost nothing. One hardcoded macOS path (`calibredb` inside the app bundle — now environment → PATH → bundle), a `MAURICE_CALIBRE_DISABLED` flag so an install without Calibre says so rather than failing at spawn, and one real precedence bug the port exposed: `load_env()` in `scripts/_lib.sh` let `.env` overwrite variables already exported — invisible on macOS, wrong anywhere else. Everything else is volumes and configuration. The rest of the porting work was in the *coexistence*: the container and the Mac would otherwise have fought over `node_modules` (darwin-arm64 `sharp`), `data/`, `logs/`, the garden image symlinks that `download-images.ts` rewrites at every Astro start — and, worst of the set, **the corpus vector store**. sqlite-vec keeps its per-member DBs *inside the repo tree* (`tools/corpus/data/vectors`, 730 MB), which the bind mount shared: `lsof` caught OrbStack and the Mac's Python gateway holding `index_state.db` open at the same time, two writers on one SQLite file across virtiofs. It has its own volume now, seeded by the same `VACUUM INTO` pass — verified afterwards with a real KNN query, 87 046 vectors, `integrity_check: ok`. That the vector store lives in the repo at all is a gap for a shipped install, which has no repo: `store.path` belongs in the data dir.

**Calibre, and the base image.** Added 10 September 2026, and it decided the whole base. `calibredb` is needed for exactly *one* route (`POST /add`) — every read path opens `metadata.db` as plain SQLite and splits EPUBs with the vendored `tools/calibre/lib` scripts. But the library here is written by Calibre 9.5 (`user_version` 27) and Debian bookworm ships 6.13, which cannot open it; **Ubuntu 26.04 ships 9.2.1**, which opens and lists it without migrating it. Upstream's Linux build is x86_64-only, so on arm64 the distro *is* the version. Ubuntu 26.04 is also the Scaleway host image, so the OS under the app in development is now the OS under it in production. Cost: 1.27 GB, image at 3.15 GB. Side effect worth having: Ubuntu's python3.14 has a **working pyexpat**, which is the only reason `.venv-calibre` exists on the Mac — the container needs one venv, not two, exactly as predicted.

**What Calibre uncovered was bigger than Calibre.** Thirteen entries under `tools/` are symlinks into the private `maurice-tools` repo, and they had been dangling in the container from the start: the MCP gateway was coming up with **two** tools instead of fourteen, and nothing said so above a warning. Mounting that repo (the symlinks are relative, so they name their own mount point, `/maurice-tools`) fixed eleven; the last two needed the tools' own import paths, which the Mac gets from `pip install -e`. Reproducing that with `PYTHONPATH` then broke the gateway outright — **`tools/calendar` shadows the stdlib `calendar`**, so `http.cookiejar` fails, so `httpx` fails, so the gateway reports "no Python with the deps" and dies, a mile from the cause. `PYTHONPATH` is searched before the stdlib; a `.pth` file is appended after it, which is why `pip install -e` never had the problem. With the `.pth`, the container discovers **14 tools — one more than the Mac**, which still fails on `compte`.

**A deployable artefact, from 10 September.** Until then the container was a *development* image: `/app` was empty and the sources arrived through a bind mount, so it ran nowhere but the Mac. The Dockerfile now has two targets. `dev` is the everyday container — bind-mounted sources, hot reload, Calibre, the private overlays. `production` is the deliverable: sources COPYed in, dependencies installed in place, **2 MCP tools instead of 14** (`garden`, `corpus` — the same public surface `infra/installer/build.sh --public` ships), no Calibre, 2.03 GB against 3.15, behind Caddy with a Let's Encrypt certificate. The build **fails** on a dangling symlink rather than quietly including a private repo. `scripts/deploy.sh` ships it; `infra/cloud-init/maurice.yaml` prepares the machine and is plain cloud-init with no provider metadata, so it runs on Scaleway, on a client's server, or in a Linux VM on a Mac mini — which is what keeps that option open for free.

Two things production had to fix that development never noticed. **Repo-relative state**: `data/`, `logs/` and `tools/corpus/data` are paths the app writes to inside the repo, which in production is an image layer — discarded when the container is replaced. The entrypoint symlinks all three into the data volume; without it every deploy would silently drop the vector index. And **the corpus config**, which is gitignored because it names absolute paths, so it is not in the image — and corpus does not merely fail to load without it, it takes the whole MCP gateway down at startup, `garden` included. That fragility (one tool's failure costing every tool) is worth remembering: it is why a missing embedding key now makes the container refuse to start with one line instead of crash-looping.

**And a primitive that was simply missing.** `createUser` creates a row in `maurice.db` and stops: no garden directory, no `gardens.json` entry — and *nothing in the repo writes that manifest*, it is read by three places and maintained by hand. So on a fresh install a member exists, can log in, and `/g/<them>` answers "Garden not available". `scripts/provision-member.ts` is the missing half. Related: `start-web.sh` hardcoded `candide` as the garden it serves, which is correct on exactly one machine in the world; it now reads `MAURICE_DEFAULT_GARDEN`.

**What a household costs, measured 14 September 2026** on the production image,
idle, on the real content: **~260 MB**, plus ~15 MB for the shared Caddy. An
8 GB machine therefore carries around twenty households, a 16 GB one around
forty — several euros a month each, not one machine each. That number is new:
until the garden engine left `astro dev` (see [[maurice-web-garden]] and
`docs/garden-server-mode.md`) a household ran one Vite dev server **per
member** and cost two to three times as much, and the cost grew with every
member added. It no longer does: one built engine serves the whole household,
and a member costs a directory.

`infra/container/MULTI-HOUSEHOLD.md` is how several live on one machine — one
compose project per household, its own volume, behind one Caddy that routes by
name; `ops/household.sh` adds and removes them.

**The first rented host, 17 September 2026.** `maurice-fleet`, a Scaleway
BASIC2-A2C-8G in Paris — 2 ARM vCPU, 8 GB, 40 GB of block storage, about 25 €
a month plus the IPv4 — carries the **friends' households first**: Aline's and
the App Review one, moved from the Mac with their data. The demo fleet waits,
by decision that day: same machine, same edge, same deploy path, and none of
the demo machinery to build before someone real uses it. What the move proved:
the multi-household shape works on a real host; an update is one command
(`scripts/deploy.sh maurice-fleet`, through a private Scaleway registry, with
the shipped image recorded host-wide so a later restart lands on it); and a
household thinks on Scaleway end to end — `bge-multilingual-gemma2` for the
corpus, Mistral Small 3.2 as the chat default — under one IAM key that can do
nothing but that. The cutover happened the same day: the two A records now
point at the host, grey and unproxied, and the Mac's tunnel no longer lists
them; Caddy had both certificates within a minute of the DNS change. The
Mac-side instances are stopped, not deleted. Not yet: backups of the host's
volumes. See [[maurice-server]] for the operator side.

**Still open:** TLS on the Mac, off by default because `server/certs/` holds a Tailscale certificate for the Mac's tailnet name. `astro dev` in production — five Vite dev servers are 87 % of the container's memory, and the way out is half-built already (`web/src/lib/notes-fs.ts` reads notes off disk at request time, so a *built* SSR server stays live). Repo-tree state — `tools/corpus/data`, `data/uploads`, `logs/` are repo-relative paths that volumes hide here and that a shipped install, having no repo, cannot have. The `.pkg`'s future is undecided. `infra/container/README.md` is the operating manual.

## Networking & sovereignty

**One European supplier can now provide the whole chain — and does, since 17
September 2026, for the two households on `maurice-fleet`.** Scaleway sells both
halves: the machine (Cloud Instances, ARM, Paris) and the model (Generative
APIs — OpenAI-shaped, French datacentres, a provider in the server since that
day, see [[maurice-server]]). So an instance can be hosted, and
its Maurice can think, without a byte leaving the EU and without the person
using it having to bring an API key of their own. That is the difference
between a sovereignty *argument* and a sovereignty *product*: one contract,
one jurisdiction, nothing to explain to a buyer's legal department. It also
makes the demo fleet possible at all — see below.

The server is meant to run on hardware the household owns (the home Mac). It does not manage TLS or remote access itself — that is **deployment plumbing the operator chooses**, not part of Maurice. The two known options are **Tailscale** (private mesh; at home the server serves HTTPS straight off a Tailscale certificate) and a **Cloudflare Tunnel** (public hostname). Clients require the server to be reachable; there is no cloud account, no analytics, no email. The data stays where the household put it. This is the sovereignty story from the [[maurice|vision]], made concrete.

### Demo servers, so anyone can actually try it

A self-hosted assistant has a cold-start problem no screenshot solves: the
apps are useless without a server, and nobody installs a server to find out
whether they want one. The answer is a **fleet of demo instances** — enough of
them running that anyone who downloads Carnet or the Maurice app can point it
at one and use the real thing within a minute, with no account, no machine and
no commitment.

They are throwaway by construction: seeded with public-domain content, a TTL
of a couple of weeks, and a standing instruction not to put real data in them.
That is what makes them safe to hand out, and it is also the one place where
the data is Candide's responsibility rather than the household's — see
[[maurice-hosting-liability-model]] and [[maurice-demo-fleet-hosting]].

Two things made this affordable rather than theoretical: a household that
costs ~260 MB instead of a machine, and a supplier that sells the hosting and
the inference together.

### Open question — the git runtime

The gardens are git-backed, one repository per member, and the server performs git operations (a commit on every garden write, a push when a remote exists). What is **still not settled** is how git is provided in the shipped product: the server shells out to the **system `git`**, which a packaged install can't assume. A git capability bundled with the server app is the likely answer; until then, treat "git is present on the host" as an assumption, not a guarantee. (At home it is, and it works.)

## Gaps vs. the vision

- The vision's **temporal mirror** (Maurice generating daily/weekly/monthly reviews of what you've been investigating) is **not built** — it was wishful thinking and has no code behind it.
- The vision's idea of Maurice **noticing patterns** and proposing notes is **not built and not intended** — note-taking is a deliberate act; nothing enters the garden without an explicit human request. The one automatic write, the article fiche a share creates, is deliberately marked *unopened* until the reader writes on it (see [[maurice-knowledge]]).
- The vision's **hats** — scopes that *emerge* from the active note subtree — are closed by another route since 19 September 2026: the persona roster is gone, a **domain** is the scope, and the roadmap has it proposed from the conversations at night rather than derived from a folder. Until that night runs (P2-B), a domain is still made by hand.

These are good feature-discussion starting points — see the individual feature notes.
