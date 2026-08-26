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
DEST="${MAURICE_BACKUP_DIR:-$HOME/.maurice/backups/db}"
KEEP="${MAURICE_BACKUP_KEEP:-14}"

[[ -f "$DB" ]] || { echo "✗ no database at $DB"; exit 1; }
mkdir -p "$DEST"

stamp="$(date +%Y%m%d-%H%M%S)"
tmp="$DEST/.maurice-$stamp.db"
out="$DEST/maurice-$stamp.db.gz"

# VACUUM INTO refuses to overwrite, so the temp name must not exist.
rm -f "$tmp"
sqlite3 "$DB" "VACUUM INTO '$tmp'"

# Verify before keeping it. A snapshot nobody checked is a guess, and this one
# is cheap to check while the file is still in hand.
if ! sqlite3 "$tmp" "PRAGMA integrity_check;" | grep -qx "ok"; then
  echo "✗ snapshot failed integrity check — keeping nothing"
  rm -f "$tmp"
  exit 1
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
ls -1t "$DEST"/maurice-*.db.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while IFS= read -r f; do
  [ -n "$f" ] && rm -f "$f"
done

live="$(du -h "$DB" | cut -f1)"
snap="$(du -h "$out" | cut -f1)"
count="$(ls -1 "$DEST"/maurice-*.db.gz 2>/dev/null | wc -l | tr -d ' ')"
echo "✓ $(basename "$out")  ($live live → $snap compressed)  ${count}/${KEEP} kept"
