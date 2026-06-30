#!/usr/bin/env bash
# Stop Maurice services started by start-all.sh.
# Usage: scripts/stop-all.sh [api mcp-gateway web]
set -euo pipefail
source "$(dirname "$0")/_lib.sh"

declare -A PORTS=( [api]=3001 [mcp-gateway]=8710 [web]=4321 )

if [[ $# -gt 0 ]]; then SERVICES=("$@"); else SERVICES=(api mcp-gateway web); fi

for name in "${SERVICES[@]}"; do
  port="${PORTS[$name]:-}"
  [[ -n "$port" ]] || { echo "✗ unknown service: $name"; continue; }
  pid="$(port_pid "$port")"
  if [[ -n "$pid" ]]; then
    kill "$pid" 2>/dev/null && echo "✓ stopped $name (pid $pid, :$port)" \
      || echo "✗ could not kill $name (pid $pid)"
  else
    echo "• $name not running (:$port)"
  fi
  rm -f "$RUN_DIR/$name.pid"
done
