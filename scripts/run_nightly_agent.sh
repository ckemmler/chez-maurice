#!/usr/bin/env bash
# Nightly autonomous agent — picks the highest-priority `ready` backlog item,
# extracts its ## Plan section, and runs Claude Code to execute it.
#
# Usage:  ./scripts/run_nightly_agent.sh [--dry-run]
#
# Not wired into cron yet — run manually to test.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTENT_DIR="$ROOT_DIR/akita-web/src/content/notes/en"
LOG_DIR="$ROOT_DIR/logs"
LOG_FILE="$LOG_DIR/nightly_agent.log"
DRY_RUN=false

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

mkdir -p "$LOG_DIR"

log() {
  local msg="[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $1"
  echo "$msg" | tee -a "$LOG_FILE"
}

log "=== Nightly agent run started ==="

# ── 1. Find the lowest-order `ready` item ──

BEST_FILE=""
BEST_ORDER=999999
BEST_SLUG=""

for file in "$CONTENT_DIR"/akita-backlog-*.md; do
  [ -f "$file" ] || continue
  slug="$(basename "$file" .md)"
  [ "$slug" = "akita-backlog" ] && continue

  frontmatter=$(sed -n '/^---$/,/^---$/p' "$file")
  status=$(echo "$frontmatter" | grep '^status:' | sed 's/^status: *//')

  if [ "$status" != "ready" ]; then
    continue
  fi

  order=$(echo "$frontmatter" | grep '^order:' | sed 's/^order: *//')
  order="${order:-999999}"

  if [ "$order" -lt "$BEST_ORDER" ]; then
    BEST_ORDER="$order"
    BEST_FILE="$file"
    BEST_SLUG="$slug"
  fi
done

if [ -z "$BEST_FILE" ]; then
  log "No items in 'ready' status. Nothing to do."
  exit 0
fi

log "Selected: $BEST_SLUG (order: $BEST_ORDER)"

# ── 2. Extract the ## Plan section ──

PLAN=$(awk '/^## Plan/{found=1; next} found && /^## /{exit} found{print}' "$BEST_FILE")

if [ -z "$PLAN" ]; then
  log "ERROR: No ## Plan section found in $BEST_SLUG. Cannot proceed."
  exit 1
fi

# Strip the plan fenced block markers if present
PLAN=$(echo "$PLAN" | sed '/^```plan$/d;/^```$/d')

log "Plan extracted ($(echo "$PLAN" | wc -l | tr -d ' ') lines)"

if $DRY_RUN; then
  log "DRY RUN — would execute the following plan for $BEST_SLUG:"
  echo "$PLAN"
  log "=== Dry run complete ==="
  exit 0
fi

# ── 3. Build the prompt ──

TITLE=$(sed -n '/^---$/,/^---$/p' "$BEST_FILE" | grep '^title:' | sed "s/^title: *//;s/^['\"]//;s/['\"]$//")

PROMPT="You are the Akita nightly agent. Execute the following task autonomously.

## Task: $TITLE
Backlog item: $BEST_SLUG

## Plan

$PLAN

## Instructions

- Work in the Akita monorepo at $ROOT_DIR
- Follow existing code conventions and patterns
- Run tests or verification steps described in the plan
- If you get stuck on a step, document what went wrong and move on
- Do NOT commit to git — leave changes unstaged for human review
- Do NOT modify akita-backlog.md (the MoC index) — the user manages wikilinks there manually
- When done, output a brief summary of what was accomplished and any issues encountered"

# ── 4. Update status to in_progress ──

sed -i '' "s/^status: ready$/status: in_progress/" "$BEST_FILE"
log "Status updated to in_progress"

# ── 5. Run Claude Code ──

log "Starting Claude Code execution..."

AGENT_OUTPUT=""
AGENT_EXIT=0

AGENT_OUTPUT=$(claude -p "$PROMPT" \
  --allowedTools "Bash,Read,Edit,Write,Glob,Grep" \
  --output-format text \
  2>&1) || AGENT_EXIT=$?

log "Claude Code exited with code $AGENT_EXIT"

# ── 6. Update status and append agent log ──

TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [ "$AGENT_EXIT" -eq 0 ]; then
  sed -i '' "s/^status: in_progress$/status: review/" "$BEST_FILE"
  log "Status updated to review"

  # Append agent log to the note
  cat >> "$BEST_FILE" <<EOF

## Agent Log

_Run: ${TIMESTAMP}_

\`\`\`
$(echo "$AGENT_OUTPUT" | tail -100)
\`\`\`
EOF
else
  log "Agent failed — keeping status as in_progress"

  cat >> "$BEST_FILE" <<EOF

## Agent Log (failed)

_Run: ${TIMESTAMP} — exit code ${AGENT_EXIT}_

\`\`\`
$(echo "$AGENT_OUTPUT" | tail -100)
\`\`\`
EOF
fi

# ── 7. Regenerate kanban ──

if [ -x "$SCRIPT_DIR/generate_kanban.sh" ]; then
  log "Regenerating kanban..."
  "$SCRIPT_DIR/generate_kanban.sh" > /dev/null 2>&1 || true
fi

log "=== Nightly agent run complete ==="
