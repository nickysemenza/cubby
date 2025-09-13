#!/bin/sh
set -eu

DB_PATH="${DATABASE_PATH:-/data/usda.sqlite}"
DATA_DIR="$(dirname "$DB_PATH")"

echo "[entrypoint] Using DATABASE_PATH=$DB_PATH"

# Ensure data directory exists
mkdir -p "$DATA_DIR"

NEED_DOWNLOAD=0
if [ ! -f "$DB_PATH" ]; then
  NEED_DOWNLOAD=1
fi

if [ "$NEED_DOWNLOAD" -eq 1 ]; then
  if [ -z "${USDA_DB_URL:-}" ]; then
    echo "[entrypoint] ERROR: Database not found at $DB_PATH and USDA_DB_URL is not set." >&2
    echo "[entrypoint] Set USDA_DB_URL to a public snapshot (e.g., https://usda-sqlite.nickysemenza.com/usda.sqlite.gz)" >&2
    exit 1
  fi
  echo "[entrypoint] Database missing; attempting download from $USDA_DB_URL"
  tmp_gz="$DATA_DIR/.usda.sqlite.gz"
  tmp_db="$DATA_DIR/.usda.sqlite.tmp"
  # Download (concise progress by default; set DOWNLOAD_QUIET=1 to silence)
  WGET_FLAGS=${WGET_FLAGS:---progress=dot:mega}
  if [ "${DOWNLOAD_QUIET:-0}" = "1" ]; then
    WGET_FLAGS="-q"
  fi
  if ! wget $WGET_FLAGS -O "$tmp_gz" "$USDA_DB_URL"; then
    echo "[entrypoint] ERROR: download failed from $USDA_DB_URL" >&2
    rm -f "$tmp_gz" || true
    exit 1
  fi
  echo "[entrypoint] Decompressing gzip to $DB_PATH"
  if ! gunzip -c "$tmp_gz" > "$tmp_db"; then
    echo "[entrypoint] ERROR: gunzip failed (expected a .gz file)" >&2
    rm -f "$tmp_gz" "$tmp_db" 2>/dev/null || true
    exit 1
  fi
  # No validation: trust the downloaded gzip
  # Atomic move into place
  mv -f "$tmp_db" "$DB_PATH"
  rm -f "$tmp_gz" 2>/dev/null || true
  # Remove any stale journal files
  rm -f "$DB_PATH-wal" "$DB_PATH-shm" 2>/dev/null || true
fi

# Ensure ownership for WAL/SHM writes
if [ "$(id -u)" = "0" ]; then
  chown -R 1001:1001 "$DATA_DIR" || true
fi

# Drop privileges to nodejs user (uid:gid 1001:1001)
exec su-exec 1001:1001 "$@"
