#!/usr/bin/env bash
# Build the app once per platform and put it on every device at hand:
#
#   - every iPhone and iPad Xcode has paired and can reach right now
#     (`xcrun devicectl`), installed and launched;
#   - this Mac, into /Applications;
#   - every other Mac on the tailnet that is online and answers ssh, over
#     rsync into /Applications, then relaunched.
#
# What it cannot do: reach an iPhone or iPad over the tailnet alone. CoreDevice
# finds devices by USB or Bonjour on the local network; Tailscale carries
# neither. A phone away from home gets the app from TestFlight
# (`build-testflight.sh`), not from here.
#
#   app/deploy-devices.sh            # everything reachable
#   app/deploy-devices.sh ios        # phones and pads only
#   app/deploy-devices.sh mac        # Macs only
#   ONLY="iPhone Candide" app/deploy-devices.sh ios   # one device, by name
#
# Builds are Debug with the automatic development signing the project carries;
# the device must already trust the team (it does, once Xcode has run on it).
set -euo pipefail

cd "$(dirname "$0")"
WHAT="${1:-all}"
DD="${DERIVED_DATA:-/tmp/maurice-deploy-dd}"
BUNDLE_ID="eu.chezmaurice.app"
TS="$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
skip() { printf '  · %s\n' "$*"; }

build() { # scheme destination
  say "Building $1…"
  # xcodebuild enumerates the paired devices and complains at length on stderr
  # about any it cannot open (a locked phone); the log is shown only on failure.
  local log="$DD/build-$1.log"; mkdir -p "$DD"
  xcodebuild -project Maurice.xcodeproj -scheme "$1" -destination "$2" \
    -configuration Debug -allowProvisioningUpdates -derivedDataPath "$DD" \
    build -quiet >"$log" 2>&1 || { grep -E "error:" "$log" | head -20; echo "build failed — see $log" >&2; exit 1; }
}

# ---- iPhones and iPads -------------------------------------------------------
deploy_ios() {
  build Maurice_iOS 'generic/platform=iOS'
  local app="$DD/Build/Products/Debug-iphoneos/Maurice.app"
  local json; json="$(mktemp)"
  xcrun devicectl list devices --json-output "$json" >/dev/null 2>&1
  # Phones and pads that are reachable; the watch and the unplugged ones are not.
  python3 - "$json" "${ONLY:-}" <<'EOF' | while IFS=$'\t' read -r id name state; do
import json, sys
only = sys.argv[2]
for d in json.load(open(sys.argv[1]))["result"]["devices"]:
    p = d["deviceProperties"]; h = d["hardwareProperties"]; c = d["connectionProperties"]
    name = p.get("name", "?"); state = c.get("tunnelState", "?")
    if h.get("deviceType") not in ("iPhone", "iPad"): continue
    if only and name != only: continue
    if c.get("pairingState") != "paired": continue
    print(f'{d["identifier"]}\t{name}\t{state}')
EOF
    if [ "$state" = "unavailable" ]; then skip "$name — not reachable (off, asleep, or not on this network)"; continue; fi
    say "→ $name"
    if xcrun devicectl device install app --device "$id" "$app" 2>&1 | grep -q "App installed"; then
      # Launch is best effort: a locked screen refuses it and that is fine.
      xcrun devicectl device process launch --terminate-existing --device "$id" "$BUNDLE_ID" >/dev/null 2>&1 \
        && skip "installed and launched" || skip "installed (open it by hand — the screen is locked)"
    else
      skip "install failed"
    fi
  done
  rm -f "$json"
}

# ---- Macs --------------------------------------------------------------------
deploy_mac() {
  build Maurice_macOS 'platform=macOS'
  local app="$DD/Build/Products/Debug/Maurice.app"

  say "→ this Mac ($(scutil --get ComputerName))"
  install_mac_local "$app"

  [ -x "$TS" ] || { skip "no tailscale binary; other Macs skipped"; return; }
  local self; self="$("$TS" status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["HostName"])')"
  "$TS" status --json | python3 -c '
import json, sys
st = json.load(sys.stdin)
for p in st["Peer"].values():
    if p.get("OS") == "macOS" and p.get("Online"):
        print(p["HostName"], p["TailscaleIPs"][0])
' | while read -r host ip; do
    [ "$host" = "$self" ] && continue
    say "→ $host ($ip)"
    if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$ip" true 2>/dev/null; then
      skip "no ssh (enable Remote Login there, or Tailscale SSH); skipped"; continue
    fi
    rsync -a --delete "$app/" "$ip:/Applications/Maurice.app/"
    ssh "$ip" 'osascript -e "quit app \"Maurice\"" >/dev/null 2>&1; sleep 1; open -a /Applications/Maurice.app' \
      && skip "installed and relaunched" || skip "copied; relaunch failed"
  done
}

install_mac_local() {
  osascript -e 'quit app "Maurice"' >/dev/null 2>&1 || true
  rsync -a --delete "$1/" /Applications/Maurice.app/
  open -a /Applications/Maurice.app && skip "installed and relaunched"
}

case "$WHAT" in
  all) deploy_ios; deploy_mac ;;
  ios) deploy_ios ;;
  mac) deploy_mac ;;
  *) echo "usage: $0 [all|ios|mac]" >&2; exit 2 ;;
esac
