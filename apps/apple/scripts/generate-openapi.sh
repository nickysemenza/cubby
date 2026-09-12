#!/usr/bin/env bash
# Regenerates CubbyKit's typed OpenAPI client from the web app's committed spec.
#
#   generate-openapi.sh                       write into CubbyKit/Sources/CubbyKit/Generated
#   generate-openapi.sh <out-dir>             write elsewhere (used by check-openapi-drift.sh)
#   generate-openapi.sh --rebuild-generator   force a rebuild of the generator binary first
#     (also settable via CUBBY_REBUILD_GENERATOR=1); may be combined with <out-dir>
#
# The spec is read straight from apps/web (no copy, no symlink) so there is one
# source of truth; the committed Swift output is what `swift build` compiles.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
IOS="$ROOT/apps/apple"

REBUILD_GENERATOR=0
if [ "${CUBBY_REBUILD_GENERATOR:-}" = "1" ]; then
  REBUILD_GENERATOR=1
fi
ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--rebuild-generator" ]; then
    REBUILD_GENERATOR=1
  else
    ARGS+=("$arg")
  fi
done

OUT="${ARGS[0]:-$IOS/CubbyKit/Sources/CubbyKit/Generated}"
SPEC="$ROOT/apps/web/src/lib/generated/http-openapi.gen.json"
CONFIG="$IOS/openapi/openapi-generator-config.yaml"

GENERATOR_PKG_RESOLVED="$IOS/.generator/Package.resolved"
GENERATOR_PKG_SWIFT="$IOS/.generator/Package.swift"
BIN="$(swift build --package-path "$IOS/.generator" -c release --show-bin-path)/swift-openapi-generator"
# Rebuilding the generator (a full release build of swift-openapi-generator and
# its dependency graph) takes real time and its output only changes when the
# generator's own package inputs change. Skip the rebuild when the binary is
# already newer than both Package.swift and Package.resolved; force it with
# --rebuild-generator or CUBBY_REBUILD_GENERATOR=1 (e.g. after a toolchain bump
# that the mtime check can't see).
if [ "$REBUILD_GENERATOR" = "1" ] \
  || [ ! -x "$BIN" ] \
  || [ ! "$BIN" -nt "$GENERATOR_PKG_RESOLVED" ] \
  || [ ! "$BIN" -nt "$GENERATOR_PKG_SWIFT" ]; then
  swift build --package-path "$IOS/.generator" --product swift-openapi-generator -c release >/dev/null
fi

mkdir -p "$OUT"
# Only the generator's own outputs are replaced; EntityCatalog.swift (from
# `pnpm entity:generate`) lives in the same directory and is left alone.
rm -f "$OUT"/Types*.swift "$OUT"/Client.swift
# The generator only warns when it silently drops a schema (a nullable union
# member, an unsupported keyword), so any warning is a hole in the client.
LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT
"$BIN" generate --mode types --mode client \
  --config "$CONFIG" \
  --output-directory "$OUT" \
  "$SPEC" >/dev/null 2>"$LOG"
if grep -q 'warning' "$LOG"; then
  echo "swift-openapi-generator emitted warnings; the document must not lose schemas:" >&2
  grep 'warning' "$LOG" >&2
  exit 1
fi
