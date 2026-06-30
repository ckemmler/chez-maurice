#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/../akita-web/src/content"

git add -A
git diff --cached --quiet && echo "Nothing to commit." && exit 0
git commit -m "Update content $(date +%Y-%m-%d)"
git push
