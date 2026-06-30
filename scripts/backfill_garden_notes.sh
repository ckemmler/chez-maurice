#!/usr/bin/env bash
# One-shot: embed all existing garden notes into the per-member corpus vector DBs.
# Idempotent (unchanged notes are skipped). Pass --dry-run to preview the plan.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORPUS_DIR="$REPO_ROOT/tools/corpus"
SCRIPT="$CORPUS_DIR/scripts/backfill_garden_notes.py"

if [[ ! -f "$SCRIPT" ]]; then
  echo "error: corpus backfill script not found at $SCRIPT" >&2
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
# PYTHONPATH=repo root so `tools.shared.context` resolves (the corpus dir is a
# symlink, which breaks the package's own parents[3] root guess).
exec env PYTHONPATH="$REPO_ROOT" python "$SCRIPT" "$@"
