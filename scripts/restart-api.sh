#!/usr/bin/env bash
# Restart the Maurice API server (Bun/Hono, :3001): stop whatever holds the port,
# then start it fresh in the background with logging — so a restart is one command
# and doesn't tie up your terminal. Picks up the latest .env (e.g. CALIBRE_PYTHON).
#
#   scripts/restart-api.sh
#
# Logs: ~/.maurice/logs/api.log   PID: ~/.maurice/run/api.pid
set -euo pipefail
source "$(dirname "$0")/_lib.sh"

PORT=3001

# Stop whatever is listening on the port (usually `bun run index.ts`).
pid="$(port_pid "$PORT")"
if [[ -n "$pid" ]]; then
  echo "→ stopping API (pid $pid)…"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do [[ -z "$(port_pid "$PORT")" ]] && break; sleep 0.25; done
  if [[ -n "$(port_pid "$PORT")" ]]; then
    echo "  still up — forcing…"
    kill -9 "$(port_pid "$PORT")" 2>/dev/null || true
    sleep 1
  fi
else
  echo "→ nothing on :$PORT"
fi

# Start fresh in the background (same pattern as start-all.sh).
log="$LOG_DIR/api.log"
pidfile="$RUN_DIR/api.pid"
nohup "$REPO/scripts/start-api.sh" >>"$log" 2>&1 &
echo $! >"$pidfile"

if wait_for_port "$PORT" 20; then
  echo "✓ API up on :$PORT (pid $(cat "$pidfile"), log: $log)"
else
  echo "✗ API failed to bind :$PORT within 20s — see $log"
  tail -n 20 "$log" | sed 's/^/    /'
  exit 1
fi
