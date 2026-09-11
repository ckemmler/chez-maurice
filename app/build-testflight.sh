#!/usr/bin/env bash
# build-testflight.sh — archive the Maurice app(s) and upload to TestFlight.
#
# Auth reuses the App Store Connect API key (the same key used for notarization).
# Signing is automatic: with -allowProvisioningUpdates + the API key, xcodebuild
# creates/downloads the Apple Distribution cert and App Store provisioning
# profile as needed (the key must have the App Manager role for that).
#
# One-time prerequisites (account/console state — not code):
#   1. App Store Connect → Apps → + : an app record for eu.chezmaurice.app.
#   2. The Free/Paid Apps agreement accepted in App Store Connect.
#   3. API key role = App Manager (or pre-create the Apple Distribution cert in
#      Xcode → Settings → Accounts → Manage Certificates).
#
# Usage:
#   ASC_KEY_ID=TJBDUXNG6C ASC_ISSUER_ID=<issuer-uuid> ./build-testflight.sh
#   PLATFORMS="macos" ASC_KEY_ID=… ASC_ISSUER_ID=… ./build-testflight.sh   # macOS only
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$SCRIPT_DIR/Maurice.xcodeproj"
TEAM_ID="${TEAM_ID:-33DB976938}"
PLATFORMS="${PLATFORMS:-ios macos}"
BUILD_DIR="$SCRIPT_DIR/build"

: "${ASC_KEY_ID:?set ASC_KEY_ID (App Store Connect API Key ID)}"
: "${ASC_ISSUER_ID:?set ASC_ISSUER_ID (App Store Connect Issuer ID)}"
KEY_PATH="${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8}"
[[ -f "$KEY_PATH" ]] || { echo "ERROR: API key not found at $KEY_PATH"; exit 1; }

AUTH=(-allowProvisioningUpdates
  -authenticationKeyPath "$KEY_PATH"
  -authenticationKeyID "$ASC_KEY_ID"
  -authenticationKeyIssuerID "$ASC_ISSUER_ID")

# ── Versions ────────────────────────────────────────────────────────────────
# VERSION = marketing version (CFBundleShortVersionString): 1–3 dot-separated
# integers, no "-beta" suffix. It lives in app/VERSION — one file, in git, that
# says what this app currently is. Override with VERSION= for a one-off.
#
# BUILD = build number (CFBundleVersion), which must strictly increase. It is
# asked of App Store Connect rather than derived locally, because every local
# scheme eventually lies: the git commit count this used to use went from 316 in
# June to 128 in September when the history was rewritten for the public
# release, which would have made the next 1.0.x upload rejected as a regression.
# Apple knows what was actually uploaded, and Apple is what enforces the rule.
VERSION="${VERSION:-$(tr -d '[:space:]' < "$SCRIPT_DIR/VERSION" 2>/dev/null || true)}"
: "${VERSION:?no version: set VERSION= or write one into app/VERSION}"

if [[ -z "${BUILD:-}" ]]; then
  echo "▸ asking App Store Connect what has already been uploaded…"
  if ! asc_info="$(ASC_KEY_ID="$ASC_KEY_ID" ASC_ISSUER_ID="$ASC_ISSUER_ID" \
                   bun run "$SCRIPT_DIR/asc-build-info.ts")"; then
    echo "ERROR: could not reach App Store Connect."
    echo "  Pass BUILD=<n> explicitly if you know it must exceed the last upload."
    exit 1
  fi
  read -r HIGHEST_BUILD HIGHEST_VERSION <<<"$asc_info"
  BUILD=$((HIGHEST_BUILD + 1))
  echo "  highest uploaded: build $HIGHEST_BUILD, version $HIGHEST_VERSION → building $VERSION ($BUILD)"

  # Refuse to go backwards. TestFlight tolerates it; the App Store does not, and
  # a version that walks backwards is a mess to unpick months later. This check
  # exists because it already happened: a 0.2.0 went out after a 1.0.0.
  ver_lt() { [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)" == "$1" && "$1" != "$2" ]]; }
  if ver_lt "$VERSION" "$HIGHEST_VERSION" && [[ -z "${ALLOW_VERSION_DOWNGRADE:-}" ]]; then
    echo "ERROR: $VERSION is lower than $HIGHEST_VERSION, already on App Store Connect."
    echo "  Bump app/VERSION, or set ALLOW_VERSION_DOWNGRADE=1 if you mean it."
    exit 1
  fi
fi

mkdir -p "$BUILD_DIR"

archive_and_upload() {
  local plat="$1" scheme destination archive opts bundle profile
  case "$plat" in
    ios)   scheme="Maurice_iOS";   destination="generic/platform=iOS"
           bundle="${IOS_BUNDLE_ID:-eu.chezmaurice.app}"; profile="${PROVISIONING_PROFILE_IOS:-}" ;;
    macos) scheme="Maurice_macOS"; destination="generic/platform=macOS"
           bundle="${MACOS_BUNDLE_ID:-eu.chezmaurice.app}"; profile="${PROVISIONING_PROFILE_MACOS:-}" ;;
    *) echo "ERROR: unknown platform '$plat' (use ios|macos)"; return 1 ;;
  esac
  archive="$BUILD_DIR/Maurice_$plat.xcarchive"
  opts="$BUILD_DIR/exportOptions_$plat.plist"

  local verargs=(CURRENT_PROJECT_VERSION="$BUILD")
  [[ -n "$VERSION" ]] && verargs+=(MARKETING_VERSION="$VERSION")
  # Pre-answer export compliance (HTTPS/standard crypto only = exempt) so builds
  # don't sit at "Missing Compliance" in TestFlight.
  verargs+=(INFOPLIST_KEY_ITSAppUsesNonExemptEncryption=NO)
  echo "==> Archiving $scheme ($plat) — version ${VERSION:-<project default>} build $BUILD ..."
  xcodebuild -project "$PROJECT" -scheme "$scheme" -configuration Release \
    -destination "$destination" -archivePath "$archive" "${AUTH[@]}" "${verargs[@]}" archive

  # Manual signing when a profile is given (reliable + CI-friendly: avoids the
  # 403 Apple returns when an API key tries to *create* a profile). Otherwise
  # fall back to automatic/cloud signing.
  if [[ -n "$profile" ]]; then
    echo "    export: manual signing, profile '$profile'"
    # macOS App Store pkgs are signed by the installer cert, which is NOT part of
    # the provisioning profile — it must be named separately or Xcode mis-validates.
    local installer_xml=""
    [[ "$plat" == "macos" ]] && installer_xml=$'\t<key>installerSigningCertificate</key><string>3rd Party Mac Developer Installer</string>'
    cat > "$opts" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key><string>app-store-connect</string>
	<key>destination</key><string>upload</string>
	<key>teamID</key><string>${TEAM_ID}</string>
	<key>manageAppVersionAndBuildNumber</key><false/>
	<key>signingStyle</key><string>manual</string>
	<key>signingCertificate</key><string>Apple Distribution</string>
${installer_xml}
	<key>provisioningProfiles</key>
	<dict><key>${bundle}</key><string>${profile}</string></dict>
</dict>
</plist>
PLIST
  else
    echo "    export: automatic (cloud) signing"
    cat > "$opts" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key><string>app-store-connect</string>
	<key>destination</key><string>upload</string>
	<key>teamID</key><string>${TEAM_ID}</string>
	<key>manageAppVersionAndBuildNumber</key><false/>
	<key>signingStyle</key><string>automatic</string>
</dict>
</plist>
PLIST
  fi

  echo "==> Exporting + uploading $plat to TestFlight..."
  xcodebuild -exportArchive -archivePath "$archive" -exportOptionsPlist "$opts" "${AUTH[@]}"
  echo "==> $plat: uploaded. App Store Connect will process the build (a few minutes)."
}

for p in $PLATFORMS; do archive_and_upload "$p"; done
echo "==> Done. Check TestFlight in App Store Connect; the public invite link stays stable across builds."
