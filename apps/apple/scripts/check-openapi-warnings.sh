#!/usr/bin/env bash
# Fails when swift-openapi-generator warns about the generated OpenAPI document.
# The generator only warns when it silently drops a schema (a nullable union
# member, an unsupported keyword), so any warning is a hole in the CubbyAPI
# client that the build plugin would otherwise let through. Runs the same
# pinned generator the `OpenAPIGenerator` plugin uses (a CubbyKit dependency)
# over `pnpm generate`'s openapi.json and config.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
KIT="$ROOT/apps/apple/CubbyKit"
API="$KIT/Sources/CubbyAPI"

swift build --package-path "$KIT" --force-resolved-versions --product swift-openapi-generator >/dev/null
BIN="$(swift build --package-path "$KIT" --show-bin-path)/swift-openapi-generator"

OUT="$(mktemp -d)"
LOG="$(mktemp)"
trap 'rm -rf "$OUT" "$LOG"' EXIT
"$BIN" generate --mode types --mode client \
  --config "$API/openapi-generator-config.yaml" \
  --output-directory "$OUT" \
  "$API/openapi.json" >/dev/null 2>"$LOG"
if grep -qi 'warning' "$LOG"; then
  echo "swift-openapi-generator emitted warnings; the document must not lose schemas:" >&2
  grep -i 'warning' "$LOG" >&2
  exit 1
fi
echo "check-openapi-warnings: no generator warnings"
