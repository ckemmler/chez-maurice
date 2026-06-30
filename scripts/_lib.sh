#!/usr/bin/env bash
# Shared helpers for Maurice service scripts. Source this; don't run it.

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$HOME/.maurice/logs"
RUN_DIR="$HOME/.maurice/run"
export MAURICE_CONFIG="${MAURICE_CONFIG:-$HOME/.maurice/config.toml}"

mkdir -p "$LOG_DIR" "$RUN_DIR"

# Load repo-root .env into the environment (KEY=VALUE lines).
load_env() {
  if [[ -f "$REPO/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$REPO/.env"
    set +a
  fi
}

# Resolve a Python interpreter that has the gateway's deps, in priority order.
# Echoes the path, or returns 1 if none found. Override with MAURICE_PYTHON.
find_python() {
  local candidates=(
    "${MAURICE_PYTHON:-}"
    "$REPO/.venv/bin/python"
    "/opt/homebrew/bin/python3.13"
    "$(command -v python3 || true)"
  )
  for py in "${candidates[@]}"; do
    [[ -n "$py" && -x "$py" ]] || continue
    if "$py" -c "import mcp, starlette, uvicorn, httpx" >/dev/null 2>&1; then
      echo "$py"
      return 0
    fi
  done
  return 1
}

# PID listening on a TCP port, or empty.
# Must always return 0 — callers use `pid=$(port_pid ...)` under `set -e`,
# and an empty result (port free) would otherwise abort the script via pipefail.
port_pid() {
  { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true; } | head -1
}

# Wait up to N seconds for a port to start listening.
wait_for_port() {
  local port="$1" timeout="${2:-15}" i=0
  while (( i < timeout )); do
    [[ -n "$(port_pid "$port")" ]] && return 0
    sleep 1; ((i++))
  done
  return 1
}
