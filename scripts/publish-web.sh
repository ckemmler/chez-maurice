#!/usr/bin/env bash
# Build the public site and deploy it to Cloudflare Pages.
#
# This is the last step of publishing, not the first: only content flagged
# `public` is built (see web/src/content.config.ts), so marking a post
# publishable — set_flags, or the frontmatter by hand — has to happen before.
#
# The previous version of this script predated two renames: it cd'd into a
# sibling `akita-web` that no longer exists and pulled content from
# web/src/content, which stopped being where content lives when gardens moved
# to their own data dir. It could not have run.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
load_env

GARDEN="${GARDEN:-candide}"
THEME="${THEME:-$GARDEN}"

# Deliberately NOT called CF_PAGES_PROJECT: deploy-landing.sh already reads that
# name, defaulting to the product landing site. Sharing one variable between two
# scripts that publish different sites to different projects means a shell that
# happens to have .env loaded would push the landing page over the personal
# garden, or the reverse — silently, since wrangler would just accept it.
: "${GARDEN_PAGES_PROJECT:?set GARDEN_PAGES_PROJECT (the Cloudflare Pages project this garden publishes to) in .env}"

# Which Pages environment this lands in. Wrangler otherwise infers it from the
# CURRENT GIT BRANCH of this checkout — which has nothing to do with what is
# being published: the site's content comes from the member's garden, not from
# the source tree. Publishing while a feature branch happened to be checked out
# therefore produced a preview URL and left the live site untouched, saying
# nothing about it. A publish is a publish; say so rather than infer it.
# Override with GARDEN_PAGES_BRANCH to push a preview deliberately.
DEPLOY_BRANCH="${GARDEN_PAGES_BRANCH:-main}"

garden_dir="$(gardens_root)/$GARDEN"
[[ -d "$garden_dir" ]] || { echo "✗ no garden at $garden_dir"; exit 1; }

# Pick up anything pushed from another device. The post-receive hook normally
# fast-forwards the working tree already, so this is belt and braces — and
# --ff-only, because a divergence needs a human, not a merge commit made by a
# deploy script.
if [[ -d "$garden_dir/.git" ]]; then
  echo "→ refreshing $GARDEN's garden"
  git -C "$garden_dir" pull --ff-only --quiet \
    || echo "  ! could not fast-forward — deploying the working tree as it stands"
fi

cd "$REPO/web"
[[ -d node_modules ]] || { echo "→ installing web deps"; npm install; }

# NODE_ENV=production is what excludes drafts and fiches from the build.
echo "→ building $GARDEN (theme: $THEME)"
NODE_ENV=production GARDEN="$GARDEN" THEME="$THEME" npm run build

echo "→ deploying to Cloudflare Pages project '$GARDEN_PAGES_PROJECT' (branch: $DEPLOY_BRANCH)"
npx wrangler pages deploy dist --project-name="$GARDEN_PAGES_PROJECT" --branch="$DEPLOY_BRANCH"
