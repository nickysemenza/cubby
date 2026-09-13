#!/usr/bin/env bash
# Fails when the committed generated client no longer matches the spec.
#
# Generation is a tmpdir + diff so the tree is never touched and a generated
# file missing from the commit still fails. A stamp over every
# input — the spec, the generator config, the generator binary itself, and the
# committed output — lets an unchanged rerun (the common pre-push case) exit
# without regenerating; it is written only after a clean diff.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
COMMITTED="$HERE/../CubbyKit/Sources/CubbyAPI"
SPEC="$ROOT/apps/web/src/lib/generated/http-openapi.gen.json"
CONFIG="$HERE/../openapi/openapi-generator-config.yaml"
GENERATOR_SCRATCH="${CUBBY_OPENAPI_GENERATOR_SCRATCH:-$HOME/.cache/cubby/openapi-generator-build}"
STAMP_DIR="$GENERATOR_SCRATCH/drift-clean"

drift_inputs() {
  shasum -a 256 "$SPEC" "$CONFIG" "$HERE/generate-openapi.sh" | awk '{print $1}'
  git -C "$ROOT" hash-object "$COMMITTED"/*.swift
  # A rebuilt generator (toolchain or package bump) invalidates a clean stamp.
  # The scratch dir does not exist before the first generator build.
  if [ -d "$GENERATOR_SCRATCH" ]; then
    find "$GENERATOR_SCRATCH" -maxdepth 3 -name 'swift-openapi-generator.inputs' -exec cat {} +
  fi
}
STAMP="$STAMP_DIR/$(drift_inputs | shasum -a 256 | awk '{print $1}')"
if [ -f "$STAMP" ]; then
  echo "check-openapi-drift: inputs unchanged since the last clean check"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
"$HERE/generate-openapi.sh" "$TMP"
status=0
for f in "$TMP"/*.swift; do
  name="$(basename "$f")"
  if ! diff -u "$COMMITTED/$name" "$f"; then status=1; fi
done
if [ "$status" -ne 0 ]; then
  echo "Generated OpenAPI client is stale; run apps/apple/scripts/generate-openapi.sh" >&2
  exit "$status"
fi
# Recomputed: generate-openapi.sh may have just rebuilt the generator.
mkdir -p "$STAMP_DIR"
touch "$STAMP_DIR/$(drift_inputs | shasum -a 256 | awk '{print $1}')"
