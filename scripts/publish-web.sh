#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/../${WEB_DIR:-akita-web}"

# Pull latest content
git -C src/content pull --ff-only

# Load env vars (PRIVATE_CONTENT_PASSWORD, CF_PAGES_PROJECT, SITE_URL, …)
if [ -f .env ]; then
  set -a; source .env; set +a
fi

# Deploy target is config, not hardcoded: set CF_PAGES_PROJECT (and optionally
# SITE_URL, read by astro.config.mjs) in .env or the environment.
: "${CF_PAGES_PROJECT:?set CF_PAGES_PROJECT (Cloudflare Pages project name) in .env}"

npm run build
npx wrangler pages deploy dist --project-name="$CF_PAGES_PROJECT"
