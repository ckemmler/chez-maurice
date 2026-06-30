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

# Version control. VERSION = marketing version (CFBundleShortVersionString),
# which Apple requires to be 1–3 dot-separated integers (e.g. 1.0.0) — no
# "-beta" suffix. BUILD = the build number (CFBundleVersion), which must strictly
# increase per upload; defaults to the git commit count (monotonic). Track the
# "beta" label and history via git tags (e.g. app-v1.0.0-beta.1).
VERSION="${VERSION:-}"
BUILD="${BUILD:-$(git -C "$SCRIPT_DIR" rev-list --count HEAD 2>/dev/null || echo 1)}"

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
