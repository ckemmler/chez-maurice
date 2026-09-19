#!/usr/bin/env bash
# Restore a household archive into a FRESH data dir — see docs/household-archive.md.
#
#   scripts/import-household.sh <archive> [data-dir]     default: ~/.maurice
#
# Fresh means no maurice.db there yet: the import refuses otherwise, so it
# can never land on top of a household that exists. It extracts, checks
# every database, and repoints config.toml's data_dir at <data-dir>/data.
# Then start the server on it — its own migrations bring the schema forward
# on first boot. The gardens land in <data-dir>/gardens: point
# MAURICE_GARDENS_DIR there (in .env) unless that is already the answer.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

ARCHIVE="${1:?usage: import-household.sh <archive> [data-dir]}"
INTO="${2:-$HOME/.maurice}"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"

cd "$REPO/server"
"$BUN" run scripts/archive.ts import "$ARCHIVE" "$INTO"

if [[ "$(gardens_root)" != "$INTO/gardens" ]]; then
  echo
  echo "  The gardens are in $INTO/gardens, but this checkout resolves them to"
  echo "  $(gardens_root) — set MAURICE_GARDENS_DIR=$INTO/gardens in $REPO/.env."
fi
