#!/usr/bin/env bash
# Seed a throwaway "Tanaka-Lefèvre" demo household and run a server for it.
# Isolated from your real ~/.maurice data: its own data dir, gardens, config,
# corpus store and ports.
#
#   scripts/seed-demo-household.sh            # seed + start the server on :3004
#   scripts/seed-demo-household.sh --seed     # seed only
#   scripts/seed-demo-household.sh --archive  # seed, then export a household
#                                             # archive — what ops/household.sh
#                                             # add … --from takes to put the
#                                             # demo on a fleet host
#   scripts/seed-demo-household.sh --morning  # seed, start the corpus gateway
#                                             # and the server, index, map: the
#                                             # "morning of the proposal" at once
#                                             # instead of the night after
#
# The morning of the proposal (P4 of the domains' roadmap, 19 September 2026):
# the seed writes Théo's history (server/scripts/demo-conversations.ts, CC0,
# mostly marked as imported from ChatGPT). Left alone, the household's nights
# do the rest — the corpus reconciles at 03:00, the mapping runs at 05:00 —
# and Théo finds a conversation opened by Maurice in the morning, proposing
# three domains. `--morning` runs those two steps now. It needs Ollama with
# `qwen3-embedding:0.6b` for the corpus, and a key for the night's model
# (DeepSeek V4 Flash on Scaleway): MAURICE_DEMO_SCALEWAY_KEY and, for a
# project-scoped key, MAURICE_DEMO_SCALEWAY_PROJECT. One mapping costs about
# a cent, charged to the household's "system" spender.
set -euo pipefail
source "$(dirname "$0")/_lib.sh" 2>/dev/null || REPO="$(cd "$(dirname "$0")/.." && pwd)"

DATA="${MAURICE_DEMO_DIR:-/tmp/maurice-demo}"
# The demo household needs its OWN gardens root. Without this both the seed and
# the server fall back to the repo's web/gardens and write the fictional
# Tanaka-Lefèvre members into the developer's real garden tree.
GARDENS="${MAURICE_DEMO_GARDENS_DIR:-$DATA/gardens}"
PORT="${MAURICE_DEMO_PORT:-3004}"
GATEWAY_PORT="${MAURICE_DEMO_GATEWAY_PORT:-8711}"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
MODE="${1:-}"

# Never ~/.maurice, whatever the environment says.
case "$DATA" in *"/.maurice"|*"/.maurice/"*) echo "✗ MAURICE_DEMO_DIR must not be ~/.maurice"; exit 1 ;; esac

echo "→ Demo data dir:    $DATA  (wiping for a clean seed)"
echo "→ Demo gardens dir: $GARDENS"
rm -rf "$DATA"
mkdir -p "$DATA" "$GARDENS" "$DATA/life" "$DATA/corpus" "$DATA/vectors"

# Its own config: the server would otherwise read ~/.maurice/config.toml and
# take the household's ports and its data-api directory (life.db) for its own.
cat > "$DATA/config.toml" <<EOF
[general]
timezone = "Europe/Paris"

[paths]
data_dir = "$DATA/life"

[ports]
api = $PORT
mcp-gateway = $GATEWAY_PORT
EOF

# The environment every process of the demo runs with.
demo_env() {
  env MAURICE_DATA_DIR="$DATA" MAURICE_GARDENS_DIR="$GARDENS" MAURICE_CONFIG="$DATA/config.toml" \
      MAURICE_PORT_API="$PORT" MAURICE_PORT_MCP_GATEWAY="$GATEWAY_PORT" PORT="$PORT" \
      MAURICE_MCP_TOKEN="${MAURICE_DEMO_MCP_TOKEN:-demo-token}" "$@"
}

cd "$REPO/server"
echo "→ Seeding…"
demo_env "$BUN" run scripts/seed-demo.ts

if [[ "$MODE" == "--seed" ]]; then
  echo "→ Seed-only. Start later with:"
  echo "    cd server && MAURICE_DATA_DIR=$DATA MAURICE_GARDENS_DIR=$GARDENS MAURICE_CONFIG=$DATA/config.toml PORT=$PORT $BUN run index.ts"
  exit 0
fi

if [[ "$MODE" == "--archive" ]]; then
  DEST="${MAURICE_DEMO_ARCHIVE_DIR:-$DATA/archive}"
  mkdir -p "$DEST"
  echo "→ Exporting the household archive to ${DEST}…"
  demo_env "$BUN" run scripts/archive.ts export "$DEST"
  echo "→ On a fleet host:  ops/household.sh add <host> demo <domain> --from $DEST/<archive>"
  echo "   then put a Scaleway key on the household (console → providers) so the night can map,"
  echo "   and the morning after, Théo has his proposal. Or press Reconcile now and Map now in the console."
  exit 0
fi

if [[ "$MODE" == "--morning" ]]; then
  # The night's model needs a key on the household before the server starts:
  # the ancillary pins (DeepSeek V4 Flash for domain_mapping) are chosen at
  # start from the providers that have one.
  if [[ -n "${MAURICE_DEMO_SCALEWAY_KEY:-}" ]]; then
    sqlite3 "$DATA/maurice.db" "UPDATE households SET scaleway_api_key = '${MAURICE_DEMO_SCALEWAY_KEY}', scaleway_project_id = $( [[ -n "${MAURICE_DEMO_SCALEWAY_PROJECT:-}" ]] && printf "'%s'" "$MAURICE_DEMO_SCALEWAY_PROJECT" || printf NULL ) WHERE id = 'default'"
    echo "→ Scaleway key set on the demo household"
  else
    echo "⚠  No MAURICE_DEMO_SCALEWAY_KEY: the mapping will find no model to name the groups."
  fi

  # The corpus config: Ollama's Qwen 0.6B, a store of its own, the demo gardens.
  cat > "$DATA/corpus.yaml" <<EOF
store:
  backend: sqlite_vec
  path: $DATA/vectors
embedding:
  provider: ollama
  model: ${MAURICE_DEMO_EMBEDDING_MODEL:-qwen3-embedding:0.6b}
  base_url: ${MAURICE_DEMO_EMBEDDING_URL:-http://localhost:11434/v1}
  vector_size: 1024
  batch_size: 32
watcher:
  debounce_seconds: 2
  ignore_patterns: ["*.tmp", ".DS_Store"]
sources:
  garden-notes:
    path: $GARDENS
    pattern: "*/notes/*/*.md"
    recursive: true
    member_from_path: parent.parent.parent.name
    member_lookup: garden_username
    chunking: {method: semantic, max_tokens: 512, overlap_tokens: 50}
    metadata:
      source_type: note
      extract_from_frontmatter: true
      extract_from_path: {locale: parent.name, slug: stem}
EOF
  PY="$(find_python 2>/dev/null || true)"
  [[ -n "$PY" ]] || { echo "✗ no Python with the gateway deps (scripts/install_repo_env.sh)"; exit 1; }
  echo "→ Corpus gateway on :$GATEWAY_PORT"
  (cd "$REPO" && demo_env MAURICE_CORPUS_CONFIG="$DATA/corpus.yaml" MAURICE_CORPUS_DATA_DIR="$DATA/corpus" MAURICE_REPO="$REPO" \
      "$PY" tools/mcp_gateway/server.py --host 127.0.0.1 --port "$GATEWAY_PORT" --base-path /mcp --require-auth > "$DATA/gateway.log" 2>&1 &)
  echo "→ Server on :$PORT"
  (demo_env "$BUN" run index.ts > "$DATA/server.log" 2>&1 &)
  trap 'lsof -ti tcp:$PORT -ti tcp:$GATEWAY_PORT 2>/dev/null | xargs kill 2>/dev/null || true' EXIT
  for i in $(seq 1 30); do curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1 && break; sleep 1; done
  curl -sf "http://localhost:$PORT/healthz" >/dev/null || { echo "✗ server did not come up (see $DATA/server.log)"; exit 1; }

  TOKEN="$(curl -s -X POST "http://localhost:$PORT/api/auth/login" -H 'Content-Type: application/json' \
      -d '{"username":"hana","password":"demo-admin"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
  [[ -n "$TOKEN" ]] || { echo "✗ could not log in as hana"; exit 1; }
  echo "→ Reconciling the corpus (Théo's history into the index)…"
  curl -s -X POST "http://localhost:$PORT/api/admin/corpus/reconcile" -H "Authorization: Bearer $TOKEN" | head -c 300; echo
  echo "→ Mapping Théo's conversations (the night's step, now)…"
  curl -s -X POST "http://localhost:$PORT/api/admin/domains/map" -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/json' -d '{"username":"theo"}' | head -c 600; echo
  echo
  echo "→ The morning of the proposal: log in as Théo (PIN 1234) at http://localhost:$PORT"
  echo "   — a conversation opened by Maurice is waiting in his list. Ctrl-C stops the demo."
  while sleep 3600; do :; done
  exit 0
fi

echo "→ Starting demo server on http://localhost:$PORT  (Ctrl-C to stop)"
exec demo_env "$BUN" run index.ts
