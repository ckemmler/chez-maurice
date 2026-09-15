#!/usr/bin/env bash
# Deploy the chezmaurice.eu landing site (design/landing/) to Cloudflare Pages.
#
# It bundles nothing: Maurice ships as a container image since 14 September 2026
# and the notarized .pkg this script used to copy in is retired. A deploy is the
# contents of design/landing/ and nothing else — which also means the old
# /ChezMaurice.pkg URL stops answering, deliberately.
#
# Prereqs (one-time): a Cloudflare Pages project (default name "chezmaurice")
# with the custom domain www.chezmaurice.eu attached (see RELEASING.md), and
# wrangler authenticated (`npx wrangler login`).
#
# Usage:  scripts/deploy-landing.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SITE="$REPO_ROOT/design/landing"
PROJECT="${CF_PAGES_PROJECT:-chezmaurice}"

[[ -d "$SITE" ]] || { echo "ERROR: site dir missing: $SITE"; exit 1; }

echo "==> Deploying $SITE to Cloudflare Pages project '$PROJECT'..."
npx wrangler pages deploy "$SITE" --project-name="$PROJECT"
echo "==> Done. Live at your Pages URL / www.chezmaurice.eu once the custom domain is attached."
