#!/bin/bash
# Manual script to upload a snapshot to R2
# Usage: ./scripts/upload-snapshot.sh <tag-name> "<label>"

set -euo pipefail

TAG_NAME="${1:-}"
LABEL="${2:-}"

if [[ -z "$TAG_NAME" ]]; then
  echo "Usage: $0 <tag-name> \"<label>\""
  echo "Example: $0 milestone-2026-02-launch \"Initial launch\""
  exit 1
fi

if [[ -z "$LABEL" ]]; then
  LABEL="$TAG_NAME"
fi

# Check required environment variables
: "${CLOUDFLARE_ACCOUNT_ID:?Missing CLOUDFLARE_ACCOUNT_ID}"
: "${CLOUDFLARE_R2_ACCESS_KEY_ID:?Missing CLOUDFLARE_R2_ACCESS_KEY_ID}"
: "${CLOUDFLARE_R2_SECRET_ACCESS_KEY:?Missing CLOUDFLARE_R2_SECRET_ACCESS_KEY}"

R2_ENDPOINT="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
BUCKET="akita-web-snapshots"
DATE=$(date -u +%Y-%m-%d)

echo "Building site..."
npm run build

echo "Uploading snapshot to R2..."
aws s3 sync dist/ "s3://${BUCKET}/snapshots/${TAG_NAME}/" \
  --endpoint-url "$R2_ENDPOINT"

echo "Updating manifest..."
# Download existing manifest or create empty array
aws s3 cp "s3://${BUCKET}/manifest.json" manifest.json \
  --endpoint-url "$R2_ENDPOINT" 2>/dev/null || echo '[]' > manifest.json

# Add new entry
jq --arg tag "$TAG_NAME" \
   --arg date "$DATE" \
   --arg label "$LABEL" \
   '. += [{"tag": $tag, "date": $date, "label": $label, "description": ""}]' \
   manifest.json > manifest-updated.json

# Upload updated manifest
aws s3 cp manifest-updated.json "s3://${BUCKET}/manifest.json" \
  --endpoint-url "$R2_ENDPOINT"

# Clean up
rm -f manifest.json manifest-updated.json

echo ""
echo "Snapshot '$TAG_NAME' uploaded successfully!"
echo "Date: $DATE"
echo "Label: $LABEL"
echo ""
echo "Don't forget to update src/data/milestones.json and commit it."
