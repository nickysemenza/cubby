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
# Both modes keep a stamp over every input and the committed output. An unchanged
# rerun skips generation; a changed run generates into a temporary directory and
# updates only files whose contents differ.
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
STAMP="$STAMP_DIR/$(drift_inputs | shasum -a 256 | awk '{print $1}')"
if [ -f "$STAMP" ]; then
  echo "generate-openapi.sh: inputs and output unchanged"
  exit 0
fi
OUT="$(mktemp -d)"

# The generator only warns when it silently drops a schema (a nullable union
# member, an unsupported keyword), so any warning is a hole in the client.
LOG="$(mktemp)"
cleanup() {
  rm -f "$LOG"
  rm -rf "$OUT"
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

changed=0
for f in "$OUT"/*.swift; do
  name="$(basename "$f")"
  if ! cmp -s "$COMMITTED/$name" "$f"; then
    echo "changed: apps/apple/CubbyKit/Sources/CubbyAPI/$name"
    if [ "$CHECK" = "0" ]; then cp "$f" "$COMMITTED/$name"; fi
    changed=1
  fi
done
for f in "$COMMITTED"/Types*.swift "$COMMITTED"/Client.swift; do
  [ -e "$f" ] || continue
  if [ ! -e "$OUT/$(basename "$f")" ]; then
    echo "removed: apps/apple/CubbyKit/Sources/CubbyAPI/$(basename "$f")"
    if [ "$CHECK" = "0" ]; then rm "$f"; fi
    changed=1
  fi
done
if [ "$CHECK" = "1" ] && [ "$changed" = "1" ]; then
  echo "Generated OpenAPI client is stale; run pnpm generate:api" >&2
  exit 1
fi
mkdir -p "$STAMP_DIR"
touch "$STAMP_DIR/$(drift_inputs | shasum -a 256 | awk '{print $1}')"
