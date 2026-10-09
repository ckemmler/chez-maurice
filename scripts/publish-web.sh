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

# The site is built into a folder of its own, never into web/dist: that one is
# the running garden engine (scripts/start-web.sh), and a static build written
# over it took every garden page down until the engine was rebuilt. WEB_SSR is
# unset for the same reason the folder is named here: this script is started by
# the API server, and must build the static site whatever its caller exports.
OUT="dist-site/$GARDEN"
unset WEB_SSR

# NODE_ENV=production is what excludes drafts and fiches from the build.
echo "→ building $GARDEN (theme: $THEME) into web/$OUT"
NODE_ENV=production GARDEN="$GARDEN" THEME="$THEME" npm run build -- --outDir "$OUT"
[[ -f "$OUT/index.html" ]] || { echo "✗ the build left no site in web/$OUT"; exit 1; }

# The site is plain files. The adapter also leaves a Worker beside them
# (_worker.js, 13 MB, and the _routes.json that sends requests to it) for the
# few pages rendered on request — the private overlay's library, which has no
# server to talk to out there and answered 500. Deployed, it was compiled,
# uploaded and brought up on every publish: two thirds of the deploy, for
# nothing a visitor could read. Without it Pages serves the files and nothing
# else.
rm -rf "$OUT/_worker.js" "$OUT/_routes.json"

echo "→ deploying to Cloudflare Pages project '$GARDEN_PAGES_PROJECT' (branch: $DEPLOY_BRANCH)"
npx wrangler pages deploy "$OUT" --project-name="$GARDEN_PAGES_PROJECT" --branch="$DEPLOY_BRANCH"
