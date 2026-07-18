#!/usr/bin/env bash
# Run Maurice's core services (API, MCP gateway, web) as macOS launchd agents —
# the one blessed way to run it. Installed once, they start on login and restart
# on crash; you never hand-start or hunt for a process again.
#
#   scripts/service.sh install        create + load the agents (idempotent)
#   scripts/service.sh uninstall      unload + remove them (falls back to manual)
#   scripts/service.sh restart [name] restart all, or one (api|mcp-gateway|web)
#   scripts/service.sh stop [name]     stop all, or one (stays stopped)
#   scripts/service.sh status          what's running
#   scripts/service.sh logs [name]     tail a service's log
#
# Matches the existing com.maurice.* agents (member households, research). Does
# not touch those.
set -euo pipefail
source "$(dirname "$0")/_lib.sh"

DOMAIN="gui/$(id -u)"
AGENTS="$HOME/Library/LaunchAgents"
SVC_LOG_DIR="$HOME/Library/Logs/Maurice"
# A PATH launchd (minimal by default) can use to find bun / node / npm / python.
LAUNCH_PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.bun/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# name | port | launch script (under scripts/)
SERVICES=(
  "api|3001|start-api.sh"
  "mcp-gateway|8710|start-mcp-gateway.sh"
  "web|4321|start-web.sh"
)

label_of() { echo "com.maurice.$1"; }
plist_of() { echo "$AGENTS/$(label_of "$1").plist"; }
field()    { echo "$1" | cut -d'|' -f"$2"; }

# Resolve a service spec by name (or echo all specs when no name given).
specs_for() {
  local want="${1:-}"
  for s in "${SERVICES[@]}"; do
    [[ -z "$want" || "$(field "$s" 1)" == "$want" ]] && echo "$s"
  done
}

write_plist() { # name script
  local name="$1" script="$2" label plist log
  label="$(label_of "$name")"; plist="$(plist_of "$name")"
  log="$SVC_LOG_DIR/$name.log"
  mkdir -p "$AGENTS" "$SVC_LOG_DIR"
  cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>$REPO/scripts/$script</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>$LAUNCH_PATH</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict></plist>
EOF
}

stop_port() { # free a port from any manually-started instance
  local pid; pid="$(port_pid "$1")"
  [[ -n "$pid" ]] || return 0
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do [[ -z "$(port_pid "$1")" ]] && return 0; sleep 0.25; done
  kill -9 "$(port_pid "$1")" 2>/dev/null || true
}

cmd_install() {
  local s name port script
  for s in "${SERVICES[@]}"; do
    name="$(field "$s" 1)"; port="$(field "$s" 2)"; script="$(field "$s" 3)"
    echo "→ $name (:$port)"
    stop_port "$port"                                   # free the port
    launchctl bootout "$DOMAIN/$(label_of "$name")" 2>/dev/null || true
    write_plist "$name" "$script"
    launchctl bootstrap "$DOMAIN" "$(plist_of "$name")"
    launchctl enable "$DOMAIN/$(label_of "$name")" 2>/dev/null || true
    wait_for_port "$port" 25 && echo "  ✓ up on :$port" || echo "  ✗ not listening on :$port yet — scripts/service.sh logs $name"
  done
  echo "✓ Installed. macOS runs these at login and restarts them on crash."
}

cmd_uninstall() {
  local s name
  for s in $(specs_for "${1:-}"); do
    name="$(field "$s" 1)"
    echo "→ removing $name"
    launchctl bootout "$DOMAIN/$(label_of "$name")" 2>/dev/null || true
    rm -f "$(plist_of "$name")"
  done
  echo "✓ Removed. (Manual scripts still work if you need them.)"
}

cmd_restart() {
  local s name port
  for s in $(specs_for "${1:-}"); do
    name="$(field "$s" 1)"; port="$(field "$s" 2)"
    echo "→ restarting $name"
    launchctl kickstart -k "$DOMAIN/$(label_of "$name")" 2>/dev/null \
      || { echo "  not installed — run: scripts/service.sh install"; continue; }
    wait_for_port "$port" 25 && echo "  ✓ up on :$port" || echo "  ✗ see: scripts/service.sh logs $name"
  done
}

cmd_stop() {
  local s name
  for s in $(specs_for "${1:-}"); do
    name="$(field "$s" 1)"
    echo "→ stopping $name"
    launchctl bootout "$DOMAIN/$(label_of "$name")" 2>/dev/null || true
  done
}

cmd_status() {
  printf "%-14s %-7s %-9s %s\n" SERVICE PORT STATE PID
  local s name port pid state
  for s in "${SERVICES[@]}"; do
    name="$(field "$s" 1)"; port="$(field "$s" 2)"
    pid="$(port_pid "$port")"
    if launchctl print "$DOMAIN/$(label_of "$name")" >/dev/null 2>&1; then
      state="managed"
    elif [[ -n "$pid" ]]; then
      state="manual"
    else
      state="-"
    fi
    printf "%-14s %-7s %-9s %s\n" "$name" ":$port" "$state" "${pid:-—}"
  done
}

cmd_logs() {
  local name="${1:?usage: service.sh logs <name>}"
  tail -n 40 -f "$SVC_LOG_DIR/$name.log"
}

case "${1:-status}" in
  install)   cmd_install ;;
  uninstall) cmd_uninstall "${2:-}" ;;
  restart)   cmd_restart "${2:-}" ;;
  stop)      cmd_stop "${2:-}" ;;
  status)    cmd_status ;;
  logs)      cmd_logs "${2:-}" ;;
  *) echo "usage: service.sh {install|uninstall|restart|stop|status|logs} [name]"; exit 1 ;;
esac
