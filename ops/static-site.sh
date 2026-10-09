#!/usr/bin/env bash
# Static sites on a shared host: the landing, a member's site on a domain of
# their own. Plain files, served by the Caddy that is already the host's door.
#
#   ops/static-site.sh publish <ssh-host> <domain> <dir> [--alias <domain>]...
#   ops/static-site.sh list    <ssh-host>
#   ops/static-site.sh remove  <ssh-host> <domain>
#
# `publish` copies <dir> to <remote>/www/<domain>/ and writes
# sites/static.<domain>.caddy, which serves it. An --alias is another name that
# answers with a permanent redirect to <domain> (the bare domain for a www
# site, or the reverse).
#
# A `_redirects` file at the root of <dir> (the Cloudflare Pages format, one
# `from to [status]` per line) becomes Caddy redirects and is not published.
# Exact paths and a trailing `/*` with `:splat` are understood; any other
# pattern is reported and skipped.
#
# What it does NOT do: the DNS record, like ops/household.sh. And it will not
# write the site file for a name that does not point at this host yet: Caddy
# asks Let's Encrypt for a certificate as soon as it learns a name, the
# challenge fails while the name leads elsewhere, and failures are rationed.
# The files are copied all the same; run `publish` again once the record is in
# place.
set -euo pipefail

REMOTE_DIR="${MAURICE_REMOTE_DIR:-/opt/maurice}"
RESOLVER="${STATIC_SITE_RESOLVER:-1.1.1.1}"
cmd="${1:-}"; shift || true
HOST="${1:-}"; shift || true
[ -n "$cmd" ] && [ -n "$HOST" ] || { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

remote() { ssh "$HOST" "$@"; }
valid_domain() { [[ "$1" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; }
reload() { remote "docker exec maurice-caddy caddy reload --config /etc/caddy/Caddyfile" >/dev/null 2>&1; }

# The address the world reaches this host at, as ssh knows it.
host_address() {
  local h; h="$(ssh -G "$HOST" | awk '/^hostname /{print $2}')"
  if [[ "$h" =~ ^[0-9.]+$ ]]; then echo "$h"; else dig +short A "$h" "@$RESOLVER" | tail -1; fi
}

# One `redir` per line of a _redirects file. A target on another host keeps
# the visitor's query string, as Pages does when the target carries none
# (/essai?via=hn must reach the sign-up form with its ?via=). A trailing splat
# (`/books/*  /resources/books/:splat`) is the one pattern understood.
redirects() {
  local file="$1" from to status rest n=0
  [ -f "$file" ] || return 0
  while read -r from to status _; do
    [[ -z "$from" || "$from" == \#* ]] && continue
    status="${status:-302}"
    if [[ -n "$to" && "$from" == */\* && "${from%/\*}" != *[*:]* ]]; then
      n=$((n + 1))
      printf '\t@splat%d path_regexp splat%d ^%s/(.*)$\n' "$n" "$n" "${from%/\*}"
      rest="{re.splat$n.1}"
      printf '\tredir @splat%d %s %s\n' "$n" "${to//:splat/$rest}" "$status"
    elif [[ -z "$to" || "$from" == *[*:]* || "$to" == *:splat* ]]; then
      echo "  ! _redirects: skipped '$from $to' (exact paths and a trailing /* only)" >&2
    else
      [[ "$to" == http* && "$to" != *[?#]* ]] && to="$to?{query}"
      printf '\tredir %s %s %s\n' "$from" "$to" "$status"
    fi
  done < "$file"
}

case "$cmd" in

publish)
  domain="${1:?usage: static-site.sh publish <ssh-host> <domain> <dir> [--alias <domain>]...}"
  dir="${2:?need the directory to publish}"
  shift 2
  aliases=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --alias) aliases+=("${2:?--alias needs a domain}"); shift 2 ;;
      *) echo "✗ unknown option $1"; exit 2 ;;
    esac
  done
  for d in "$domain" ${aliases[@]+"${aliases[@]}"}; do
    valid_domain "$d" || { echo "✗ not a domain name: $d"; exit 1; }
  done
  [ -f "$dir/index.html" ] || { echo "✗ no index.html in $dir — not a built site"; exit 1; }

  # Caddy must see the files: the www/ mount came with this script, and an
  # edge started before it has to be brought up again once.
  remote "docker inspect -f '{{range .Mounts}}{{.Destination}} {{end}}' maurice-caddy 2>/dev/null | grep -q '/srv/www'" || {
    echo "✗ the Caddy on $HOST does not mount www/ yet: scripts/deploy.sh ships the compose file,"
    echo "  then ops/household.sh edge $HOST recreates the door with it."
    exit 1; }

  echo "▸ $domain → $HOST:$REMOTE_DIR/www/$domain ($(du -sh "$dir" | cut -f1 | tr -d ' '))"
  remote "mkdir -p $REMOTE_DIR/www/$domain"
  # --delay-updates: the new files land together at the end rather than one by
  # one, so a visitor does not get a new page with an old stylesheet.
  rsync -az --delete --delay-updates \
    --exclude _redirects --exclude .DS_Store --exclude '.git*' \
    --exclude _worker.js --exclude _routes.json \
    "$dir/" "$HOST:$REMOTE_DIR/www/$domain/"

  site="$(mktemp)"; trap 'rm -f "$site"' EXIT
  {
    echo "# Written by ops/static-site.sh. The next publish overwrites it."
    echo "$domain {"
    printf '\troot * /srv/www/%s\n' "$domain"
    redirects "$dir/_redirects"
    # /docs answers docs.html, the way the builds here write their pages, and
    # /docs/ goes back to /docs as it did on Pages. A directory with an index
    # is left to file_server, which adds the slash and serves it.
    printf '\t@slashed {\n\t\tpath_regexp slashed ^(.+)/$\n\t\tfile {re.slashed.1}.html\n\t}\n'
    printf '\tredir @slashed {re.slashed.1} 308\n'
    printf '\ttry_files {path} {path}.html\n'
    printf '\tfile_server\n'
    printf '\tencode zstd gzip\n'
    if [ -f "$dir/404.html" ]; then
      printf '\thandle_errors {\n\t\t@missing expression `{err.status_code} == 404`\n'
      printf '\t\trewrite @missing /404.html\n\t\tfile_server\n\t}\n'
    fi
    echo "}"
    for a in ${aliases[@]+"${aliases[@]}"}; do
      printf '%s {\n\tredir https://%s{uri} permanent\n}\n' "$a" "$domain"
    done
  } > "$site"

  address="$(host_address)"
  elsewhere=()
  for d in "$domain" ${aliases[@]+"${aliases[@]}"}; do
    [ "$(dig +short A "$d" "@$RESOLVER" | sort | tr '\n' ' ')" = "$address " ] || elsewhere+=("$d")
  done
  if [ ${#elsewhere[@]} -gt 0 ] && [ "${STATIC_SITE_SKIP_DNS_CHECK:-}" != 1 ]; then
    echo "✓ the files are in place, and nothing serves them yet."
    echo "  These names do not point at $HOST ($address):"
    for d in "${elsewhere[@]}"; do echo "    $d  A  $address   (unproxied)"; done
    echo "  Make the records, then run this again: the site file is written then."
    exit 0
  fi

  file="$REMOTE_DIR/sites/static.$domain.caddy"
  remote "[ -f $file ] && cp $file $file.previous; cat > $file" < "$site"
  if remote "docker exec maurice-caddy caddy validate --config /etc/caddy/Caddyfile" >/dev/null 2>&1 && reload; then
    remote "rm -f $file.previous"
    echo "✓ https://$domain is served from $HOST."
  else
    # Whatever was wrong with it, the households behind the same door must
    # not be left with a configuration that will not load.
    remote "if [ -f $file.previous ]; then mv $file.previous $file; else rm -f $file; fi"
    reload || true
    echo "✗ Caddy refused the site file; the previous one is back. It was:"; sed 's/^/    /' "$site"
    exit 1
  fi
  ;;

list)
  echo "site                              size    served"
  remote "cd $REMOTE_DIR/www 2>/dev/null && for d in */; do
    [ -d \"\$d\" ] || continue
    n=\${d%/}
    s=\$(du -sh \"\$n\" | cut -f1)
    [ -f ../sites/static.\$n.caddy ] && served=yes || served='no (files only)'
    printf '%-33s %-7s %s\n' \"\$n\" \"\$s\" \"\$served\"
  done"
  ;;

remove)
  domain="${1:?which site?}"
  valid_domain "$domain" || { echo "✗ not a domain name: $domain"; exit 1; }
  remote "rm -f $REMOTE_DIR/sites/static.$domain.caddy && rm -rf $REMOTE_DIR/www/$domain"
  reload || true
  echo "✓ $domain removed. Drop its DNS record."
  ;;

*)
  sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
