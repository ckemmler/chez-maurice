#!/usr/bin/env bash
# Start every member garden engine except the default one, which
# scripts/start-web.sh already serves on 4321 (MAURICE_DEFAULT_GARDEN).
#
# Lifted from the tail of scripts/start-all.sh — supervisord owns the three core
# services, so this is the only piece of it the container still needs. It also
# skips manifest entries with no port, which start-all.sh does not: the bundled
# `demo` garden has none, so it was tried and failed after 30s on every start,
# on both installs.
set -euo pipefail
source /app/scripts/_lib.sh

manifest="$(gardens_root)/gardens.json"
if [[ ! -f "$manifest" ]]; then
  echo "[gardens] no $manifest — nothing to start"
  exit 0
fi

DEFAULT_GARDEN="${MAURICE_DEFAULT_GARDEN:-candide}"
members="$(node -e "
  const g = require('$manifest');
  console.log(Object.entries(g)
    .filter(([m, c]) => m !== '$DEFAULT_GARDEN' && (c.base || '').startsWith('/g/') && c.port)
    .map(([m]) => m).join(' '))
" 2>/dev/null || true)"

if [[ -z "${members// /}" ]]; then
  echo "[gardens] no member gardens to start"
  exit 0
fi

rc=0
for m in $members; do
  /app/scripts/start-garden.sh "$m" || rc=1
done
exit $rc
