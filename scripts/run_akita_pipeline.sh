#!/usr/bin/env bash
# Cron-friendly wrapper to run the Akita v2 pipeline:
#   1. Process new Calibre books
#   2. Scan content repo git log for signals
#   3. Generate daily briefings for all active topics
#   4. Run any due scheduled signal reports
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Load environment variables for cron (which has minimal env)
# Temporarily disable nounset — .env values may contain unquoted $ characters
if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a +u
  source "$REPO_ROOT/.env"
  set +a -u
fi

LOG_DIR="$REPO_ROOT/logs"
LOG_FILE="$LOG_DIR/akita_pipeline.log"
mkdir -p "$LOG_DIR"

VENV_DIR="$REPO_ROOT/tools/pipelines/research_tracks/.venv"
CLI_BIN="$VENV_DIR/bin/akita"
if [[ ! -x "$CLI_BIN" ]]; then
  CLI_BIN="akita"
fi

cd "$REPO_ROOT"

timestamp() { date "+%Y-%m-%dT%H:%M:%S%z"; }
log_step() { echo "[$(timestamp)] [$1] $2" >> "$LOG_FILE"; }

set +e

# Step 1: Process new Calibre books (extract chapters + summarize)
log_step calibre START
if ! "$REPO_ROOT/scripts/run_calibre_pipeline.sh"; then
  log_step calibre FAIL
fi
log_step calibre DONE

# Step 2: Scan content repo git log for signals
PYTHON_BIN="$VENV_DIR/bin/python"
if [[ ! -x "$PYTHON_BIN" ]]; then
  PYTHON_BIN="python3"
fi
log_step git-signals START
if ! "$PYTHON_BIN" -m tools.signals.git_scanner; then
  log_step git-signals FAIL
fi
log_step git-signals DONE

# Step 2b: Coaching adherence fiche for yesterday
log_step adherence START
if ! "$PYTHON_BIN" -m tools.signals.adherence; then
  log_step adherence FAIL
fi
log_step adherence DONE

# Step 3: Generate briefings for all active topics
log_step briefing START
if ! "$CLI_BIN" briefing generate --all; then
  log_step briefing FAIL
fi
log_step briefing DONE

# Step 4: Run any due scheduled jobs (signal reports)
log_step schedule START
if ! "$CLI_BIN" schedule run; then
  log_step schedule FAIL
fi
log_step schedule DONE

set -e
