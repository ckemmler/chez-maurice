#!/usr/bin/env bash
# Provision an isolated Maurice household reachable at <sub>.chezmaurice.eu.
#
# Creates the Cloudflare DNS record (via the API token in
# server/.secrets/cloudflare-token), adds an ingress rule to the `maurice`
# tunnel, and runs a persistent server instance (launchd) on its own port and
# database. Idempotent: re-running only fills in whatever is missing.
#
# Usage:   infra/provision-household.sh <subdomain> <port> ["Household Name"]
# Example: infra/provision-household.sh friend 3003 "Friend's place"

set -euo pipefail

SUB="${1:?usage: provision-household.sh <subdomain> <port> [\"name\"]}"
PORT="${2:?need a port (e.g. 3003)}"
NAME="${3:-$SUB}"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ZONE="8ade14b68025e1d431bcca28d14465b0"          # chezmaurice.eu
TUNNEL="d0c09d96-83e0-422f-b40a-4e464b544587"     # the `maurice` tunnel
HOST="$SUB.chezmaurice.eu"
TARGET="$TUNNEL.cfargotunnel.com"
DATA_DIR="$HOME/.maurice-$SUB"
CF_CONFIG="$HOME/.cloudflared/config.yml"
PLIST="$HOME/Library/LaunchAgents/com.maurice.household.$SUB.plist"
API="https://api.cloudflare.com/client/v4"
BUN="$(command -v bun)"
TOKEN="$(tr -d '[:space:]' < "$REPO/server/.secrets/cloudflare-token")"
auth=(-H "Authorization: Bearer $TOKEN")

echo "▸ Provisioning $HOST → localhost:$PORT   (household \"$NAME\")"

# 1) DNS — create the proxied CNAME if it doesn't exist ────────────────────
existing=$(curl -s "${auth[@]}" "$API/zones/$ZONE/dns_records?type=CNAME&name=$HOST" \
  | bun -e 'const d=await Bun.stdin.json(); process.stdout.write(d.result?.[0]?.id||"")')
if [[ -n "$existing" ]]; then
  echo "  DNS    : $HOST exists ✓"
else
  curl -s -X POST "${auth[@]}" -H "Content-Type: application/json" \
    -d "{\"type\":\"CNAME\",\"name\":\"$SUB\",\"content\":\"$TARGET\",\"proxied\":true}" \
    "$API/zones/$ZONE/dns_records" \
    | bun -e 'const d=await Bun.stdin.json(); if(!d.success){console.error("  DNS create FAILED:",JSON.stringify(d.errors));process.exit(1)} console.log("  DNS    : created "+d.result.name+" ✓")'
fi

# 2) Tunnel ingress — add a hostname rule before the catch-all if absent ────
if grep -q "hostname: $HOST" "$CF_CONFIG"; then
  echo "  Ingress: rule present ✓"
else
  cp "$CF_CONFIG" "$CF_CONFIG.bak-$(date +%s)"
  python3 - "$CF_CONFIG" "$HOST" "$PORT" <<'PY'
import sys
path, host, port = sys.argv[1:4]
lines = open(path).read().splitlines()
rule = [f"  - hostname: {host}", f"    service: https://localhost:{port}",
        "    originRequest:", "      noTLSVerify: true"]
out, done = [], False
for ln in lines:
    if not done and ln.strip().startswith("- service: http_status:404"):
        out += rule; done = True
    out.append(ln)
if not done:
    out += rule
open(path, "w").write("\n".join(out) + "\n")
PY
  cloudflared tunnel ingress validate >/dev/null
  PID=$(pgrep -f 'opt/cloudflared/bin/cloudflared tunnel run' | head -1 || true)
  [[ -n "$PID" ]] && kill -HUP "$PID"
  echo "  Ingress: added + tunnel reloaded ✓"
fi

# 3) Server — a persistent launchd agent on its own port + DB ───────────────
mkdir -p "$DATA_DIR" "$HOME/Library/Logs/Maurice"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.maurice.household.$SUB</string>
  <key>ProgramArguments</key><array>
    <string>$BUN</string><string>run</string><string>$REPO/server/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO/server</string>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>$HOME</string>
    <key>PORT</key><string>$PORT</string>
    <key>MAURICE_DATA_DIR</key><string>$DATA_DIR</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/Maurice/$SUB.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/Maurice/$SUB.err.log</string>
</dict></plist>
PLISTEOF
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "  Server : launchd com.maurice.household.$SUB on :$PORT (DB $DATA_DIR) ✓"

# 4) Name the household + verify ───────────────────────────────────────────
sleep 4
for f in "$DATA_DIR"/*.db; do
  if sqlite3 "$f" "SELECT 1 FROM households LIMIT 1;" >/dev/null 2>&1; then
    sqlite3 "$f" "UPDATE households SET name='$NAME' WHERE id='default';"
    break
  fi
done
code=$(curl -sk "https://localhost:$PORT/api/health" -o /dev/null -w "%{http_code}" || true)
echo "  Health : :$PORT = $code"
echo "▸ Done. Pair the app to:  https://$HOST   (admin at https://localhost:$PORT/admin on this Mac)"
