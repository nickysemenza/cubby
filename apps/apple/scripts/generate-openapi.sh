#!/usr/bin/env bash
# Regenerates CubbyKit's typed OpenAPI client from the web app's committed spec.
#
#   generate-openapi.sh                       write into CubbyKit/Sources/CubbyAPI
#   generate-openapi.sh --check               fail when the committed client no longer matches
#                                             the spec (generation into a tmpdir + diff, so the
#                                             tree is never touched and a missing file fails too)
#   generate-openapi.sh --rebuild-generator   force a rebuild of the generator binary first
#     (also settable via CUBBY_REBUILD_GENERATOR=1); may be combined with --check
#
# The spec is read straight from apps/web (no copy, no symlink) so there is one
# source of truth; the committed Swift output is what `swift build` compiles.
#
# `--check` keeps a stamp over every input — the spec, the generator config, this
# script, the generator binary, and the committed output — so an unchanged rerun
# (the common pre-push case) exits without regenerating; it is written only after
# a clean diff.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
IOS="$ROOT/apps/apple"

REBUILD_GENERATOR=0
if [ "${CUBBY_REBUILD_GENERATOR:-}" = "1" ]; then
  REBUILD_GENERATOR=1
fi
CHECK=0
for arg in "$@"; do
  case "$arg" in
    --rebuild-generator) REBUILD_GENERATOR=1 ;;
    --check) CHECK=1 ;;
    *) echo "generate-openapi.sh: unknown argument $arg" >&2; exit 2 ;;
  esac
done

COMMITTED="$IOS/CubbyKit/Sources/CubbyAPI"
SPEC="$ROOT/apps/web/src/lib/generated/http-openapi.gen.json"
CONFIG="$IOS/openapi/openapi-generator-config.yaml"

# The generator's build products live outside the checkout so every worktree
# shares one release build of swift-openapi-generator (a full build of it and
# its dependency graph takes minutes; `.generator` has no targets of its own,
# so different package roots reuse the same dependency artifacts).
GENERATOR_SCRATCH="${CUBBY_OPENAPI_GENERATOR_SCRATCH:-$HOME/.cache/cubby/openapi-generator-build}"
# On CI, .github/actions/setup-apple-tools pins CUBBY_OPENAPI_GENERATOR_BIN to
# a small directory it caches independently of the scratch tree (just the
# binary and its `.inputs` stamp below). On a warm cache this must NOT call
# `swift build --show-bin-path`: that call alone loads the package graph and
# fetches swift-openapi-generator, ~10s+, even when nothing needs rebuilding.
# Locally, and on a cold CI cache, BIN is derived from --show-bin-path as
# before.
if [ -n "${CUBBY_OPENAPI_GENERATOR_BIN:-}" ]; then
  BIN="$CUBBY_OPENAPI_GENERATOR_BIN"
else
  BIN="$(swift build --package-path "$IOS/.generator" --scratch-path "$GENERATOR_SCRATCH" -c release --show-bin-path)/swift-openapi-generator"
fi
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
  if [ -n "${CUBBY_OPENAPI_GENERATOR_BIN:-}" ]; then
    # `--show-bin-path` alone doesn't build (verified: it only resolves/prints
    # the path), but here it runs right after a real build with nothing left
    # to resolve, so it is cheap. Querying it instead of guessing a fixed
    # `<arch>-apple-macosx/release` path keeps this portable across
    # toolchain/build-system layouts.
    built_bin="$(swift build --package-path "$IOS/.generator" --scratch-path "$GENERATOR_SCRATCH" -c release --show-bin-path)/swift-openapi-generator"
    if [ "$built_bin" != "$BIN" ]; then
      mkdir -p "$(dirname "$BIN")"
      cp -f "$built_bin" "$BIN"
    fi
  fi
  generator_inputs | shasum -a 256 > "$GENERATOR_STAMP"
fi

drift_inputs() {
  shasum -a 256 "$SPEC" "$CONFIG" "${BASH_SOURCE[0]}" "$GENERATOR_STAMP" | awk '{print $1}'
  git -C "$ROOT" hash-object "$COMMITTED"/*.swift
}
STAMP_DIR="$GENERATOR_SCRATCH/drift-clean"
if [ "$CHECK" = "1" ]; then
  STAMP="$STAMP_DIR/$(drift_inputs | shasum -a 256 | awk '{print $1}')"
  if [ -f "$STAMP" ]; then
    echo "generate-openapi.sh --check: inputs unchanged since the last clean check"
    exit 0
  fi
  OUT="$(mktemp -d)"
else
  OUT="$COMMITTED"
  mkdir -p "$OUT"
  # CubbyAPI holds nothing but these files, so clearing them is enough; the other
  # generated Swift (EntityCatalog, OperationRoutes, EntityOperations) lives in
  # CubbyKit/Generated and belongs to other generators.
  rm -f "$OUT"/Types*.swift "$OUT"/Client.swift
fi

# The generator only warns when it silently drops a schema (a nullable union
# member, an unsupported keyword), so any warning is a hole in the client.
LOG="$(mktemp)"
cleanup() {
  rm -f "$LOG"
  if [ "$CHECK" = "1" ]; then rm -rf "$OUT"; fi
}
trap cleanup EXIT
"$BIN" generate --mode types --mode client \
  --config "$CONFIG" \
  --output-directory "$OUT" \
  "$SPEC" >/dev/null 2>"$LOG"
if grep -q 'warning' "$LOG"; then
  echo "swift-openapi-generator emitted warnings; the document must not lose schemas:" >&2
  grep 'warning' "$LOG" >&2
  exit 1
fi

if [ "$CHECK" = "1" ]; then
  status=0
  for f in "$OUT"/*.swift; do
    name="$(basename "$f")"
    if ! diff -u "$COMMITTED/$name" "$f"; then status=1; fi
  done
  if [ "$status" -ne 0 ]; then
    echo "Generated OpenAPI client is stale; run apps/apple/scripts/generate-openapi.sh" >&2
    exit "$status"
  fi
  mkdir -p "$STAMP_DIR"
  touch "$STAMP_DIR/$(drift_inputs | shasum -a 256 | awk '{print $1}')"
fi
