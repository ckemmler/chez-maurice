#!/usr/bin/env bash
# Cron-friendly wrapper that runs the thoughts ingestion pipeline once.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIPELINE_DIR="$REPO_ROOT/pipelines/thoughts_ingestion"
LOG_DIR="$REPO_ROOT/logs"
LOG_FILE="$LOG_DIR/thoughts_ingestion.cron.log"
mkdir -p "$LOG_DIR"
if [[ ! -d "$PIPELINE_DIR" ]]; then
  echo "[ERROR] Pipeline directory not found: $PIPELINE_DIR" >> "$LOG_FILE"
  exit 1
fi
PYTHON_BIN="$PIPELINE_DIR/.venv/bin/python3"
if [[ ! -x "$PYTHON_BIN" ]]; then
  PYTHON_BIN="python3"
fi

CONFIG_PATH="${THOUGHTS_CONFIG:-config/thoughts_inbox.yml}"

cd "$PIPELINE_DIR"
CMD=("$PYTHON_BIN" -m thoughts_ingestion.cli --config "$CONFIG_PATH")
timestamp() {
  date "+%Y-%m-%dT%H:%M:%S%z"
}

{
  echo "[$(timestamp)] Starting thoughts ingestion run"
  PYTHONPATH="$PIPELINE_DIR" "${CMD[@]}"
  echo "[$(timestamp)] Thoughts ingestion run completed"
} >> "$LOG_FILE" 2>&1
