#!/usr/bin/env bash
# Export this machine's household as one archive — see docs/household-archive.md.
#
#   scripts/export-household.sh [dest-dir]      default: ~/.maurice/backups/archive
#
# Runs where the server's data is local: the Mac, or a shell inside the
# container (`scripts/container.sh shell`). It reads the databases the way
# scripts/backup-db.sh does — consistent snapshots over a read-only handle,
# never the live files — so the server keeps serving meanwhile. The result
# is <household>-<stamp>.maurice.tar.gz, which holds the API keys with
# everything else: keep it as you would a password.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

DEST="${1:-$HOME/.maurice/backups/archive}"
mkdir -p "$DEST"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"

# _lib.sh has already exported MAURICE_CONFIG and, from .env, MAURICE_GARDENS_DIR
# — the same answers the server runs with, so the archive reads the same dirs.
cd "$REPO/server"
exec "$BUN" run scripts/archive.ts export "$DEST"
