# Chez Maurice

A self-hosted **shared AI and memory for families and small groups**. Maurice runs
on a Mac you own — your conversations, notes and files stay on your hardware, and
each member of the household has their own private space plus the rooms you choose
to share.

> Maurice is *apprivoisé* — tamed, not omniscient. He knows only what you've shown
> him. His memory is plain Markdown in a git repo you control: visible, scoped, and
> shaped by deliberate action. Small on purpose.

- **Self-hosted** — one server on your Mac; no cloud account, no Docker.
- **Private by design** — per-member isolation; an admin can't read a member's 1:1s.
- **Your models** — local (Ollama) or cloud (Anthropic, OpenAI, Mistral), switchable per conversation.
- **Native apps** — SwiftUI for iPhone, iPad and Mac, plus a browsable web "garden".

---

## Requirements

- **[Bun](https://bun.sh)** ≥ 1.1 — runs the server.
- **Node.js** ≥ 20 + npm — builds the Astro web garden.
- **Python** ≥ 3.11 — runs the MCP tool gateway (optional; only for the Claude Desktop / Claude.ai connector).
- **macOS + Xcode 15+** — to build the apps (optional; you can use the web garden without them).
- **[Ollama](https://ollama.com)** (optional) — for local, no-cloud models.

At least one model is required: either Ollama running locally, or an API key for
Anthropic / OpenAI / Mistral (entered in the admin UI — never committed).

---

## Quick start

### 1. Run the server (the core)

```bash
cd server
bun install
```

Then run the services as macOS launchd agents — one command, and they start on
login and restart on crash. No process to babysit:

```bash
scripts/service.sh install        # API (:3001), MCP gateway (:8710), web (:4321)
scripts/service.sh status         # what's running
scripts/service.sh restart [api]  # restart all, or one service
scripts/service.sh logs api       # tail a service's log
```

(For a throwaway dev run without launchd, `cd server && bun run index.ts` still
works — it serves http://localhost:3001.)

If you use the Calibre reading features (chapter extraction / summaries), run
`scripts/setup-calibre-venv.sh` once — it builds a Python venv for the Calibre
CLI on an interpreter with a working `pyexpat` (Homebrew's python@3.14 ships a
broken one that crashes EPUB parsing). The server auto-detects it, no restart
needed.

On first launch it has no users. Open **http://localhost:3001/admin** in a browser
— you'll be redirected to a one-time **setup** page to create the admin account.
Then, from `/admin`, configure a model:

- **Local:** with Ollama running, your installed models are auto-detected.
- **Cloud:** paste an Anthropic / OpenAI / Mistral API key. Keys live in the local
  database only; they are never written to the repo.

That's enough to chat. To reach the server from phones/other machines, see
**Remote access** below.

### 2. Connect an app

Build the SwiftUI app from `app/` (open `app/Maurice.xcodeproj` in Xcode, run the
`Maurice_macOS` or `Maurice_iOS` scheme). On first launch it asks for a **server
address** — enter your server's URL (e.g. `http://localhost:3001` for a local Mac
run, or your TLS host for remote). Then pick your member and PIN.

### 3. (Optional) The web garden

The Astro site renders a member's Markdown garden as a website.

```bash
cd web
npm install
npm run dev               # http://localhost:4321  (serves the bundled `demo` garden)
# or: npm run build       # static build into web/dist
```

Select which garden to serve with the `GARDEN` env var (a folder under
`web/gardens/`); it defaults to the bundled `demo` garden.

### 4. (Optional) The MCP tool gateway

Exposes Maurice's garden tools to Claude Desktop / Claude.ai as an MCP connector.

```bash
scripts/install_repo_env.sh   # creates .venv and installs gateway deps
scripts/start-mcp-gateway.sh  # http://127.0.0.1:8710/mcp
```

The Maurice server proxies `/mcp` to the gateway, so the client connect URL is
`https://<your-host>/mcp`. For the Claude.ai OAuth consent flow, set
`MAURICE_OAUTH_PASSWORD` in `.env` (see `.env.example`).

---

## Configuration

Copy `.env.example` to `.env` (gitignored) and fill in what you need. Common vars:

| Variable | What it does |
|---|---|
| `PORT` | Server port (default `3001`). |
| `MAURICE_TLS_CERT` / `MAURICE_TLS_KEY` | Cert + key to serve HTTPS (e.g. `tailscale cert`, or Let's Encrypt). Without them the server runs plain HTTP on localhost. |
| `MAURICE_PUBLIC_HOST` | The host the apps reach the server on (default `localhost`). |
| `GARDEN` | Which garden the web engine serves (default `demo`). |
| `MAURICE_GARDENS_DIR` | Absolute gardens root in production (defaults to `web/gardens/` in dev). |
| `MAURICE_OAUTH_PASSWORD` | Enables OAuth on the MCP gateway for the Claude.ai connector. |

Model API keys are **not** environment variables — set them per-household in the
admin UI so they stay in the local database, out of the repo.

### Remote access

Phones and other machines need to reach the server over a real host with TLS. The
simplest path is **[Tailscale](https://tailscale.com)**: install it on the Mac,
run `tailscale cert <your-node>.ts.net` to get a cert + key, point
`MAURICE_TLS_CERT` / `MAURICE_TLS_KEY` at them, and pair the apps to
`https://<your-node>.ts.net:3001`. A Cloudflare Tunnel works too.

---

## Project structure

```
maurice/
  app/       # SwiftUI multiplatform app (iPhone, iPad, Mac)
  server/    # Bun + Hono server — chat engine, data API, garden git ops
  web/       # Astro site that renders a garden as a website
  tools/     # Python MCP tool gateway + the garden tool
  infra/     # macOS .pkg installer, launchd plists, CLI
  scripts/   # Setup + utility scripts
```

This is the **public** build: it ships the garden tool plus the gateway and shared
infrastructure. Additional private tools (calendar, contacts, etc.) live in a
separate repo and are overlaid at runtime; the code degrades gracefully when
they're absent.

---

## Philosophy

Maurice's defining limitation — he only knows what you hand him — isn't a bug, it's
the thing you can *tame*. You load notes, books, files and past conversations into a
conversation through the composer, watch the token budget fill, and nothing else is
in the room. Then you write back: anything worth keeping becomes a note in the wiki,
ready next time. The memory is yours, in plain Markdown, in a git repo you own.

Built for a household first — two kids, two adults — and open-sourced second.

---

## License

Chez Maurice is free software, licensed under the **GNU Affero General Public
License v3.0** — see [`LICENSE`](LICENSE).

The `LICENSE` file also carries an **additional permission** (AGPL v3 §7) from the
copyright holder allowing distribution through Apple's App Store and TestFlight.
That covers the open-source side; the apps installed from the App Store / TestFlight
are additionally governed by Apple's standard end-user license agreement (EULA), as
is normal for any App Store app.

Third-party assets (fonts, vendor marks) are noted in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
