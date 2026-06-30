#!/usr/bin/env bash
# Deploy the chezmaurice.eu landing site (design/landing/) to Cloudflare Pages,
# bundling the notarized server .pkg as a static download.
#
# Prereqs (one-time): a Cloudflare Pages project (default name "chezmaurice")
# with the custom domain www.chezmaurice.eu attached (see RELEASING.md), and
# wrangler authenticated (`npx wrangler login`).
#
# Usage:  scripts/deploy-landing.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SITE="$REPO_ROOT/design/landing"
PKG="$REPO_ROOT/infra/installer/ChezMaurice.pkg"
PROJECT="${CF_PAGES_PROJECT:-chezmaurice}"

[[ -d "$SITE" ]] || { echo "ERROR: site dir missing: $SITE"; exit 1; }

# Bundle the server download (gitignored; copied in at deploy time only).
if [[ -f "$PKG" ]]; then
  cp "$PKG" "$SITE/ChezMaurice.pkg"
  echo "==> Bundled ChezMaurice.pkg ($(du -h "$PKG" | cut -f1)) → /ChezMaurice.pkg"
else
  echo "==> WARN: $PKG not found. Build it first:"
  echo "    (signed) MAURICE_VERSION=… MAURICE_SIGN_IDENTITY=… MAURICE_INSTALLER_IDENTITY=… MAURICE_NOTARY_PROFILE=… ./infra/installer/build.sh --public"
  echo "    Deploying the site WITHOUT the download for now."
fi

echo "==> Deploying $SITE to Cloudflare Pages project '$PROJECT'..."
npx wrangler pages deploy "$SITE" --project-name="$PROJECT"
echo "==> Done. Live at your Pages URL / www.chezmaurice.eu once the custom domain is attached."
