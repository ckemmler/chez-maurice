# Maurice service scripts

Local dev helpers for running the Maurice stack. Ports come from
`~/.maurice/config.toml` (defaults shown below).

| Service       | Port | Script                  | Notes                                   |
|---------------|------|-------------------------|-----------------------------------------|
| `api`         | 3001 | `start-api.sh`          | Bun/Hono server (`server/index.ts`)     |
| `mcp-gateway` | 8710 | `start-mcp-gateway.sh`  | Python/Starlette, base path `/akita`    |
| `web`         | 4321 | `start-web.sh`          | Astro frontend (`web/`)                 |
| `qdrant`      | 6333 | `start-qdrant.sh`       | Optional — corpus semantic search only  |

## Quick start

```bash
./scripts/start-all.sh          # api + mcp-gateway + web (background)
./scripts/status.sh             # what's listening
./scripts/stop-all.sh           # stop everything (by port)
```

Run one service in the foreground (its own terminal):

```bash
./scripts/start-api.sh
```

Start a specific subset:

```bash
./scripts/start-all.sh api web
./scripts/start-all.sh qdrant   # opt-in; not started by default
```

Logs go to `~/.maurice/logs/<service>.log`; pidfiles to `~/.maurice/run/`.

## Prerequisites

- **Python env for the gateway**: the MCP gateway needs an interpreter with
  `mcp`, `starlette`, `uvicorn`, `httpx` (plus the per-tool deps). Create it once:

  ```bash
  ./scripts/install_repo_env.sh    # builds .venv/ at the repo root
  ```

  `start-mcp-gateway.sh` then finds it automatically. Resolution order:
  `$MAURICE_PYTHON` → `.venv/` → `/opt/homebrew/bin/python3.13` → `python3`.

- **Node / Bun**: `web` uses `npm` (installs deps on first run); `api` uses `bun`.

- **Qdrant** must be installed separately (Homebrew or `/usr/local/lib/maurice/bin`).

## Notes

- Each script loads the repo-root `.env`. The API loads it itself.
- **Claude.ai OAuth**: the gateway only enables OAuth (`--require-auth`) when
  `MAURICE_OAUTH_PASSWORD` (or `MAURICE_MCP_TOKEN`) is set in `.env`. Without it
  the gateway still starts, unauthenticated — fine for the local API-proxied
  path, but the Claude.ai consent flow won't work.
- `start-all.sh` **skips ports that are already bound**. If a stale gateway from
  another workspace is on `:8710`, run `stop-all.sh` first to free the ports.
- `web/` is a symlink into iCloud Drive; if its contents are evicted, the first
  start may need a moment to download.
