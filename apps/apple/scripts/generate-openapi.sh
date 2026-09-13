#!/usr/bin/env bash
# Regenerates CubbyKit's typed OpenAPI client from the web app's committed spec.
#
#   generate-openapi.sh                       write into CubbyKit/Sources/CubbyAPI
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

OUT="${ARGS[0]:-$IOS/CubbyKit/Sources/CubbyAPI}"
SPEC="$ROOT/apps/web/src/lib/generated/http-openapi.gen.json"
CONFIG="$IOS/openapi/openapi-generator-config.yaml"

# The generator's build products live outside the checkout so every worktree
# shares one release build of swift-openapi-generator (a full build of it and
# its dependency graph takes minutes; `.generator` has no targets of its own,
# so different package roots reuse the same dependency artifacts).
GENERATOR_SCRATCH="${CUBBY_OPENAPI_GENERATOR_SCRATCH:-$HOME/.cache/cubby/openapi-generator-build}"
BIN="$(swift build --package-path "$IOS/.generator" --scratch-path "$GENERATOR_SCRATCH" -c release --show-bin-path)/swift-openapi-generator"
# The binary only changes when the generator package's inputs or the toolchain
# do, so a content stamp next to it decides whether to rebuild. (An mtime
# check would rebuild in every fresh worktree, whose checkout is always newer
# than the shared binary.) Force with --rebuild-generator or
# CUBBY_REBUILD_GENERATOR=1.
GENERATOR_STAMP="$BIN.inputs"
generator_inputs() {
  cat "$IOS/.generator/Package.swift" "$IOS/.generator/Package.resolved"
  swift --version 2>&1
}
if [ "$REBUILD_GENERATOR" = "1" ] \
  || [ ! -x "$BIN" ] \
  || [ "$(generator_inputs | shasum -a 256)" != "$(cat "$GENERATOR_STAMP" 2>/dev/null)" ]; then
  swift build --package-path "$IOS/.generator" --scratch-path "$GENERATOR_SCRATCH" --product swift-openapi-generator -c release >/dev/null
  generator_inputs | shasum -a 256 > "$GENERATOR_STAMP"
fi

mkdir -p "$OUT"
# CubbyAPI holds nothing but these files, so clearing them is enough; the other
# generated Swift (EntityCatalog, OperationRoutes, EntityOperations) lives in
# CubbyKit/Generated and belongs to other generators.
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
