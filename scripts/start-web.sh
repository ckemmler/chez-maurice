#!/usr/bin/env bash
# The garden engine: ONE built node server for the whole household.
#
# Every member's garden is served by this one process. Which member a request
# is for comes from a header the Bun proxy sets (X-Maurice-Garden), not from
# the environment — see web/src/lib/garden-context.ts. Until September 2026
# this was one `astro dev` per member, ~300 MB apiece; the household's four
# now share ~130 MB.
#
# GARDEN names only the fallback: whose garden answers a request that carries
# no member at all (a direct hit on the port, bypassing the proxy).
set -euo pipefail
source "$(dirname "$0")/_lib.sh"
NPM="$(command -v npm)" || { echo "npm not found on PATH"; exit 1; }
NODE="$(command -v node)" || { echo "node not found on PATH"; exit 1; }

GARDEN_NAME="${MAURICE_DEFAULT_GARDEN:-candide}"
PORT="${MAURICE_PORT_WEB:-4321}"
cd "$REPO/web"

[[ -d node_modules ]] || { echo "→ installing web deps..."; "$NPM" install; }

# Build if there is nothing to run, or if a source file is newer than the
# build. Deploys should build ahead of time (scripts/deploy.sh, the image);
# this is the safety net that keeps a fresh checkout from serving nothing.
needs_build=0
if [[ ! -f dist/server/entry.mjs ]]; then
  needs_build=1
elif [[ -n "$(find src themes astro.config.mjs package.json -newer dist/server/entry.mjs -print -quit 2>/dev/null)" ]]; then
  echo "→ engine is older than its sources, rebuilding"
  needs_build=1
fi
if (( needs_build )); then
  echo "→ building the garden engine…"
  WEB_SSR=1 "$NPM" run build >/dev/null
fi

echo "→ Garden engine on http://localhost:$PORT (household: default '$GARDEN_NAME', cwd: $PWD)"
# THEME is the household's default look; a reader's ?theme= / cookie wins per
# request. Host handling: the engine accepts any Host (it only ever serves
# through the authenticated Bun proxy) — see web/astro.config.mjs.
exec env GARDEN="$GARDEN_NAME" WEB_SSR=1 HOST=127.0.0.1 PORT="$PORT" \
  THEME="${MAURICE_DEFAULT_THEME:-$GARDEN_NAME}" "$NODE" ./dist/server/entry.mjs
