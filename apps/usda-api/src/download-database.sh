#!/bin/bash
set -euo pipefail

# USDA Database Download Script
# Downloads and installs USDA SQLite database (supports .sqlite and .sqlite.zst)
# Usage: download-database.sh <IGNORED_URL> <DESTINATION_PATH>

# First arg kept for backward compatibility; it is ignored now.
DEST_PATH="$2"
TEMP_DB="/tmp/.usda.sqlite"
TEMP_DL="/tmp/.usda.download"

# Colors for output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[0;33m'
readonly BLUE='\033[0;34m'
readonly NC='\033[0m' # No Color

log() {
    echo -e "${BLUE}[download-database]${NC} $1" >&2
}

error() {
    echo -e "${RED}[download-database] ERROR:${NC} $1" >&2
}

success() {
    echo -e "${GREEN}[download-database]${NC} $1" >&2
}

warn() {
    echo -e "${YELLOW}[download-database]${NC} $1" >&2
}

# Cleanup function
cleanup() {
    local exit_code=$?
    if [[ $exit_code -ne 0 ]]; then
        warn "Cleaning up temporary files due to error..."
    fi
    rm -f "$TEMP_DB" "$TEMP_DL"
    exit $exit_code
}

# Set up cleanup trap
trap cleanup EXIT

# Validate inputs
if [[ $# -ne 2 ]]; then
    error "Usage: $0 <ignored> <DESTINATION_PATH>"
    exit 1
fi

if [[ -z "$DEST_PATH" ]]; then
    error "Destination path cannot be empty"
    exit 1
fi

log "Starting database download pipeline"
log "Source: r2://${R2_BUCKET}/${R2_OBJECT_KEY}"
log "Destination: $DEST_PATH"

# Step 1: Download with rclone (direct R2 access)
log "Step 1/3: Streaming compressed DB from R2 and decompressing to volume..."
log "Using rclone (R2) + zstd for streaming decompression..."
start_time=$(date +%s)

# Validate required R2 envs
if [[ -z "${R2_BUCKET:-}" || -z "${R2_OBJECT_KEY:-}" || -z "${R2_ACCOUNT_ID:-}" || -z "${AWS_ACCESS_KEY_ID:-}" || -z "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
    error "R2 environment variables are required: R2_BUCKET, R2_OBJECT_KEY, R2_ACCOUNT_ID, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY"
    exit 1
fi

# Configure rclone for R2 on-the-fly (remote name "R2")
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

SOURCE_KEY="${R2_OBJECT_KEY}"
# Enforce compressed artifact only
if [[ ! "$SOURCE_KEY" =~ \.zst$ ]]; then
    error "R2_OBJECT_KEY must end with .zst (compressed artifact only)"
    exit 1
fi

# Prepare destination temp file on volume
dest_dir=$(dirname "$DEST_PATH")
mkdir -p "$dest_dir"
temp_dest="${DEST_PATH}.tmp"

log "Streaming and decompressing to volume temp file..."
set -o pipefail
if ! rclone cat "R2:${R2_BUCKET}/${SOURCE_KEY}" \
    --multi-thread-streams=4 \
    --s3-chunk-size=32M \
    --buffer-size=128M \
    --s3-disable-checksum \
    --timeout=10m \
    | zstd -d -T0 -q -o "$temp_dest"; then
    error "Streaming decompression failed"
    rm -f "$temp_dest" 2>/dev/null || true
    exit 1
fi
set +o pipefail

download_time=$(($(date +%s) - start_time))
# Get file size (Alpine Linux uses GNU stat)
if [ -f "$temp_dest" ]; then
    db_size=$(stat -c%s "$temp_dest" 2>/dev/null)
    if [ -n "$db_size" ] && [ "$db_size" -gt 0 ]; then
        # Calculate download+write speed
        speed_mbps=$(echo "scale=1; $db_size / $download_time / 1048576" | bc -l)
        success "Transfer+write completed in ${download_time}s ($(numfmt --to=iec "$db_size") at ${speed_mbps} MB/s)"
    else
        success "Transfer+write completed in ${download_time}s"
    fi
else
    error "Temp destination not found after completion"
    exit 1
fi

# Step 2: Atomic move to final location on volume
log "Step 2/3: Finalizing database on volume..."
move_start=$(date +%s)

if ! mv "$temp_dest" "$DEST_PATH"; then
    error "Failed to move database to final location"
    exit 1
fi

move_time=$(($(date +%s) - move_start))
success "Database finalized on volume in ${move_time}s"

# Remove any stale SQLite journal files
rm -f "${DEST_PATH}-wal" "${DEST_PATH}-shm" 2>/dev/null || true

# Final summary
total_time=$(($(date +%s) - start_time))
success "Database download pipeline completed in ${total_time}s total"
log "Final database at $DEST_PATH"

# Cleanup will happen automatically via trap
