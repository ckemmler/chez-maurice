#!/bin/bash
# uninstall.sh — Remove Maurice from this Mac
set -euo pipefail

LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
INSTALL_DIR="/usr/local/lib/maurice"
MAURICE_HOME="$HOME/.maurice"
LOG_DIR="$HOME/Library/Logs/Maurice"

PLISTS=(
  com.maurice.api
  com.maurice.mcp-gateway
)

echo "Chez Maurice Uninstaller"
echo "========================"
echo ""

# ── Unload launchd services ──────────────────────────────────────────────
echo "==> Stopping services..."
for plist in "${PLISTS[@]}"; do
  f="$LAUNCH_AGENTS/${plist}.plist"
  if [[ -f "$f" ]]; then
    launchctl unload "$f" 2>/dev/null || true
    rm -f "$f"
    echo "    removed $plist"
  fi
done

# ── Remove install directory ─────────────────────────────────────────────
echo "==> Removing $INSTALL_DIR..."
sudo rm -rf "$INSTALL_DIR"

# ── Remove CLI symlink ───────────────────────────────────────────────────
echo "==> Removing CLI symlink..."
sudo rm -f /usr/local/bin/maurice

# ── Prompt about user data ───────────────────────────────────────────────
echo ""
echo "Chez Maurice application files have been removed."
echo ""
echo "The following directories contain your data and logs:"
echo "  $MAURICE_HOME"
echo "  $LOG_DIR"
echo ""
read -r -p "Delete these directories? [y/N] " answer
case "$answer" in
  [yY]|[yY][eE][sS])
    rm -rf "$MAURICE_HOME"
    rm -rf "$LOG_DIR"
    echo "==> User data removed."
    ;;
  *)
    echo "==> User data preserved."
    ;;
esac

echo ""
echo "Chez Maurice has been uninstalled."
