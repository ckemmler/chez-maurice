#!/usr/bin/env bash
# Tear down a household provisioned by provision-household.sh: stop + remove the
# launchd agent, remove the tunnel ingress rule (reload), and delete the
# Cloudflare DNS record. By default the database dir is KEPT; pass --purge-db to
# also delete it.
#
# Usage:   infra/deprovision-household.sh <subdomain> [--purge-db]
# Example: infra/deprovision-household.sh friend

set -euo pipefail

SUB="${1:?usage: deprovision-household.sh <subdomain> [--purge-db]}"
PURGE="${2:-}"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ZONE="8ade14b68025e1d431bcca28d14465b0"          # chezmaurice.eu
HOST="$SUB.chezmaurice.eu"
DATA_DIR="$HOME/.maurice-$SUB"
CF_CONFIG="$HOME/.cloudflared/config.yml"
PLIST="$HOME/Library/LaunchAgents/com.maurice.household.$SUB.plist"
API="https://api.cloudflare.com/client/v4"
TOKEN="$(tr -d '[:space:]' < "$REPO/server/.secrets/cloudflare-token")"
auth=(-H "Authorization: Bearer $TOKEN")

echo "▸ Deprovisioning $HOST"

# 1) launchd agent
if [[ -f "$PLIST" ]]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "  Server : stopped + removed launchd agent ✓"
fi

# 2) ingress rule (remove the 4-line block, reload)
if grep -q "hostname: $HOST" "$CF_CONFIG"; then
  cp "$CF_CONFIG" "$CF_CONFIG.bak-$(date +%s)"
  python3 - "$CF_CONFIG" "$HOST" <<'PY'
import sys
path, host = sys.argv[1:3]
lines = open(path).read().splitlines()
out, i = [], 0
while i < len(lines):
    if lines[i].strip() == f"- hostname: {host}":
        i += 1
        while i < len(lines) and not lines[i].strip().startswith("- "):
            i += 1
        continue
    out.append(lines[i]); i += 1
open(path, "w").write("\n".join(out) + "\n")
PY
  cloudflared tunnel ingress validate >/dev/null
  PID=$(pgrep -f 'opt/cloudflared/bin/cloudflared tunnel run' | head -1 || true)
  [[ -n "$PID" ]] && kill -HUP "$PID"
  echo "  Ingress: removed + tunnel reloaded ✓"
fi

# 3) DNS record
recid=$(curl -s "${auth[@]}" "$API/zones/$ZONE/dns_records?type=CNAME&name=$HOST" \
  | bun -e 'const d=await Bun.stdin.json(); process.stdout.write(d.result?.[0]?.id||"")')
if [[ -n "$recid" ]]; then
  curl -s -X DELETE "${auth[@]}" "$API/zones/$ZONE/dns_records/$recid" >/dev/null
  echo "  DNS    : deleted $HOST ✓"
fi

# 4) database
if [[ "$PURGE" == "--purge-db" && -d "$DATA_DIR" ]]; then
  rm -rf "$DATA_DIR"
  echo "  DB     : purged $DATA_DIR ✓"
elif [[ -d "$DATA_DIR" ]]; then
  echo "  DB     : kept $DATA_DIR (pass --purge-db to delete)"
fi
echo "▸ Done."
