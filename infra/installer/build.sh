#!/bin/bash
# build.sh — Build a .pkg installer for Maurice
#
# Prerequisites:
#   - Xcode command line tools (pkgbuild, productbuild)
#
# Usage: cd infra/installer && ./build.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
STAGING="$SCRIPT_DIR/staging"
OUTPUT="$SCRIPT_DIR/ChezMaurice.pkg"
IDENTIFIER="com.maurice.installer"
VERSION="${MAURICE_VERSION:-0.1.0}"

# Build mode. `--public` ships only the public surface: the note tools of the
# garden module (the gateway runs garden with MAURICE_GARDEN_PROFILE=public),
# and NONE of the private tools (corpus, calendar, calibre, …). The default
# (full/private) build is self-contained with every tool the builder has.
PUBLIC_BUILD=0
for arg in "$@"; do
  [[ "$arg" == "--public" ]] && PUBLIC_BUILD=1
done
# Private tools — symlinks into the sibling maurice-tools repo. Excluded from a
# public build. (garden, mcp_gateway, shared are the in-repo public dirs.)
PRIVATE_TOOLS=(corpus calendar calibre compte contacts health layouts pipelines readwise signals social tasks thoughts tracks)

# ── Code signing / notarization (all optional; unset = unsigned local build) ──
# Identity strings are NOT secret (names + cert hashes); the actual key stays in
# the Keychain and the notarization credentials in the notarytool profile.
#   MAURICE_SIGN_IDENTITY       "Developer ID Application: Name (TEAMID)"  — signs Mach-O (bun)
#   MAURICE_INSTALLER_IDENTITY  "Developer ID Installer: Name (TEAMID)"    — signs the .pkg
#   MAURICE_NOTARY_PROFILE      notarytool keychain-profile name           — notarize + staple
SIGN_IDENTITY="${MAURICE_SIGN_IDENTITY:-}"
INSTALLER_IDENTITY="${MAURICE_INSTALLER_IDENTITY:-}"
NOTARY_PROFILE="${MAURICE_NOTARY_PROFILE:-}"
ENTITLEMENTS="$SCRIPT_DIR/bun.entitlements"

echo "==> Cleaning staging area..."
rm -rf "$STAGING"
mkdir -p "$STAGING/usr/local/lib/maurice"/{bin,server,mcp-gateway,plists}

DEST="$STAGING/usr/local/lib/maurice"

# ── Copy bun binary ──────────────────────────────────────────────────────
echo "==> Copying bun binary..."
if command -v bun &>/dev/null; then
  cp "$(command -v bun)" "$DEST/bin/bun"
else
  echo "ERROR: bun not found. Install bun first."
  exit 1
fi

# ── CLI ──────────────────────────────────────────────────────────────────
echo "==> Copying maurice CLI..."
cp "$SCRIPT_DIR/maurice" "$DEST/bin/maurice"
chmod +x "$DEST/bin/maurice"

# ── Copy server (Maurice + data-api combined) ────────────────────────────
echo "==> Copying server..."
# SECURITY: never package secrets. .gitignore protects git, NOT this payload —
# .secrets/ (Cloudflare token, APNs .p8) and any cert/key/env must be excluded
# here or they ship inside the (public) installer.
rsync -a \
  --exclude='node_modules' --exclude='.git' \
  --exclude='.env' --exclude='.env.*' \
  --exclude='certs' --exclude='.secrets' \
  --exclude='*.p8' --exclude='*.p12' --exclude='*.pem' --exclude='*.key' --exclude='*.cer' \
  "$REPO_ROOT/server/" "$DEST/server/"

# ── Copy MCP gateway (Python tools) ─────────────────────────────────────
# Preserve the tools/ directory (-> mcp-gateway/tools/) so the gateway's
# `from tools.X import …` imports and its parents[2] REPO_ROOT both resolve in
# the install tree exactly as they do in the source repo.
#
# -L (copy-links): many tool dirs (corpus, calendar, …) are symlinks into the
# sibling maurice-tools repo; materialize their targets so the pkg is
# self-contained. `data` is excluded so per-tool runtime state (e.g. corpus's
# multi-hundred-MB vector DBs) never ships. A --public build additionally drops
# every private tool dir.
RSYNC_EXCLUDES=(--exclude='__pycache__' --exclude='venv' --exclude='.venv'
  --exclude='.git' --exclude='*.pyc' --exclude='data' --exclude='*.log'
  # SECURITY: never package secrets (see note on the server copy above).
  --exclude='.secrets' --exclude='.env' --exclude='.env.*'
  --exclude='*.p8' --exclude='*.p12' --exclude='*.pem' --exclude='*.key' --exclude='*.cer')
if [[ "$PUBLIC_BUILD" == "1" ]]; then
  echo "==> Copying MCP gateway (PUBLIC build — note tools only)..."
  for t in "${PRIVATE_TOOLS[@]}"; do RSYNC_EXCLUDES+=(--exclude="/$t"); done
else
  echo "==> Copying MCP gateway..."
fi
rsync -aL "${RSYNC_EXCLUDES[@]}" "$REPO_ROOT/tools/" "$DEST/mcp-gateway/tools/"

# ── Copy launchd plists ─────────────────────────────────────────────────
# Explicit list (not a glob): the public release ships only the api + gateway
# services. qdrant is private-tool infrastructure and is never bundled.
echo "==> Copying launchd plists..."
cp "$REPO_ROOT/infra/launchd/com.maurice.api.plist" "$DEST/plists/"
cp "$REPO_ROOT/infra/launchd/com.maurice.mcp-gateway.plist" "$DEST/plists/"

if [[ "$PUBLIC_BUILD" == "1" ]]; then
  # Restrict the garden tool to its note tools in the public build.
  /usr/libexec/PlistBuddy \
    -c "Add :EnvironmentVariables:MAURICE_GARDEN_PROFILE string public" \
    "$DEST/plists/com.maurice.mcp-gateway.plist"
fi

# ── Code-sign Mach-O binaries (Developer ID Application + hardened runtime) ───
# Notarization requires every executable to be signed with the hardened runtime.
# bun is a JS engine, so it additionally needs the JIT entitlements.
if [[ -n "$SIGN_IDENTITY" ]]; then
  echo "==> Code-signing binaries ($SIGN_IDENTITY)..."
  while IFS= read -r f; do
    if file "$f" 2>/dev/null | grep -q "Mach-O"; then
      codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$f"
    fi
  done < <(find "$DEST" -type f -perm -u+x)
  # Re-sign bun with the JIT entitlements (last write wins).
  codesign --force --options runtime --timestamp \
    --entitlements "$ENTITLEMENTS" --sign "$SIGN_IDENTITY" "$DEST/bin/bun"
  codesign --verify --strict --verbose=2 "$DEST/bin/bun"
else
  echo "==> Skipping code-signing (set MAURICE_SIGN_IDENTITY to enable)"
fi

# ── Build .pkg ───────────────────────────────────────────────────────────
echo "==> Building component package..."
COMPONENT_PKG="$SCRIPT_DIR/maurice-component.pkg"
pkgbuild \
  --root "$STAGING" \
  --identifier "$IDENTIFIER" \
  --version "$VERSION" \
  --scripts "$SCRIPT_DIR/scripts" \
  "$COMPONENT_PKG"

echo "==> Building product archive..."
PRODUCTBUILD_ARGS=(--distribution "$SCRIPT_DIR/distribution.xml" --package-path "$SCRIPT_DIR")
if [[ -n "$INSTALLER_IDENTITY" ]]; then
  echo "    signing installer ($INSTALLER_IDENTITY)"
  PRODUCTBUILD_ARGS+=(--sign "$INSTALLER_IDENTITY")
else
  echo "    (unsigned installer — set MAURICE_INSTALLER_IDENTITY to sign)"
fi
productbuild "${PRODUCTBUILD_ARGS[@]}" "$OUTPUT"

rm -f "$COMPONENT_PKG"
rm -rf "$STAGING"

# ── Notarize + staple ────────────────────────────────────────────────────
if [[ -n "$NOTARY_PROFILE" ]]; then
  echo "==> Notarizing (profile: $NOTARY_PROFILE) — this calls Apple and waits..."
  xcrun notarytool submit "$OUTPUT" --keychain-profile "$NOTARY_PROFILE" --wait
  echo "==> Stapling..."
  xcrun stapler staple "$OUTPUT"
  xcrun stapler validate "$OUTPUT"
else
  echo "==> Skipping notarization (set MAURICE_NOTARY_PROFILE to enable)"
fi

echo "==> Built: $OUTPUT"
if [[ -n "$SIGN_IDENTITY" || -n "$INSTALLER_IDENTITY" || -n "$NOTARY_PROFILE" ]]; then
  echo "    signed=${SIGN_IDENTITY:+yes} installer-signed=${INSTALLER_IDENTITY:+yes} notarized=${NOTARY_PROFILE:+yes}"
fi
echo "    Install with: sudo installer -pkg $OUTPUT -target /"
