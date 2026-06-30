#!/opt/homebrew/bin/bash
# Generate a kanban-style markdown summary of the Akita backlog.
# Reads frontmatter `status` and `title` from akita-backlog-*.md notes
# and outputs a grouped markdown report to stdout.

set -euo pipefail

CONTENT_DIR="${1:-$(dirname "$0")/../akita-web/src/content/notes/en}"
CONTENT_DIR="$(cd "$CONTENT_DIR" && pwd)"

declare -A STATUS_LABELS=(
  [proposed]="Proposed"
  [ready]="Ready"
  [in_progress]="In Progress"
  [review]="Review"
  [done]="Done"
)

# Ordered columns
COLUMNS=(proposed ready in_progress review done)

# Collect items per status
declare -A ITEMS

for col in "${COLUMNS[@]}"; do
  ITEMS[$col]=""
done

for file in "$CONTENT_DIR"/akita-backlog-*.md; do
  [ -f "$file" ] || continue
  slug="$(basename "$file" .md)"
  [ "$slug" = "akita-backlog" ] && continue

  # Extract title, status, and order from frontmatter (between --- markers)
  frontmatter=$(sed -n '/^---$/,/^---$/p' "$file")
  title=$(echo "$frontmatter" | grep '^title:' | sed "s/^title: *//;s/^['\"]//;s/['\"]$//")
  status=$(echo "$frontmatter" | grep '^status:' | sed 's/^status: *//')
  order=$(echo "$frontmatter" | grep '^order:' | sed 's/^order: *//' || true)
  icon=$(echo "$frontmatter" | grep '^icon:' | sed 's/^icon: *//')

  status="${status:-proposed}"
  title="${title:-$slug}"
  order="${order:-999999}"

  # Prefix with zero-padded order for sorting, separated by tab
  ITEMS[$status]+="${order}"$'\t'"- [[${slug}|${title}]]"$'\n'
done

# Output grouped markdown
echo "# Backlog Kanban"
echo ""
echo "_Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)_"
echo ""

for col in "${COLUMNS[@]}"; do
  label="${STATUS_LABELS[$col]}"
  items="${ITEMS[$col]}"
  if [ -n "$items" ]; then
    echo "## ${label}"
    echo ""
    # Sort by order (numeric, tab-separated) and strip the order prefix
    echo -n "$items" | sort -t$'\t' -k1 -n | cut -f2-
    echo ""
  fi
done
