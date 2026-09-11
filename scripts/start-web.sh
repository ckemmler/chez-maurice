#!/usr/bin/env bash
# The default garden engine (Astro) — port 4321, served under /g/<member>.
# On the home Mac that member is Candide, on the private tunnel (his public
# candide.me build runs at root, no GARDEN_BASE); elsewhere it is whoever
# MAURICE_DEFAULT_GARDEN names. Every other member gets their own instance from
# scripts/start-garden.sh.
set -euo pipefail
source "$(dirname "$0")/_lib.sh"

NPM="$(command -v npm)" || { echo "npm not found on PATH"; exit 1; }

# Which garden this default instance serves. `candide` on the home Mac, where
# nothing sets it; a deployed instance sets MAURICE_DEFAULT_GARDEN, because a
# server that hardcodes one person's username serves nothing on anyone else's
# machine. Every OTHER member gets their own instance on their own port
# (start-garden.sh), so this is only about which one lives at 4321.
GARDEN_NAME="${MAURICE_DEFAULT_GARDEN:-candide}"

cd "$REPO/web"
[[ -d node_modules ]] || { echo "→ installing web deps..."; "$NPM" install; }
echo "→ Garden '$GARDEN_NAME' on http://localhost:4321/g/$GARDEN_NAME (cwd: $PWD)"
# WEB_SSR=1: render per request (output:server) so web themes switch live.
# THEME: this garden defaults to the full-site (kind:site) theme — its
# home is the composed hero, not the garden-first notes index. (Falls back to the
# neutral default garden theme if the private candide theme isn't present.)
# Host handling: the engine accepts any Host by default (it only ever serves
# through the authenticated Bun proxy) — see web/astro.config.mjs. Export
# ALLOWED_HOSTS to pin an explicit allowlist if you expose this port directly.
exec env GARDEN="$GARDEN_NAME" GARDEN_BASE="/g/$GARDEN_NAME" WEB_SSR=1 \
  THEME="${MAURICE_DEFAULT_THEME:-$GARDEN_NAME}" "$NPM" run dev
