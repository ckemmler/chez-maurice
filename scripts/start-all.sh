#!/usr/bin/env bash
# Start all Maurice services in the background, logging to ~/.maurice/logs.
# Usage: scripts/start-all.sh [api mcp-gateway web]
#   With no args: api, mcp-gateway, web (Candide's garden), then every other
#   member's garden from web/gardens/gardens.json.
set -euo pipefail
source "$(dirname "$0")/_lib.sh"

# service name -> "port:script"
declare -A SVC=(
  [api]="3001:start-api.sh"
  [mcp-gateway]="8710:start-mcp-gateway.sh"
  [web]="4321:start-web.sh"
)

if [[ $# -gt 0 ]]; then SERVICES=("$@"); else SERVICES=(api mcp-gateway web); fi

start_one() {
  local name="$1" spec="${SVC[$1]:-}"
  [[ -n "$spec" ]] || { echo "✗ unknown service: $name"; return 1; }
  local port="${spec%%:*}" script="${spec##*:}"

  local existing; existing="$(port_pid "$port")"
  if [[ -n "$existing" ]]; then
    echo "• $name already running on :$port (pid $existing) — skipping"
    return 0
  fi

  local log="$LOG_DIR/$name.log" pidfile="$RUN_DIR/$name.pid"
  nohup "$REPO/scripts/$script" >>"$log" 2>&1 &
  echo $! >"$pidfile"
  if wait_for_port "$port" 20; then
    echo "✓ $name up on :$port (pid $(cat "$pidfile"), log: $log)"
  else
    echo "✗ $name failed to bind :$port within 20s — see $log"
    tail -n 15 "$log" | sed 's/^/    /'
    return 1
  fi
}

echo "Starting: ${SERVICES[*]}"
rc=0
for s in "${SERVICES[@]}"; do start_one "$s" || rc=1; done

# Member gardens (from web/gardens/gardens.json). Candide is the 'web' service
# above; every other member with a /g/ base gets its own engine instance, so a
# plain start-all brings the whole household online. start-garden.sh is
# idempotent (skips ones already running).
if [[ $# -eq 0 ]]; then
  NODE="$(command -v node || echo "$HOME/.bun/bin/bun")"
  members="$("$NODE" -e "const g=require('$REPO/web/gardens/gardens.json'); console.log(Object.entries(g).filter(([m,c])=>m!=='candide'&&(c.base||'').startsWith('/g/')).map(([m])=>m).join(' '))" 2>/dev/null || true)"
  for m in $members; do
    "$REPO/scripts/start-garden.sh" "$m" || rc=1
  done
fi
exit $rc
