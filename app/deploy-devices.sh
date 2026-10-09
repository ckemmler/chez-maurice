#!/usr/bin/env bash
# Build the app once per platform and put it on every device at hand:
#
#   - every iPhone and iPad Xcode has paired and can reach right now
#     (`xcrun devicectl`), installed and launched;
#   - this Mac, into /Applications;
#   - every other Mac on the tailnet that is online and answers ssh, over
#     rsync into /Applications, then relaunched.
#
# A Mac that already holds the TestFlight or App Store copy under the same name
# keeps it: the Debug build goes to ~/Applications there instead.
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

# The .app a scheme builds, as the build settings name it: the product name
# differs per platform and has changed before.
product() { # scheme destination
  xcodebuild -project Maurice.xcodeproj -scheme "$1" -destination "$2" \
    -configuration Debug -derivedDataPath "$DD" -showBuildSettings -json 2>/dev/null | python3 -c '
import json, sys
for t in json.load(sys.stdin):
    b = t["buildSettings"]
    if b.get("PRODUCT_TYPE") == "com.apple.product-type.application":
        print(b["TARGET_BUILD_DIR"] + "/" + b["FULL_PRODUCT_NAME"]); break
'
}

q() { printf '%q' "$1"; }

# ---- iPhones and iPads -------------------------------------------------------
deploy_ios() {
  build Maurice_iOS 'generic/platform=iOS'
  local app; app="$(product Maurice_iOS 'generic/platform=iOS')"
  [ -d "$app" ] || { echo "no iOS product at '$app'" >&2; exit 1; }
  local json out; json="$(mktemp)"
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
    out="$(xcrun devicectl device install app --device "$id" "$app" 2>&1 || true)"
    if grep -q "App installed" <<<"$out"; then
      # Launch is best effort: a locked screen refuses it and that is fine.
      xcrun devicectl device process launch --terminate-existing --device "$id" "$BUNDLE_ID" >/dev/null 2>&1 \
        && skip "installed and launched" || skip "installed (open it by hand — the screen is locked)"
    else
      # devicectl says why (a locked device, an untrusted team) on its error lines.
      skip "install failed"
      { grep -iE "error|locked" <<<"$out" || tail -n 3 <<<"$out"; } | head -n 4 | sed 's/^[[:space:]]*/      /'
    fi
  done
  rm -f "$json"
}

# ---- Macs --------------------------------------------------------------------
deploy_mac() {
  build Maurice_macOS 'platform=macOS'
  local app name dest; app="$(product Maurice_macOS 'platform=macOS')"
  [ -d "$app" ] || { echo "no macOS product at '$app'" >&2; exit 1; }
  name="$(basename "$app")"

  say "→ this Mac ($(scutil --get ComputerName))"
  install_mac_local "$app"

  [ -x "$TS" ] || { skip "no tailscale binary; other Macs skipped"; return; }
  local self; self="$("$TS" status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["HostName"])')"
  "$TS" status --json | python3 -c '
import json, sys
st = json.load(sys.stdin)
for p in st["Peer"].values():
    if p.get("OS") == "macOS" and p.get("Online"):
        print(p["HostName"], p["TailscaleIPs"][0], sep="\t")
' | while IFS=$'\t' read -r host ip; do  # a host name may hold spaces
    [ "$host" = "$self" ] && continue
    say "→ $host ($ip)"
    # ssh -n throughout: it would otherwise swallow the rest of the peer list.
    if ! ssh -n -o BatchMode=yes -o ConnectTimeout=5 "$ip" true 2>/dev/null; then
      skip "no ssh (enable Remote Login there, or Tailscale SSH); skipped"; continue
    fi
    # The remote shell splits its command line again, hence the quoting.
    dest="$(ssh -n "$ip" "bash -c $(q "$MAC_DEST") _ $(q "$name")")"
    rsync -a --delete "$app/" "$ip:$(q "$dest")/"
    ssh -n "$ip" "pkill -f $(q "^$dest/Contents/MacOS/"); sleep 1; open -n $(q "$dest")" \
      && skip "installed in $(dirname "$dest") and relaunched" || skip "copied to $dest; relaunch failed"
  done
}

# Where a Mac takes the build, given the bundle's name: /Applications, unless
# the copy there came from TestFlight or the App Store (it carries a receipt and
# belongs to root), which stays as it is. Run here and, over ssh, on the others.
MAC_DEST='d="/Applications/$1"; [ -e "$d/Contents/_MASReceipt" ] && d="$HOME/Applications/$1"; mkdir -p "$d" && echo "$d"'

install_mac_local() {
  local dest; dest="$(bash -c "$MAC_DEST" _ "$(basename "$1")")"
  # Only the copy being replaced is quit and reopened: the TestFlight build and
  # a session under Xcode share the name and the bundle id, and are left alone.
  pkill -f "^$dest/Contents/MacOS/" || true
  rsync -a --delete "$1/" "$dest/"
  open -n "$dest" && skip "installed in $(dirname "$dest") and relaunched"
}

case "$WHAT" in
  all) deploy_ios; deploy_mac ;;
  ios) deploy_ios ;;
  mac) deploy_mac ;;
  *) echo "usage: $0 [all|ios|mac]" >&2; exit 2 ;;
esac
