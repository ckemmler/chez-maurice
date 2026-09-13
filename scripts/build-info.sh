#!/usr/bin/env bash
# Stamp the build: write server/build-info.json (git-ignored) so a server that
# does not run from a git checkout — the container image — can still say on
# /healthz which commit it is. The Mac install runs from the checkout and
# falls back to `git` itself, so this is optional there.
#
#   scripts/build-info.sh [version]     version defaults to `git describe`
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

sha="$(git -C "$REPO" rev-parse --short=12 HEAD 2>/dev/null || echo null)"
version="${1:-$(git -C "$REPO" describe --tags --match '*v[0-9]*' --always --dirty 2>/dev/null || echo dev)}"
built_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cat > "$REPO/server/build-info.json" <<EOF
{ "version": "$version", "git_sha": "$sha", "built_at": "$built_at" }
EOF
echo "→ build-info: $version ($sha) $built_at"
