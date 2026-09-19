#!/usr/bin/env bash
# Copy the Maurice system documentation from the owner's garden into the repo,
# so the server — and the container image built from it — ships a current
# snapshot for Maurice Maurice, the built-in persona that answers questions
# about Maurice (server/src/services/mauriceDocs.ts).
#
#   scripts/sync-docs.sh [garden-notes-dir]
#
# Source of truth stays in the garden (~/.maurice/gardens/candide/notes/en);
# run this after editing a maurice-*.md note, then commit docs/maurice/.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

SRC="${1:-$HOME/.maurice/gardens/candide/notes/en}"
DEST="$REPO/docs/maurice"

[[ -f "$SRC/maurice-docs.md" ]] || { echo "no maurice-docs.md in $SRC" >&2; exit 1; }

mkdir -p "$DEST"
# Only the index and the notes that hang off it (parent: maurice-docs), minus
# any marked `internal: true` — a note under the index that must not reach
# other households (the reader in mauriceDocs.ts skips them too).
kept=()
for f in "$SRC"/maurice-*.md; do
  base="$(basename "$f")"
  grep -q '^internal: true$' "$f" && continue
  if [[ "$base" == "maurice-docs.md" ]] || grep -q '^parent: maurice-docs$' "$f"; then
    cp "$f" "$DEST/$base"
    kept+=("$base")
  fi
done
# Drop snapshots of notes that left the index.
for f in "$DEST"/maurice-*.md; do
  base="$(basename "$f")"
  printf '%s\n' "${kept[@]}" | grep -qx "$base" || rm "$f"
done
echo "synced ${#kept[@]} notes into docs/maurice/"

# The manifest: what a running instance compares against to refresh its own
# copy of these notes from the published repo (server/src/services/
# mauriceDocsRefresh.ts fetches it from raw.githubusercontent.com). One entry
# per note kept above, the digest included, with the sha256 the instance
# verifies each download against. `generated_at` only moves when a note does,
# so a sync that changes nothing leaves the file — and the instances — alone.
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
else
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi
MANIFEST="$DEST/manifest.json"
entries=()
for f in "$DEST"/maurice-*.md; do
  base="$(basename "$f")"
  date="$(sed -n "s/^date: *['\"]\{0,1\}\([0-9-]*\)['\"]\{0,1\}$/\1/p" "$f" | head -1)"
  if [[ -n "$date" ]]; then date="\"$date\""; else date=null; fi
  bytes="$(wc -c < "$f" | tr -d ' ')"
  entries+=("$(printf '    { "file": "%s", "slug": "%s", "date": %s, "bytes": %s, "sha256": "%s" }' "$base" "${base%.md}" "$date" "$bytes" "$(sha256 "$f")")")
done
notes="$(printf '%s,\n' "${entries[@]}")"
notes="${notes%,*}"
write_manifest() {
  printf '{\n  "format": "maurice-docs",\n  "version": 1,\n  "generated_at": "%s",\n  "notes": [\n%s\n  ]\n}\n' "$1" "$notes"
}
generated="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [[ -f "$MANIFEST" ]]; then
  previous="$(sed -n 's/^  "generated_at": "\([^"]*\)",$/\1/p' "$MANIFEST")"
  if [[ -n "$previous" ]] && write_manifest "$previous" | cmp -s - "$MANIFEST"; then
    generated="$previous"
  fi
fi
write_manifest "$generated" > "$MANIFEST"
echo "manifest: ${#entries[@]} notes, generated $generated"

# The delta: notes newer than what the digest's `covers` map records for them,
# or absent from it. Maurice Maurice loads these in full beside the digest;
# three or four of them is the cue to rewrite the digest (see the workspace
# CLAUDE.md).
DIGEST="$DEST/maurice-digest.md"
if [[ -f "$DIGEST" ]]; then
  delta=()
  for f in "$DEST"/maurice-*.md; do
    slug="$(basename "$f" .md)"
    [[ "$slug" == "maurice-digest" || "$slug" == "maurice-docs" ]] && continue
    date="$(sed -n "s/^date: *['\"]\{0,1\}\([0-9-]*\)['\"]\{0,1\}$/\1/p" "$f" | head -1)"
    covered="$(sed -n "s/^  $slug: *['\"]\{0,1\}\([0-9-]*\)['\"]\{0,1\}$/\1/p" "$DIGEST" | head -1)"
    if [[ -z "$covered" || ( -n "$date" && "$date" > "$covered" ) ]]; then
      delta+=("${slug#maurice-}")
    fi
  done
  if (( ${#delta[@]} == 0 )); then
    echo "digest: up to date — no note newer than it"
  else
    echo "digest: ${#delta[@]} note(s) newer than it, loaded in full — ${delta[*]}"
    (( ${#delta[@]} >= 3 )) && echo "digest: time to rewrite maurice-digest.md and refresh its covers dates"
  fi
else
  echo "digest: none — Maurice Maurice loads every note in full"
fi
