#!/usr/bin/env bash
# Maurice API server (Bun/Hono) — port 3001.
set -euo pipefail
source "$(dirname "$0")/_lib.sh"

BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
[[ -x "$BUN" ]] || { echo "bun not found (looked on PATH and ~/.bun/bin)"; exit 1; }

# index.ts loads ../.env itself, so cd into server/ first.
cd "$REPO/server"
echo "→ API server on :3001 (cwd: $PWD)"
exec "$BUN" run index.ts
