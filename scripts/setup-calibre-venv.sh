#!/usr/bin/env bash
# Create a dedicated Python venv for the Calibre CLI (chapter extraction and
# summaries) on a Python whose `pyexpat` actually loads.
#
# Why: Homebrew's python@3.14 ships a `pyexpat` linked against a newer libexpat
# than macOS provides, so `import xml.parsers.expat` fails with a missing-symbol
# error and `epubsplit` crashes the moment it parses an EPUB. Python 3.13/3.12/
# 3.11 are fine. The API server auto-detects this venv (see
# server/data-api/routes/calibre/actions.ts) — no env var needed.
#
# Idempotent: re-running recreates the venv. Restart the API afterwards
# (scripts/restart-api.sh).
set -euo pipefail
source "$(dirname "$0")/_lib.sh"

VENV="$REPO/.venv-calibre"

# First Python that exists and whose pyexpat loads. Override with CALIBRE_SETUP_PYTHON.
pick_python() {
  local candidates=(
    "${CALIBRE_SETUP_PYTHON:-}"
    /opt/homebrew/bin/python3.13
    /opt/homebrew/bin/python3.12
    /opt/homebrew/bin/python3.11
    "$(command -v python3.13 || true)"
    "$(command -v python3.12 || true)"
    "$(command -v python3 || true)"
  )
  for py in "${candidates[@]}"; do
    [[ -n "$py" && -x "$py" ]] || continue
    if "$py" -c "import xml.parsers.expat" >/dev/null 2>&1; then echo "$py"; return 0; fi
  done
  return 1
}

PY="$(pick_python)" || {
  echo "✗ No Python with a working pyexpat found (tried 3.13/3.12/3.11)."
  echo "  Install one, e.g.: brew install python@3.13"
  exit 1
}
echo "→ Using $("$PY" --version 2>&1) at $PY"

rm -rf "$VENV"
"$PY" -m venv "$VENV"
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q -e "$REPO/tools/calibre"

"$VENV/bin/python" - <<'PYCHECK'
import xml.parsers.expat, bs4, html5lib, six  # noqa: F401
print("✓ calibre venv OK (pyexpat + deps import cleanly)")
PYCHECK

echo "✓ Created $VENV"
echo "  The API server picks this up automatically. Restart it: scripts/restart-api.sh"
