#!/usr/bin/env bash
# Put the chezmaurice.eu landing site (design/landing/) on the host that serves it.
#
# It bundles nothing: Maurice ships as a container image since 14 September 2026
# and the notarized .pkg this script used to copy in is retired. A deploy is the
# contents of design/landing/ and nothing else — which also means the old
# /ChezMaurice.pkg URL stops answering, deliberately.
#
# The site is plain files behind the fleet's Caddy (ops/static-site.sh), which
# also reads design/landing/_redirects. It was a Cloudflare Pages project until
# 9 October 2026.
#
# Usage:  scripts/deploy-landing.sh [ssh-host]
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SITE="$REPO_ROOT/design/landing"
HOST="${1:-${LANDING_HOST:-maurice-fleet}}"
DOMAIN="${LANDING_DOMAIN:-www.chezmaurice.eu}"
ALIAS="${LANDING_ALIAS:-chezmaurice.eu}"

[[ -d "$SITE" ]] || { echo "ERROR: site dir missing: $SITE"; exit 1; }

"$REPO_ROOT/ops/static-site.sh" publish "$HOST" "$DOMAIN" "$SITE" --alias "$ALIAS"
