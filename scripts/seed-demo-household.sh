#!/usr/bin/env bash
# Seed a throwaway "Tanaka-Lefèvre" demo household and run a server for it,
# for the landing-page screenshots. Isolated from your real ~/.maurice data.
#
#   scripts/seed-demo-household.sh           # seed + start on :3004
#   scripts/seed-demo-household.sh --seed     # seed only
set -euo pipefail
source "$(dirname "$0")/_lib.sh" 2>/dev/null || REPO="$(cd "$(dirname "$0")/.." && pwd)"

DATA="${MAURICE_DEMO_DIR:-/tmp/maurice-demo}"
PORT="${MAURICE_DEMO_PORT:-3004}"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"

echo "→ Demo data dir: $DATA  (wiping for a clean seed)"
rm -rf "$DATA"
mkdir -p "$DATA"

cd "$REPO/server"
echo "→ Seeding…"
MAURICE_DATA_DIR="$DATA" "$BUN" run scripts/seed-demo.ts

if [[ "${1:-}" == "--seed" ]]; then
  echo "→ Seed-only. Start later with:"
  echo "    cd server && MAURICE_DATA_DIR=$DATA PORT=$PORT $BUN run index.ts"
  exit 0
fi

echo "→ Starting demo server on http://localhost:$PORT  (Ctrl-C to stop)"
exec env MAURICE_DATA_DIR="$DATA" PORT="$PORT" "$BUN" run index.ts
