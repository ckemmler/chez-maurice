#!/usr/bin/env bash
# Maurice MCP gateway (Python/Starlette) — port 8710, base path /mcp.
# The Maurice server proxies /mcp and the OAuth routes here verbatim, so the
# client connect URL is https://host/mcp. Base path /mcp (not /) lets OAuth
# actually protect the MCP endpoint — the gateway treats bare / as an open
# index, so the endpoint must live at a non-root path.
set -euo pipefail
source "$(dirname "$0")/_lib.sh"
load_env

PY="$(find_python)" || {
  echo "No Python with the gateway deps (mcp, starlette, uvicorn, httpx)."
  echo "Create the repo venv first:  scripts/install_repo_env.sh"
  echo "Or point MAURICE_PYTHON at an interpreter that has them."
  exit 1
}

# OAuth mode (needed for the Claude.ai consent flow) requires one of these.
# Without it the gateway would refuse to start with --require-auth, so we
# fall back to running unauthenticated (fine for the local API-proxied path).
AUTH_ARGS=()
if [[ -n "${MAURICE_OAUTH_PASSWORD:-${MAURICE_MCP_TOKEN:-${AKITA_OAUTH_PASSWORD:-${AKITA_MCP_TOKEN:-}}}}" ]]; then
  AUTH_ARGS=(--require-auth)
else
  echo "⚠  No MAURICE_OAUTH_PASSWORD / MAURICE_MCP_TOKEN set — starting WITHOUT auth."
  echo "   Claude.ai OAuth consent needs MAURICE_OAUTH_PASSWORD in $REPO/.env."
fi

cd "$REPO"
echo "→ MCP gateway on http://127.0.0.1:8710/mcp (python: $PY)"
exec "$PY" tools/mcp_gateway/server.py \
  --host 127.0.0.1 --port 8710 --base-path /mcp "${AUTH_ARGS[@]}" "$@"
