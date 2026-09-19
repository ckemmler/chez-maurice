#!/usr/bin/env bash
# The hosted households' backups: install the nightly job on a host, run it,
# see what it holds, and — the part that matters — restore.
#
#   ops/backup.sh install      <ssh-host>            script + credentials + cron line
#   ops/backup.sh run          <ssh-host> [name]     a backup now, all or one
#   ops/backup.sh status       <ssh-host>            last success per household, latest snapshots
#   ops/backup.sh snapshots    <ssh-host> [name]     restic's own list
#   ops/backup.sh restore-test <ssh-host> <name>     restore the latest into a throwaway
#                                                    household, boot it, count what it
#                                                    holds, tear it down
#   ops/backup.sh restore      <ssh-host> <name> [snapshot]
#                                                    restore INTO that household's volume
#                                                    (it must be down); asks first
#
# The credentials are one file, ~/.maurice/ops/fleet-backup.env on the Mac,
# copied to /opt/maurice/backup.env on the host: the restic repository (a
# bucket on Scaleway Object Storage, project maurice), its password, and an
# S3 key that can read, write and delete objects there and nothing else. The
# Mac's copy is the one that matters — the host can be rebuilt, the password
# cannot be recovered.
#
# How the backup is made is infra/host/backup.sh; this script only drives it.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/_lib.sh"

REMOTE_DIR="${MAURICE_REMOTE_DIR:-/opt/maurice}"
CREDS="${MAURICE_BACKUP_ENV:-$HOME/.maurice/ops/fleet-backup.env}"
RESTIC_IMAGE="${RESTIC_IMAGE:-restic/restic:0.18.1}"
cmd="${1:-}"; shift || true
HOST="${1:-}"; shift || true
[ -n "$cmd" ] && [ -n "$HOST" ] || { sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

remote() { ssh "$HOST" "$@"; }
# restic on the host, against the host's repository.
rrestic() {
  remote "docker run --rm --env-file $REMOTE_DIR/backup.env -v maurice-backup-cache:/root/.cache/restic $* "
}
# A one-off container over a volume, for moving files about.
busybox() { # <volume> <shell command>
  remote "docker run --rm -v $1:/v busybox sh -c '$2'"
}

case "$cmd" in

install)
  [ -r "$CREDS" ] || { echo "✗ $CREDS not found — create the bucket, the key and the restic password first (see the header)"; exit 1; }
  echo "▸ installing the nightly backup on $HOST"
  scp -q "$REPO/infra/host/backup.sh" "$HOST:$REMOTE_DIR/backup.sh"
  scp -q "$CREDS" "$HOST:$REMOTE_DIR/backup.env"
  remote "chmod 755 $REMOTE_DIR/backup.sh && chmod 600 $REMOTE_DIR/backup.env && mkdir -p $REMOTE_DIR/backups"
  remote "docker pull -q $RESTIC_IMAGE >/dev/null"
  # 03:30 host time, after the day's last user and before the first; the
  # log is the only trace, so it is kept and rotated by size in the script's
  # own state directory.
  remote "( crontab -l 2>/dev/null | grep -v '$REMOTE_DIR/backup.sh' ; echo '30 3 * * * $REMOTE_DIR/backup.sh >> $REMOTE_DIR/backups/backup.log 2>&1' ) | crontab -"
  echo "✓ installed: $REMOTE_DIR/backup.sh nightly at 03:30 (host time), log in $REMOTE_DIR/backups/backup.log"
  echo "  first run: ops/backup.sh run $HOST"
  ;;

run)
  remote "$REMOTE_DIR/backup.sh $*"
  ;;

status)
  echo "household   last success"
  remote "cd $REMOTE_DIR && for f in households/*.env; do n=\$(basename \"\$f\" .env); printf '%-11s %s\n' \"\$n\" \"\$(cat backups/\$n.last-ok 2>/dev/null || echo never)\"; done"
  echo
  rrestic "$RESTIC_IMAGE snapshots --latest 1 --compact" 2>/dev/null || echo "(no repository reachable)"
  ;;

snapshots)
  name="${1:-}"
  rrestic "$RESTIC_IMAGE snapshots --compact ${name:+--host maurice-$name}"
  ;;

restore-test)
  name="${1:?which household?}"
  test="${name}-restoretest"
  port=3199
  echo "▸ restoring the latest snapshot of $name into a throwaway household ($test, admin :$port)"
  remote "docker volume rm maurice-${test}_home >/dev/null 2>&1 || true"
  remote "docker volume create maurice-${test}_home >/dev/null"
  rrestic "-v maurice-${test}_home:/v $RESTIC_IMAGE restore latest:/data --host maurice-$name --target /v --quiet"
  # The consistent database copies take the place of the live ones that were
  # excluded — this is the step a restore must not skip.
  busybox "maurice-${test}_home" 'cd /v && cp -a backup/. . && rm -rf backup'
  remote "cd $REMOTE_DIR && { cat defaults.env 2>/dev/null; echo MAURICE_HOUSEHOLD=$test; echo MAURICE_DOMAIN=$test.invalid; echo MAURICE_ADMIN_PORT=$port; } > households/$test.env"
  # compose adopts the pre-made volume because the name matches the one it
  # would create; nothing is published but the loopback admin port.
  remote "cd $REMOTE_DIR && docker compose -p maurice-$test --env-file image.env --env-file households/$test.env -f compose.household.yml up -d --quiet-pull 2>&1 | tail -1"
  echo "  waiting for it to answer…"
  ok=0
  for i in $(seq 1 30); do
    if remote "curl -sf -m 3 http://127.0.0.1:$port/healthz >/dev/null"; then ok=1; break; fi
    sleep 2
  done
  if [ "$ok" = 1 ]; then
    echo "  ✓ it answers; what the restored database holds:"
    remote "docker exec maurice-$test bun -e '
      import { Database } from \"bun:sqlite\";
      const db = new Database(\"/home/maurice/.maurice/maurice.db\", { readonly: true });
      const n = (t) => db.query(\`select count(*) as n from \${t}\`).get().n;
      console.log(\`    members \${n(\"users\")}, conversations \${n(\"conversations\")}, messages \${n(\"messages\")}, personas \${n(\"maurices\")}\`);
    '"
    remote "docker exec maurice-$test sh -c 'cd /home/maurice/.maurice/gardens && for g in */; do [ -d \"\$g\" ] || continue; printf \"    garden %s: %s notes, git %s\\n\" \"\$g\" \"\$(find \$g -name \"*.md\" | wc -l)\" \"\$(git -C \$g log -1 --format=%h 2>/dev/null || echo none)\"; done'"
  else
    echo "  ✗ it never answered on :$port — inspect it before tearing down:"
    echo "    ssh $HOST docker logs maurice-$test"
  fi
  echo "▸ tearing $test down"
  remote "cd $REMOTE_DIR && docker compose -p maurice-$test --env-file image.env --env-file households/$test.env -f compose.household.yml down -v >/dev/null 2>&1; rm -f households/$test.env"
  [ "$ok" = 1 ] && echo "✓ restore rehearsed for $name" || exit 1
  ;;

restore)
  name="${1:?which household?}"
  snap="${2:-latest}"
  volume="maurice-${name}_home"
  state="$(remote "docker inspect -f '{{.State.Status}}' maurice-$name 2>/dev/null || echo absent")"
  [ "$state" = running ] && { echo "✗ maurice-$name is running — ops/household.sh remove $HOST $name first (the volume is kept)"; exit 1; }
  echo "▸ this REPLACES the contents of $volume on $HOST with snapshot $snap"
  printf "  Type the household's name to confirm: "
  read -r confirm
  [ "$confirm" = "$name" ] || { echo "  aborted"; exit 1; }
  remote "docker volume create $volume >/dev/null"
  busybox "$volume" 'cd /v && find . -mindepth 1 -maxdepth 1 -exec rm -rf {} +'
  rrestic "-v $volume:/v $RESTIC_IMAGE restore $snap:/data --host maurice-$name --target /v --quiet"
  busybox "$volume" 'cd /v && cp -a backup/. . && rm -rf backup'
  echo "✓ restored. Bring it back: ops/household.sh add $HOST $name <domain>  (the volume is adopted as it is)"
  ;;

*)
  sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
