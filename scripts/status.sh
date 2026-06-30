#!/usr/bin/env bash
# Show which Maurice services are listening.
set -euo pipefail
source "$(dirname "$0")/_lib.sh"

declare -A PORTS=( [api]=3001 [mcp-gateway]=8710 [web]=4321 )

printf "%-14s %-6s %-8s %s\n" SERVICE PORT PID STATE
for name in api mcp-gateway web; do
  port="${PORTS[$name]}"
  pid="$(port_pid "$port")"
  if [[ -n "$pid" ]]; then
    printf "%-14s %-6s %-8s %s\n" "$name" "$port" "$pid" "up"
  else
    printf "%-14s %-6s %-8s %s\n" "$name" "$port" "-" "down"
  fi
done
