#!/usr/bin/env bash
# Process new Calibre books: extract chapters + summarize.
# Uses a state file to only process books added since the last run.
# New summary files are auto-indexed by the always-on corpus watcher.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Load environment variables (NEBIUS_API_KEY etc.)
# Temporarily disable nounset — .env values may contain unquoted $ characters
if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a +u
  source "$REPO_ROOT/.env"
  set +a -u
fi

LOG_DIR="$REPO_ROOT/logs"
LOG_FILE="$LOG_DIR/calibre_pipeline.log"
mkdir -p "$LOG_DIR"

CALIBRE_DIR="$REPO_ROOT/tools/calibre"
STATE_FILE="$CALIBRE_DIR/data/last_auto_run.txt"
PYTHON="$CALIBRE_DIR/.venv/bin/python"
if [[ ! -x "$PYTHON" ]]; then
  PYTHON="$REPO_ROOT/.venv/bin/python"
fi
if [[ ! -x "$PYTHON" ]]; then
  PYTHON="python3"
fi

timestamp() { date "+%Y-%m-%dT%H:%M:%S%z"; }

echo "[$(timestamp)] Calibre pipeline starting" >> "$LOG_FILE"

cd "$CALIBRE_DIR"
"$PYTHON" batch_summarize.py --state-file "$STATE_FILE" >> "$LOG_FILE" 2>&1
EXIT_CODE=$?

echo "[$(timestamp)] Calibre pipeline finished (exit=$EXIT_CODE)" >> "$LOG_FILE"
exit $EXIT_CODE
