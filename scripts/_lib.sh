#!/usr/bin/env bash
# Shared helpers for Maurice service scripts. Source this; don't run it.

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$HOME/.maurice/logs"
RUN_DIR="$HOME/.maurice/run"
export MAURICE_CONFIG="${MAURICE_CONFIG:-$HOME/.maurice/config.toml}"

mkdir -p "$LOG_DIR" "$RUN_DIR"

# Root of the member gardens, mirroring services/gardensRoot.ts so the shell and
# the server never disagree about where the manifest lives. Exported at source
# time, like MAURICE_CONFIG: every launch script sources this file, including the
# ones launchd runs, so one resolution reaches every service and every child.
#
# The machine's real answer belongs in .env, which is untracked. gardens.json
# names this household's members and ports and is therefore machine-specific,
# but the copy in the checkout is tracked (it ships a demo stub for new
# installs) — so while the live manifest lived there, every branch switch
# restored the stub and 404'd every garden. The repo fallback below is for a
# fresh dev checkout that has no gardens of its own.
_gardens_from_env_file() {
  [[ -f "$REPO/.env" ]] || return 0
  # `|| true` is load-bearing: grep exits 1 when the key is absent, and every
  # script here runs under `set -euo pipefail`, so the failing pipeline aborted
  # at source time — before any output, so the only symptom was a launch script
  # exiting 1 with nothing said. .env.example ships this line commented out, so
  # it hit every fresh install.
  local line value
  line="$(grep -E '^[[:space:]]*MAURICE_GARDENS_DIR=' "$REPO/.env" | tail -1 || true)"
  [[ -n "$line" ]] || return 0
  value="${line#*=}"
  value="${value%%#*}"                              # trailing comment
  value="${value#"${value%%[![:space:]]*}"}"        # leading space
  value="${value%"${value##*[![:space:]]}"}"        # trailing space
  value="${value#[\"\']}"; value="${value%[\"\']}"  # surrounding quotes
  # `source` would expand these; grep does not, and a literal "$HOME/..." was
  # passed verbatim to the astro child, which then matched nothing and rendered
  # every collection empty.
  value="${value/#\~/$HOME}"
  value="${value//\$\{HOME\}/$HOME}"
  value="${value//\$HOME/$HOME}"
  printf '%s' "$value"
}

if [[ -z "${MAURICE_GARDENS_DIR:-}" ]]; then
  MAURICE_GARDENS_DIR="$(_gardens_from_env_file)"
fi
# Only an explicit answer is exported. Falling back to a default and exporting it
# would beat config.toml's [paths] gardens_dir, which config_loader consults only
# after the environment — an install configured by TOML would silently move.
if [[ -n "${MAURICE_GARDENS_DIR:-}" ]]; then
  export MAURICE_GARDENS_DIR
  _MAURICE_GARDENS_RESOLVED="$MAURICE_GARDENS_DIR"
elif [[ -d "$REPO/web/gardens" ]]; then
  _MAURICE_GARDENS_RESOLVED="$REPO/web/gardens"
else
  _MAURICE_GARDENS_RESOLVED="$HOME/.maurice/gardens"
fi
gardens_root() { echo "$_MAURICE_GARDENS_RESOLVED"; }

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
