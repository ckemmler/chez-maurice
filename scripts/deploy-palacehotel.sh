#!/usr/bin/env bash
# Deploy the palacehotel-software.be corporate site (design/palacehotel/) to
# Cloudflare Pages.
#
# It exists because Apple requires, for an organization enrollment, a publicly
# available website whose domain is associated with the legal entity, plus a work
# email at that domain. chezmaurice.eu is the product's site and is registered to
# a natural person; this one is the company's, registered to the company.
#
# Prereqs (one-time): a Cloudflare Pages project (default name "palacehotel")
# and wrangler authenticated (`npx wrangler login`). DNS lives at Route 53.
#
# Usage:  scripts/deploy-palacehotel.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SITE="$REPO_ROOT/design/palacehotel"
PROJECT="${CF_PAGES_PROJECT:-palacehotel}"

[[ -d "$SITE" ]] || { echo "ERROR: site dir missing: $SITE"; exit 1; }

echo "==> Deploying $SITE to Cloudflare Pages project '$PROJECT'..."
npx wrangler pages deploy "$SITE" --project-name="$PROJECT"
echo "==> Done."
