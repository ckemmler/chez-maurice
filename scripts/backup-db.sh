#!/usr/bin/env bash
# Snapshot maurice.db, consistently, and keep the last N.
#
# maurice.db is the single point of failure of the whole install: conversations,
# personas, API keys, note shares. The gardens are versioned per member; this is
# not, and nothing else holds a copy of it.
#
# `cp` is not a backup here. The database runs in WAL mode under a live server,
# so a plain file copy can catch a half-written page, or a .db whose -wal no
# longer matches — a file that looks fine until the day it is needed. VACUUM INTO
# takes a consistent snapshot of a live database and compacts it on the way out.
#
# This lands beside the database, on the same disk, which protects against the
# likely failures — a bad migration, a mistaken delete, corruption — and not at
# all against losing the disk. What makes it more than that is Time Machine:
# these snapshots are internally consistent, so the copy Time Machine carries
# off is restorable, which a copy of the live database might not be.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

DB="${MAURICE_DB:-$HOME/.maurice/maurice.db}"
# life.db holds the rest of what a household would hate to lose — health,
# tasks, reading positions, highlights, dossiers — and until 2026-09-13 it was
# not backed up at all (it was still called akita.db, and this script only knew
# maurice.db). Same treatment, its own name in the snapshot files.
LIFE_DB="${MAURICE_LIFE_DB:-$HOME/.maurice/data/life.db}"
DEST="${MAURICE_BACKUP_DIR:-$HOME/.maurice/backups/db}"
KEEP="${MAURICE_BACKUP_KEEP:-14}"

mkdir -p "$DEST"
stamp="$(date +%Y%m%d-%H%M%S)"

# snapshot <db file> <name prefix> — a consistent copy, verified, compressed,
# pruned to KEEP. Fails the run if the copy does not check out.
snapshot() {
  local db="$1" name="$2"
  local tmp="$DEST/.$name-$stamp.db"
  local out="$DEST/$name-$stamp.db.gz"

  # VACUUM INTO refuses to overwrite, so the temp name must not exist.
  rm -f "$tmp"
  sqlite3 "$db" "VACUUM INTO '$tmp'"

  # Verify before keeping it. A snapshot nobody checked is a guess, and this one
  # is cheap to check while the file is still in hand.
  if ! sqlite3 "$tmp" "PRAGMA integrity_check;" | grep -qx "ok"; then
    echo "✗ $name: snapshot failed integrity check — keeping nothing"
    rm -f "$tmp"
    return 1
  fi

  gzip -c "$tmp" > "$out"
  rm -f "$tmp"

  # Prune oldest first, keeping KEEP. Never touches anything but our own pattern.
  #
  # A while-read loop, not mapfile: launchd runs this through /bin/bash, which on
  # macOS is still 3.2, where mapfile does not exist. It failed there and nowhere
  # else — an interactive run picks up Homebrew's bash 5 — so the snapshot was
  # taken, the prune silently never ran, and the only symptom would have been a
  # disk filling up months later.
  ls -1t "$DEST"/"$name"-*.db.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while IFS= read -r f; do
    [ -n "$f" ] && rm -f "$f"
  done

  local live snap count
  live="$(du -h "$db" | cut -f1)"
  snap="$(du -h "$out" | cut -f1)"
  count="$(ls -1 "$DEST"/"$name"-*.db.gz 2>/dev/null | wc -l | tr -d ' ')"
  echo "✓ $(basename "$out")  ($live live → $snap compressed)  ${count}/${KEEP} kept"
}

[[ -f "$DB" ]] || { echo "✗ no database at $DB"; exit 1; }
snapshot "$DB" maurice

# The rename happens on the server's first start after the change; until then
# the file may still carry the old name. Back up whichever exists.
if [[ -f "$LIFE_DB" ]]; then
  snapshot "$LIFE_DB" life
elif [[ -f "$(dirname "$LIFE_DB")/akita.db" ]]; then
  snapshot "$(dirname "$LIFE_DB")/akita.db" life
else
  echo "· no life.db at $LIFE_DB — skipped"
fi
