#!/usr/bin/env bash
# Households on a shared host: add one, list them, remove one, restart one.
#
#   ops/household.sh add     <ssh-host> <name> <domain>
#   ops/household.sh list    <ssh-host>
#   ops/household.sh up      <ssh-host> <name>
#   ops/household.sh restart <ssh-host> <name>
#   ops/household.sh remove  <ssh-host> <name>        (keeps the data volume)
#   ops/household.sh purge   <ssh-host> <name>        (deletes the data too)
#
# A household is one compose project (`maurice-<name>`) with its own volume,
# behind the one Caddy (`ops/household.sh edge <host>` brings that up). The
# image comes from `scripts/deploy.sh`, which builds it here and ships it
# there; this script never builds.
#
# What it does NOT do: the DNS record. Point <domain> at the host's address
# yourself, as a plain A record — not a proxied one. Whoever proxies the
# traffic terminates the TLS and sees the clear text, and that is the line
# this whole arrangement is built to stay on the right side of.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/_lib.sh"

REMOTE_DIR="${MAURICE_REMOTE_DIR:-/opt/maurice}"
cmd="${1:-}"; shift || true
HOST="${1:-}"; shift || true
[ -n "$cmd" ] && [ -n "$HOST" ] || { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

remote() { ssh "$HOST" "$@"; }
# image.env is the host-wide record of the image scripts/deploy.sh last shipped;
# the household's own file comes second so it can pin a different one.
dc_household() {
  local name="$1"; shift
  remote "cd $REMOTE_DIR && docker compose -p maurice-$name --env-file image.env --env-file households/$name.env -f compose.household.yml $*"
}

# The next free loopback port for the admin console, 3101 upwards.
next_admin_port() {
  remote "cd $REMOTE_DIR && cat households/*.env 2>/dev/null | sed -n 's/^MAURICE_ADMIN_PORT=//p'" \
    | sort -n | awk 'BEGIN{p=3101} {if ($1==p) p++} END{print p}'
}

case "$cmd" in

edge)
  # The shared door, and the network everything joins. Caddy wants a contact
  # address for Let's Encrypt; it lives in defaults.env with the other
  # host-wide settings, and the compose file refuses to start without it.
  remote "grep -qs '^MAURICE_ACME_EMAIL=.' $REMOTE_DIR/defaults.env" || {
    echo "✗ $REMOTE_DIR/defaults.env must set MAURICE_ACME_EMAIL (see infra/container/MULTI-HOUSEHOLD.md)"; exit 1; }
  remote "docker network inspect maurice-edge >/dev/null 2>&1 || docker network create maurice-edge"
  remote "cd $REMOTE_DIR && mkdir -p sites households"
  remote "cd $REMOTE_DIR && docker compose -p maurice-edge --env-file defaults.env -f compose.caddy.yml up -d"
  echo "✓ the edge is up on $HOST (:80, :443)"
  ;;

add)
  name="${1:?usage: household.sh add <ssh-host> <name> <domain>}"
  domain="${2:?need the public domain, e.g. aline.chezmaurice.eu}"
  [[ "$name" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "✗ name must be lowercase letters, digits and dashes"; exit 1; }

  if remote "test -f $REMOTE_DIR/households/$name.env"; then
    echo "✗ $name already exists on $HOST. Use 'up' to (re)start it."; exit 1
  fi
  remote "test -f $REMOTE_DIR/image.env" || {
    echo "✗ no image on $HOST yet — run scripts/deploy.sh $HOST first"; exit 1; }
  port="$(next_admin_port)"
  echo "▸ $name → $domain  (admin on 127.0.0.1:$port)"

  # The env file. Secrets are NOT written here: the shared ones are copied
  # from the host's own defaults.env if it has one, and anything missing is
  # the operator's to fill in before the first start.
  remote "cd $REMOTE_DIR && mkdir -p households sites && {
    if [ -f defaults.env ]; then cat defaults.env; fi
    echo 'MAURICE_HOUSEHOLD=$name'
    echo 'MAURICE_DOMAIN=$domain'
    echo 'MAURICE_ADMIN_PORT=$port'
  } > households/$name.env"

  remote "cat > $REMOTE_DIR/sites/$name.caddy <<'SITE'
$domain {
	reverse_proxy maurice-$name:3001 {
		header_up X-Forwarded-Host {host}
		header_up X-Forwarded-Proto {scheme}
	}
	request_body {
		max_size 512MB
	}
	encode gzip
}
SITE"

  dc_household "$name" up -d
  remote "docker exec maurice-caddy caddy reload --config /etc/caddy/Caddyfile" || {
    echo "  ! Caddy would not reload — is the edge up? ops/household.sh edge $HOST"; }
  echo
  echo "✓ $name is up."
  echo "  Point DNS at this host:   $domain  A  <the host's address>   (unproxied)"
  echo "  Finish the setup:         ssh -L $port:localhost:$port $HOST"
  echo "                            then http://localhost:$port/admin"
  ;;

list)
  echo "household         domain                          admin   state"
  remote "cd $REMOTE_DIR && for f in households/*.env; do
    [ -e \"\$f\" ] || continue
    n=\$(basename \"\$f\" .env)
    d=\$(sed -n 's/^MAURICE_DOMAIN=//p' \"\$f\")
    p=\$(sed -n 's/^MAURICE_ADMIN_PORT=//p' \"\$f\")
    s=\$(docker inspect -f '{{.State.Status}}' maurice-\$n 2>/dev/null || echo absent)
    printf '%-17s %-31s %-7s %s\n' \"\$n\" \"\$d\" \"\$p\" \"\$s\"
  done"
  ;;

up|restart)
  name="${1:?which household?}"
  [ "$cmd" = restart ] && dc_household "$name" restart || dc_household "$name" up -d
  echo "✓ $name $cmd"
  ;;

remove|purge)
  name="${1:?which household?}"
  echo "▸ removing $name from $HOST${cmd:+ (${cmd})}"
  if [ "$cmd" = purge ]; then
    echo "  This deletes maurice-${name}_home — the databases, the gardens, everything."
    printf "  Type the household's name to confirm: "
    read -r confirm
    [ "$confirm" = "$name" ] || { echo "  aborted"; exit 1; }
    dc_household "$name" down -v
  else
    dc_household "$name" down
    echo "  the data volume maurice-${name}_home is kept"
  fi
  remote "rm -f $REMOTE_DIR/sites/$name.caddy $REMOTE_DIR/households/$name.env"
  remote "docker exec maurice-caddy caddy reload --config /etc/caddy/Caddyfile" || true
  echo "✓ $name removed. Drop its DNS record and its line in ops/fleet.yaml."
  ;;

*)
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
