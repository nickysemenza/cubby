#!/bin/sh
set -eu

# Uploads the local SQLite DB to Cloudflare R2 (public), compressing first.
# Uses rclone (required).
#
# To force a fresh download on Fly (clear any corrupted/partial DB), run:
#   fly ssh console -C "rm -f /data/usda.sqlite /data/usda.sqlite-wal /data/usda.sqlite-shm"
#   fly restart
# Env:
#   R2_BUCKET        - bucket name (default: usda-sqlite)
#   R2_OBJECT_KEY    - object key (default: usda.sqlite.gz)
#   R2_ACCOUNT_ID    - Cloudflare account ID (required)
#   R2_PUBLIC_BASE   - public base URL for your R2 custom domain (default: https://usda-sqlite.nickysemenza.com)
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY - R2 access keys (required)

BUCKET="${R2_BUCKET:-usda-sqlite}"
KEY="${R2_OBJECT_KEY:-usda.sqlite.gz}"
DB_PATH="${1:-data/usda.sqlite}"
ACCOUNT_ID="${R2_ACCOUNT_ID:-}"

if [ -z "$ACCOUNT_ID" ]; then
  echo "R2_ACCOUNT_ID is required (used to construct the S3 endpoint)." >&2
  exit 1
fi

if [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; then
  echo "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set to your R2 access keys." >&2
  exit 1
fi

if [ ! -f "$DB_PATH" ]; then
  echo "Local DB not found: $DB_PATH" >&2
  exit 1
fi

OUT_GZ="${DB_PATH}.gz"
echo "Compressing $DB_PATH -> $OUT_GZ"
# Show progress if 'pv' is installed; otherwise, plain gzip
SIZE=$(stat -c%s "$DB_PATH" 2>/dev/null || stat -f%z "$DB_PATH" 2>/dev/null || echo 0)
if command -v pv >/dev/null 2>&1; then
  echo "Using pv for compression progress..."
  pv -s "$SIZE" "$DB_PATH" | gzip -c > "$OUT_GZ"
else
  echo "(Tip: install 'pv' to see a progress bar)"
  gzip -c "$DB_PATH" > "$OUT_GZ"
fi

ENDPOINT="https://${ACCOUNT_ID}.r2.cloudflarestorage.com"
echo "Uploading via rclone to $BUCKET/$KEY (endpoint: $ENDPOINT) ..."
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID}"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY}"
export RCLONE_CONFIG_R2_ENDPOINT="$ENDPOINT"
export RCLONE_CONFIG_R2_REGION=auto
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
# Tune chunk size and concurrency for large files
rclone copyto "$OUT_GZ" "r2:${BUCKET}/${KEY}" \
  --s3-chunk-size 64Mi \
  --s3-upload-concurrency 8 \
  --s3-no-check-bucket \
  --no-traverse \
  --progress

PUBLIC_BASE="${R2_PUBLIC_BASE:-https://usda-sqlite.nickysemenza.com}"
URL="$PUBLIC_BASE/${KEY}"
echo
echo "Uploaded: $URL"
echo
echo "Set in fly.toml [env] or as Fly secrets:"
echo "  USDA_DB_URL=\"$URL\""
