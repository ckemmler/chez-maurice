#!/usr/bin/env bash
# Calibre-Web — the library, in a browser. Port 8083, loopback only.
#
# This is what gives a hosted household a *real* Calibre: upload, metadata
# editing, shelves, OPDS, the built-in reader. Maurice reads the same library
# from the other side; nothing here is Maurice-specific except who is allowed
# in.
#
# It binds 127.0.0.1 like the MCP gateway and the Astro instances, and is
# reached through the Bun server's /calibre proxy — which is where
# authentication happens. Do not publish this port.
#
# Three things happen before it starts, in this order, because each needs the
# one before it:
#
#   1. a library to open      — Calibre-Web does not create one, it redirects
#                               to /admin/dbconfig and waits
#   2. app.db to exist        — Calibre-Web writes it itself on first start, so
#                               a first run is started and stopped for it
#   3. members and settings   — reconciled into app.db on every start, so a new
#                               member does not meet a login form
set -euo pipefail
source "$(dirname "$0")/_lib.sh"
load_env

PORT="${MAURICE_PORT_CALIBRE_WEB:-8083}"
DATA_DIR="${MAURICE_DATA_DIR:-$HOME/.maurice/data}"
CW_DIR="${MAURICE_CALIBRE_WEB_DIR:-$DATA_DIR/calibre/web}"
APP_DB="$CW_DIR/app.db"

# Look where it actually is before trusting PATH: launchd starts this with a
# bare environment, so the repo venv is not on it, and `command -v cps` finds
# nothing on a machine where Calibre-Web is correctly installed. Same order
# find_python uses, and for the same reason.
find_cps() {
  local candidates=(
    "${MAURICE_CALIBRE_WEB_BIN:-}"
    "$REPO/.venv/bin/cps"
    "/opt/venv/bin/cps"
    "$(command -v cps || true)"
  )
  for c in "${candidates[@]}"; do
    [[ -n "$c" && -x "$c" ]] && { echo "$c"; return 0; }
  done
  return 1
}

CPS="$(find_cps || true)"
if [[ -z "$CPS" ]]; then
  echo "✗ Calibre-Web (cps) not found."
  echo "  Install it into the repo venv:  .venv/bin/pip install calibreweb"
  echo "  Or point MAURICE_CALIBRE_WEB_BIN at the binary."
  exit 1
fi

mkdir -p "$CW_DIR"

# 1 — the library
bun run "$REPO/server/scripts/ensure-calibre-library.ts"

# 2 — app.db, which only Calibre-Web knows how to create. Start it, wait for the
# file, stop it. Bounded: if it never appears, say so rather than hang a service
# that supervisord or launchd will restart forever.
if [[ ! -f "$APP_DB" ]]; then
  echo "→ first start: letting Calibre-Web create $APP_DB"
  CALIBRE_DBPATH="$CW_DIR" "$CPS" -p "$APP_DB" -i 127.0.0.1 >/dev/null 2>&1 &
  seed_pid=$!
  for _ in $(seq 1 60); do
    [[ -f "$APP_DB" ]] && break
    sleep 1
  done
  kill "$seed_pid" 2>/dev/null || true
  wait "$seed_pid" 2>/dev/null || true
  if [[ ! -f "$APP_DB" ]]; then
    echo "✗ Calibre-Web did not create $APP_DB within 60s — not starting."
    exit 1
  fi
fi

# 3 — members and settings, every start
bun run "$REPO/server/scripts/configure-calibre-web.ts" "$APP_DB"

cd "$REPO"
echo "→ Calibre-Web on http://127.0.0.1:$PORT (proxied at /calibre)"
# The port is not a command-line option — Calibre-Web reads it from app.db,
# which step 3 has just set. `-s` is "set this user's password", not a port.
exec env CALIBRE_DBPATH="$CW_DIR" "$CPS" -p "$APP_DB" -i 127.0.0.1 "$@"
