#!/usr/bin/env bash
# Run Maurice in the Linux container, beside the macOS install.
#
# This is the mirror of scripts/service.sh (launchd, macOS, production today).
# Neither one knows about the other, and that is the point: the Linux port is
# validated while the Mac keeps serving. The container is reached on the offset
# ports — the API on :13001, not :3001.
#
#   scripts/container.sh build            build the image
#   scripts/container.sh seed [--force]   copy the Mac's data into the volume
#   scripts/container.sh up               start (builds if needed)
#   scripts/container.sh down             stop, keeping the volumes
#   scripts/container.sh restart [svc]    restart a supervised process
#   scripts/container.sh status           what is running, inside and out
#   scripts/container.sh logs [svc]       follow the logs
#   scripts/container.sh shell            a shell inside the container
#   scripts/container.sh nuke             stop AND delete the volumes
#
# SAFETY: nothing here ever writes to ~/.maurice. `seed` reads it — taking
# consistent snapshots of the live SQLite databases with VACUUM INTO rather than
# copying files out from under a running server — and pours the copy into a
# named volume. The container is never pointed at the live data: server/src/db.ts
# migrates the schema at startup, so that would rewrite production.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

# OrbStack's CLI shims are not on a launchd/interactive PATH by default.
export PATH="$HOME/.orbstack/bin:$PATH"

COMPOSE_DIR="$REPO/infra/container"
PROJECT="maurice"
HOME_VOLUME="${PROJECT}_home"
# The corpus vector store lives in the repo tree, not the data dir, so it needs
# its own volume and its own seeding pass.
CORPUS_VOLUME="${PROJECT}_corpus-data"
CORPUS_SRC="$REPO/tools/corpus/data"

command -v docker >/dev/null 2>&1 || {
  echo "✗ docker not found. Start OrbStack (or add ~/.orbstack/bin to PATH)."
  exit 1
}

# Two optional overlays, each added only when what it mounts actually exists —
# independently, because a checkout can have one without the other. Both mount a
# host directory at the identical absolute path inside the container, so no path
# stored on the host (a symlink target, a database row) has to be rewritten.
COMPOSE_FILES=(-f "$COMPOSE_DIR/compose.yml")

# 1. The private `maurice-web` sibling repo, which this checkout's gitignored
#    symlinks point into. See compose.overlay-web.yml.
if WEB_OVERLAY="$(cd "$REPO/../maurice-web" 2>/dev/null && pwd)"; then
  export MAURICE_WEB_OVERLAY="$WEB_OVERLAY"
  COMPOSE_FILES+=(-f "$COMPOSE_DIR/compose.overlay-web.yml")
fi

# 2. The private `maurice-tools` sibling repo, which thirteen entries under
#    tools/ symlink into. See compose.overlay-tools.yml.
if TOOLS_OVERLAY="$(cd "$REPO/../maurice-tools" 2>/dev/null && pwd)"; then
  export MAURICE_TOOLS_OVERLAY="$TOOLS_OVERLAY"
  COMPOSE_FILES+=(-f "$COMPOSE_DIR/compose.overlay-tools.yml")
fi

# 3. The Calibre library. Its location is a row in maurice.db, which is also
#    what the container reads from its seeded copy — so ask the database rather
#    than guessing, and mount whatever it names.
CALIBRE_LIB="$(sqlite3 "file:$HOME/.maurice/maurice.db?mode=ro" \
  "SELECT library_root FROM calibre_libraries WHERE is_default = 1 LIMIT 1;" 2>/dev/null || true)"
if [[ -n "$CALIBRE_LIB" && -d "$CALIBRE_LIB" ]]; then
  export MAURICE_CALIBRE_LIBRARY="$CALIBRE_LIB"
  COMPOSE_FILES+=(-f "$COMPOSE_DIR/compose.overlay-calibre.yml")
fi

dc() { docker compose "${COMPOSE_FILES[@]}" "$@"; }
# supervisorctl inside the running container, for per-process control.
sup() { dc exec -T maurice supervisorctl -c /etc/supervisor/conf.d/maurice.conf "$@"; }

# ── seed ─────────────────────────────────────────────────────────────────────

volume_populated() {
  docker run --rm -v "$HOME_VOLUME:/v" busybox \
    sh -c '[ -n "$(ls -A /v 2>/dev/null)" ]' 2>/dev/null
}

# Snapshot every database `find` turns up, consistently. A plain copy of a live
# WAL-mode database can catch a half-written page, or a .db whose -wal no longer
# matches — the same reason scripts/backup-db.sh uses VACUUM INTO. The snapshot
# is checkpointed, so no -wal / -shm needs to travel with it.
#
# mode=ro is the belt to the braces: VACUUM INTO only reads the source, but a
# read-write handle may still checkpoint a WAL on close, and this script's whole
# promise is that it leaves the Mac's files untouched.
snapshot_dbs() { # <source root> <stage dir> <find args…>
  local root="$1" stage="$2"; shift 2
  local db rel
  while IFS= read -r db; do
    rel="${db#$root/}"
    mkdir -p "$stage/$(dirname "$rel")"
    if sqlite3 "file:$db?mode=ro" "VACUUM INTO '$stage/$rel'" 2>/dev/null; then
      echo "  ✓ $rel ($(du -h "$stage/$rel" | cut -f1))"
    else
      # An empty placeholder file is not a database; VACUUM fails and that is
      # fine — copy it as-is so the layout still matches.
      cp "$db" "$stage/$rel"
      echo "  · $rel (copied as-is)"
    fi
  done < <(find "$root" "$@")
}

cmd_seed() {
  local force=0
  [[ "${1:-}" == "--force" ]] && force=1

  local src="$HOME/.maurice"
  [[ -d "$src" ]] || { echo "✗ no $src to seed from"; exit 1; }

  # The volume has to exist before we can write to it; `up --no-start` creates
  # it without running anything.
  dc up --no-start >/dev/null 2>&1 || true

  if volume_populated && (( ! force )); then
    echo "• $HOME_VOLUME already holds data — refusing to overwrite."
    echo "  Re-run with --force to replace it, or 'nuke' to start clean."
    exit 0
  fi

  # Not `local`: the EXIT trap fires after the function has returned, when a
  # local would already be out of scope — and `set -u` then aborts the cleanup.
  SEED_STAGE="$(mktemp -d "${TMPDIR:-/tmp}/maurice-seed.XXXXXX")"
  trap 'rm -rf "${SEED_STAGE:-}"' EXIT
  local stage="$SEED_STAGE"

  echo "→ snapshotting databases"
  snapshot_dbs "$src" "$stage" -maxdepth 2 -name '*.db' -not -path "$src/backups/*"

  # 2. Everything else. backups/ is 350 MB of snapshots the container has no use
  #    for; logs/ and run/ are per-install; data/qdrant is 385 MB left over from
  #    the Qdrant era — the corpus moved to sqlite-vec, whose per-member DBs
  #    travel with the rest of the data dir like any other file.
  # COPYFILE_DISABLE: macOS tar otherwise emits an AppleDouble `._name` sidecar
  # for every file carrying extended attributes. They are invisible on macOS and
  # very much not on Linux — Astro's glob loader read ._maurice.md as a note with
  # no title and refused to start the garden engine.
  echo "→ copying gardens, images, files, uploads…"
  COPYFILE_DISABLE=1 tar -C "$src" -cf - \
      --exclude='backups' --exclude='logs' --exclude='run' \
      --exclude='data/qdrant' \
      --exclude='._*' --exclude='.DS_Store' \
      --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' \
      . \
    | docker run --rm -i -v "$HOME_VOLUME:/dest" busybox tar -xf - -C /dest

  echo "→ installing the database snapshots"
  COPYFILE_DISABLE=1 tar -C "$stage" -cf - . \
    | docker run --rm -i -v "$HOME_VOLUME:/dest" busybox tar -xf - -C /dest

  # 3. The corpus vector store, which lives in the repo tree rather than the data
  #    dir (`store.path` defaults to tools/corpus/data/vectors). Its own volume,
  #    so the container and the Mac stop writing to the same SQLite files through
  #    the bind mount — and its own snapshot pass, so semantic search actually
  #    works in the container instead of quietly returning nothing.
  if [[ -d "$CORPUS_SRC" ]]; then
    echo "→ snapshotting the corpus vector store ($(du -sh "$CORPUS_SRC" | cut -f1))"
    local cstage="$stage/.corpus"; mkdir -p "$cstage"
    snapshot_dbs "$CORPUS_SRC" "$cstage" -name '*.db'
    COPYFILE_DISABLE=1 tar -C "$cstage" -cf - . \
      | docker run --rm -i -v "$CORPUS_VOLUME:/dest" busybox tar -xf - -C /dest
  fi

  echo "✓ seeded $HOME_VOLUME from a copy of $src (which was not modified)"
}

# ── the rest ─────────────────────────────────────────────────────────────────

cmd_status() {
  echo "── containers ──"
  dc ps
  echo
  echo "── processes inside ──"
  # supervisorctl exits non-zero whenever any program is not RUNNING, and one
  # never is: `gardens` is a one-shot that starts the other members' engines and
  # exits. EXITED there is success, so the exit code says nothing useful.
  sup status || true
  echo
  echo "── the macOS install, for comparison ──"
  "$REPO/scripts/service.sh" status 2>/dev/null || echo "(service.sh unavailable)"
}

case "${1:-}" in
  build)   shift; dc build "$@" ;;
  seed)    shift; cmd_seed "$@" ;;
  up)      shift; dc up -d --build "$@"; echo; echo "→ API on http://localhost:13001" ;;
  down)    shift; dc down "$@" ;;
  restart) shift; if [[ -n "${1:-}" ]]; then sup restart "$1"; else dc restart; fi ;;
  status|ps) cmd_status ;;
  logs)    shift; if [[ -n "${1:-}" ]]; then dc logs -f maurice | grep --line-buffered -i "$1"; else dc logs -f; fi ;;
  shell)   dc exec maurice bash ;;
  nuke)    dc down -v; echo "✓ containers and volumes removed (~/.maurice untouched)" ;;
  *)
    sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
