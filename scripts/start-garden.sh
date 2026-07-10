#!/usr/bin/env bash
# Start one member's garden engine instance (the shared engine, scoped to a
# member's notes + base + cache). Self-backgrounding.
# Usage: scripts/start-garden.sh <member>
#   Member, port and base come from web/gardens/gardens.json.
#   Candide is the default web service (scripts/start-web.sh) — use that for him.
set -euo pipefail
source "$(dirname "$0")/_lib.sh"

member="${1:?usage: start-garden.sh <member>}"
manifest="$REPO/web/gardens/gardens.json"
[[ -f "$manifest" ]] || { echo "missing $manifest"; exit 1; }

NODE="$(command -v node || echo "$HOME/.bun/bin/bun")"
read -r port base < <("$NODE" -e "const g=require('$manifest')['$member']; if(!g){process.exit(1)} console.log((g.port||'')+' '+(g.base||''))") \
  || { echo "✗ unknown garden: $member (not in gardens.json)"; exit 1; }

existing="$(port_pid "$port")"
if [[ -n "$existing" ]]; then
  echo "• garden '$member' already running on :$port (pid $existing)"
  exit 0
fi

log="$LOG_DIR/garden-$member.log"
pidfile="$RUN_DIR/garden-$member.pid"

# Each instance needs its own project root: Astro keys the dev content store to
# the root (<root>/.astro), and instances sharing one root cross-contaminate
# each other's content. Build a per-member root that symlinks the shared engine
# (src, config, node_modules, gardens, …) but owns its .astro. Candide runs from
# web/ directly, so his store is already isolated from members'.
shell="$REPO/web/.garden-roots/$member"
mkdir -p "$shell"
for entry in "$REPO/web/"*; do
  ln -sfn "$entry" "$shell/$(basename "$entry")"
done

cd "$shell"
echo "→ Garden '$member' on :$port (base: ${base:-/}, root: .garden-roots/$member)"
# Host handling: the engine accepts any Host by default (it only ever serves
# through the authenticated Bun proxy) — see web/astro.config.mjs. Export
# ALLOWED_HOSTS to pin an explicit allowlist if you expose this port directly.
nohup env GARDEN="$member" GARDEN_BASE="$base" GARDEN_SHELL=1 WEB_SSR=1 \
  ./node_modules/.bin/astro dev --port "$port" --host 0.0.0.0 >>"$log" 2>&1 &
echo $! >"$pidfile"

if wait_for_port "$port" 30; then
  echo "✓ garden '$member' up on :$port (pid $(cat "$pidfile"), log: $log)"
else
  echo "✗ garden '$member' failed to bind :$port within 30s — see $log"
  tail -n 12 "$log" | sed 's/^/    /'
  exit 1
fi
