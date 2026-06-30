#!/usr/bin/env bash
# Candide's garden engine (Astro) — port 4321, served under /g/candide on the
# private tunnel (his public candide.me build runs at root, no GARDEN_BASE).
set -euo pipefail
source "$(dirname "$0")/_lib.sh"

NPM="$(command -v npm)" || { echo "npm not found on PATH"; exit 1; }

cd "$REPO/web"
[[ -d node_modules ]] || { echo "→ installing web deps..."; "$NPM" install; }
echo "→ Garden 'candide' on http://localhost:4321/g/candide (cwd: $PWD)"
# WEB_SSR=1: render per request (output:server) so web themes switch live.
# THEME=candide: this garden defaults to the full-site (kind:site) theme — its
# home is the composed hero, not the garden-first notes index. (Falls back to the
# neutral default garden theme if the private candide theme isn't present.)
exec env GARDEN=candide GARDEN_BASE=/g/candide WEB_SSR=1 THEME=candide "$NPM" run dev
