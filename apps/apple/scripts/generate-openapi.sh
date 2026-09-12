#!/usr/bin/env bash
# Regenerates CubbyKit's typed OpenAPI client from the web app's committed spec.
#
#   generate-openapi.sh            write into CubbyKit/Sources/CubbyKit/Generated
#   generate-openapi.sh <out-dir>  write elsewhere (used by check-openapi-drift.sh)
#
# The spec is read straight from apps/web (no copy, no symlink) so there is one
# source of truth; the committed Swift output is what `swift build` compiles.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
IOS="$ROOT/apps/apple"
OUT="${1:-$IOS/CubbyKit/Sources/CubbyKit/Generated}"
SPEC="$ROOT/apps/web/src/lib/generated/http-openapi.gen.json"
CONFIG="$IOS/openapi/openapi-generator-config.yaml"

swift build --package-path "$IOS/.generator" --product swift-openapi-generator -c release >/dev/null
BIN="$(swift build --package-path "$IOS/.generator" -c release --show-bin-path)/swift-openapi-generator"

mkdir -p "$OUT"
# Only the generator's own outputs are replaced; EntityCatalog.swift (from
# `pnpm entity:generate`) lives in the same directory and is left alone.
rm -f "$OUT"/Types*.swift "$OUT"/Client.swift
"$BIN" generate --mode types --mode client \
  --config "$CONFIG" \
  --output-directory "$OUT" \
  "$SPEC" >/dev/null
