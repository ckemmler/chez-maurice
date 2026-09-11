#!/usr/bin/env bash
# Ship Maurice to a host that cloud-init has already prepared.
#
#   scripts/deploy.sh <ssh-host> [tag]
#
# Three things travel: the image (through a registry), and compose.prod.yml +
# Caddyfile (through rsync). The .env stays on the host — it holds the keys, and
# it is the one file this script will never overwrite.
#
# The image is built HERE, not there. A 2 vCPU instance would take a long while
# over `bun install` and `npm ci`, and building on the Mac is arm64 → arm64, so
# there is no cross-compilation to get wrong. If MAURICE_REGISTRY is unset the
# image is piped over ssh instead, which needs no registry account and is slow
# enough (about 2 GB) that you will want one after the second time.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
export PATH="$HOME/.orbstack/bin:$PATH"

HOST="${1:?usage: deploy.sh <ssh-host> [tag]}"
TAG="${2:-$(date +%Y%m%d-%H%M%S)}"
REMOTE_DIR="${MAURICE_REMOTE_DIR:-/opt/maurice}"
COMPOSE="$REPO/infra/container/compose.prod.yml"

echo "▸ Deploying to $HOST  (tag $TAG)"

# 1. Build ──────────────────────────────────────────────────────────────────
echo "  build…"
docker build -f "$REPO/infra/container/Dockerfile" --target production \
  -t "maurice:$TAG" -t maurice:production "$REPO"

# 2. Ship the image ─────────────────────────────────────────────────────────
if [[ -n "${MAURICE_REGISTRY:-}" ]]; then
  REMOTE_IMAGE="$MAURICE_REGISTRY/maurice:$TAG"
  echo "  push  $REMOTE_IMAGE"
  docker tag "maurice:$TAG" "$REMOTE_IMAGE"
  docker push "$REMOTE_IMAGE"
else
  REMOTE_IMAGE="maurice:$TAG"
  echo "  no MAURICE_REGISTRY — piping the image over ssh (this is the slow way)"
  docker save "maurice:$TAG" | gzip | ssh "$HOST" 'gunzip | docker load'
fi

# 3. Ship the configuration ─────────────────────────────────────────────────
echo "  sync  compose.prod.yml, Caddyfile"
ssh "$HOST" "mkdir -p $REMOTE_DIR"
rsync -q "$COMPOSE" "$REPO/infra/container/Caddyfile" "$HOST:$REMOTE_DIR/"

# The .env is never overwritten: it holds the keys, and clobbering it from a
# developer machine is how a deploy takes an instance down at the worst moment.
if ! ssh "$HOST" "test -f $REMOTE_DIR/.env"; then
  echo "  ✗ no $REMOTE_DIR/.env on the host."
  echo "    Copy infra/container/.env.prod.example there, fill it in, and re-run."
  echo "    (This script will not write it: it holds the keys.)"
  exit 1
fi

# 4. Start ──────────────────────────────────────────────────────────────────
echo "  up…"
ssh "$HOST" "cd $REMOTE_DIR && MAURICE_IMAGE='$REMOTE_IMAGE' docker compose -f compose.prod.yml up -d --remove-orphans"

echo
echo "✓ deployed. Health:"
ssh "$HOST" "cd $REMOTE_DIR && docker compose -f compose.prod.yml ps"
echo
echo "  Admin:     ssh -L 3001:localhost:3001 $HOST   → http://localhost:3001/admin"
echo "             (not reachable through the public name, by design)"
echo "  Logs:      ssh $HOST 'cd $REMOTE_DIR && docker compose -f compose.prod.yml logs -f'"
echo "  Processes: ssh $HOST 'cd $REMOTE_DIR && docker compose -f compose.prod.yml exec maurice supervisorctl -c /etc/supervisor/conf.d/maurice.conf status'"
