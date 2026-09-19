#!/usr/bin/env bash
# Nightly backup of every household on this host, to Object Storage, with
# restic. Installed at /opt/maurice/backup.sh by `ops/backup.sh install`,
# which also drops the credentials beside it and the cron line that runs it.
#
#   /opt/maurice/backup.sh                every household in households/*.env
#   /opt/maurice/backup.sh aline          just that one
#
# What a snapshot holds: the household's whole volume (maurice-<name>_home),
# minus what is live or regenerable. The SQLite databases are NOT copied as
# they lie — a WAL database read mid-write is a corrupt backup that looks
# fine — so first the running container writes a consistent copy of each one
# (`VACUUM INTO`, through bun:sqlite; the image has no sqlite3 binary) into
# <volume>/backup/, mirroring the tree, and the live files are excluded. A
# restore therefore ends with `backup/` copied back over the tree — which is
# exactly what `ops/backup.sh restore` and `restore-test` do.
#
# restic runs in its own container with the volume mounted read-only: nothing
# to install on the host, nothing that could write to a household by mistake.
# The repository is one per host (backup.env names it) and the snapshots are
# tagged by household, so `restic snapshots --host maurice-aline` is one
# household's history. Retention is 14 daily, 8 weekly, 12 monthly.
set -uo pipefail

DIR="${MAURICE_REMOTE_DIR:-/opt/maurice}"
ENV_FILE="$DIR/backup.env"
STATE="$DIR/backups"
RESTIC_IMAGE="${RESTIC_IMAGE:-restic/restic:0.18.1}"
KEEP=(--keep-daily 14 --keep-weekly 8 --keep-monthly 12)

say() { printf '%s [backup] %s\n' "$(date -Is)" "$*"; }
[ -r "$ENV_FILE" ] || { say "✗ $ENV_FILE is missing (ops/backup.sh install <host>)"; exit 2; }
mkdir -p "$STATE"

# One run at a time: a slow upload must not meet the next night's.
exec 9>"$STATE/.lock"
flock -n 9 || { say "another run holds the lock; leaving"; exit 0; }

# restic, against this host's repository, with a cache that survives the run.
restic() {
  docker run --rm --env-file "$ENV_FILE" \
    -v maurice-backup-cache:/root/.cache/restic \
    "$@"
}

# A consistent copy of every SQLite database in the volume, written by the
# container itself so the copy is made by the same library that holds the
# lock. Prints the live paths it copied (relative to the volume), one per
# line, which become the excludes below.
snapshot_dbs() { # <container>
  docker exec -i "$1" bun -e '
    import { Database } from "bun:sqlite";
    import { readdirSync, statSync, mkdirSync, rmSync } from "fs";
    import { join, dirname, relative } from "path";
    const root = "/home/maurice/.maurice", out = join(root, "backup");
    rmSync(out, { recursive: true, force: true });
    const dbs = [];
    const walk = (d, depth) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (p === out || n === "backups" || n === "logs" || n === "run" || n === "qdrant") continue;
        const s = statSync(p);
        if (s.isDirectory()) { if (depth < 4) walk(p, depth + 1); }
        else if (n.endsWith(".db") && s.size > 0) dbs.push(p);
      }
    };
    walk(root, 0);
    for (const p of dbs) {
      const rel = relative(root, p), dest = join(out, rel);
      mkdirSync(dirname(dest), { recursive: true });
      const db = new Database(p, { readonly: true });
      db.run(`VACUUM INTO ${JSON.stringify(dest)}`);
      db.close();
      const check = new Database(dest, { readonly: true }).query("PRAGMA integrity_check").get();
      if (Object.values(check)[0] !== "ok") { console.error(`integrity_check failed on ${rel}`); process.exit(1); }
      console.log(rel);
    }
  '
}

backup_one() { # <name>
  local name="$1" container="maurice-$1" volume="maurice-$1_home"
  if [ "$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null)" != running ]; then
    say "$name: container not running — skipped (its volume is not touched)"; return 1
  fi
  say "$name: snapshotting databases…"
  local live
  if ! live="$(snapshot_dbs "$container")"; then
    say "$name: ✗ database snapshot failed — nothing uploaded"; return 1
  fi
  local excludes=(--exclude /data/logs --exclude /data/run --exclude /data/app/logs \
                  --exclude /data/app/data/tmp --exclude /data/data/qdrant --exclude '/data/**/*.db-wal' \
                  --exclude '/data/**/*.db-shm' --exclude '._*' --exclude .DS_Store)
  local rel; while IFS= read -r rel; do [ -n "$rel" ] && excludes+=(--exclude "/data/$rel"); done <<<"$live"
  say "$name: uploading…"
  if restic -v "$volume:/data:ro" "$RESTIC_IMAGE" backup /data \
       --host "$container" --tag household --tag "$name" "${excludes[@]}" --quiet; then
    date -Is > "$STATE/$name.last-ok"
    say "$name: ✓ snapshot done"
  else
    say "$name: ✗ restic backup failed"; return 1
  fi
  restic "$RESTIC_IMAGE" forget --host "$container" "${KEEP[@]}" --quiet \
    || say "$name: ! forget failed (snapshots kept; prune next time)"
}

names=("$@")
if [ ${#names[@]} -eq 0 ]; then
  for f in "$DIR"/households/*.env; do
    [ -e "$f" ] || continue
    names+=("$(basename "$f" .env)")
  done
fi
[ ${#names[@]} -gt 0 ] || { say "no household on this host"; exit 0; }

# The repository is created on the first run, by whoever runs first.
restic "$RESTIC_IMAGE" cat config >/dev/null 2>&1 || restic "$RESTIC_IMAGE" init --quiet

failed=0
for n in "${names[@]}"; do backup_one "$n" || failed=$((failed + 1)); done

# Space is reclaimed once a run, for every household at once — pruning per
# household would rewrite the same pack files several times. Sundays add a
# structural check of the repository.
restic "$RESTIC_IMAGE" prune --quiet || say "! prune failed"
if [ "$(date +%u)" = 7 ]; then
  restic "$RESTIC_IMAGE" check --quiet && say "weekly check ✓" || say "! weekly check failed"
fi

say "done: ${#names[@]} household(s), $failed failed"
exit $(( failed > 0 ))
