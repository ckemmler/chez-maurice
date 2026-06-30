#!/usr/bin/env bash
# Bootstrap a single repo-wide Python virtual environment.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV_DIR="$ROOT/.venv"

if [[ ! -d "$VENV_DIR" ]]; then
  echo "[setup] Creating repo venv at $VENV_DIR"
  python3 -m venv "$VENV_DIR"
fi

source "$VENV_DIR/bin/activate"
python3 -m pip install --upgrade pip

echo "[setup] Installing MCP gateway deps"
pip install -r "$ROOT/tools/mcp_gateway/requirements.txt"

# Deps for sub-tools that ship no pyproject.toml but are imported at gateway start.
echo "[setup] Installing gateway sub-tool deps"
pip install -r "$ROOT/tools/mcp_gateway/requirements-tools.txt"

# The MCP gateway imports every sub-tool server at startup, so install every
# tool that ships a pyproject.toml (editable). Discover them rather than
# hardcoding, so new tools are picked up automatically.
echo "[setup] Installing repo tools in editable mode"
# research_tracks lives one level down; the rest are tools/<name>.
mapfile -t TOOL_PKGS < <(
  find "$ROOT/tools" -maxdepth 3 -name pyproject.toml \
    -not -path "*/.venv/*" -not -path "*/node_modules/*" -print0 \
    | xargs -0 -n1 dirname | sort -u
)
failed=()
for pkg in "${TOOL_PKGS[@]}"; do
  echo "[setup]   pip install -e ${pkg#$ROOT/}"
  pip install -e "$pkg" || failed+=("${pkg#$ROOT/}")
done
if (( ${#failed[@]} )); then
  echo "[setup] WARNING: these tools failed to install:"
  printf '  - %s\n' "${failed[@]}"
fi

echo "[setup] Verifying gateway can import all sub-tools"
python3 "$ROOT/tools/mcp_gateway/server.py" --help >/dev/null 2>&1 || true
python3 - <<'PY'
import importlib, sys
# Top-level gateway deps
for m in ("mcp", "starlette", "uvicorn", "httpx"):
    importlib.import_module(m)
print("  gateway deps OK")
PY

echo "[setup] Repo environment ready. Activate with: source $VENV_DIR/bin/activate"
