#!/usr/bin/env bash
# Launch the corpus watcher + MCP server.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORPUS_DIR="$REPO_ROOT/tools/corpus"
LOG_DIR="$REPO_ROOT/logs"
LOG_FILE="$LOG_DIR/corpus_watcher.log"
mkdir -p "$LOG_DIR"
if [[ ! -d "$CORPUS_DIR" ]]; then
  echo "[$(date -Is)] [ERROR] Corpus directory not found: $CORPUS_DIR" >> "$LOG_FILE"
  exit 1
fi
if [[ -f "$CORPUS_DIR/.venv/bin/activate" ]]; then
  # shellcheck disable=SC1091
  source "$CORPUS_DIR/.venv/bin/activate"
elif [[ -f "$REPO_ROOT/.venv/bin/activate" ]]; then
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.venv/bin/activate"
fi
cd "$CORPUS_DIR"
exec python -m src.main serve >> "$LOG_FILE" 2>&1
