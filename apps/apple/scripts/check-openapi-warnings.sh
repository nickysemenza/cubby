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

# A pass is recorded under every input that decides the generator's
# diagnostics: the document, its config, the generator pin, the toolchain
# and this check. CI restores .build from main, so a PR that leaves those
# bytes unchanged skips a debug generation measured at ~45s on the hosted
# runner. Only a pass is recorded, so a warning fails every run.
PASS="$KIT/.build/check-openapi-warnings.pass"
KEY="$(
  {
    swift --version 2>&1
    shasum -a 256 "${BASH_SOURCE[0]}" "$KIT/Package.resolved" \
      "$API/openapi-generator-config.yaml" "$API/openapi.json" | cut -d' ' -f1
  } | shasum -a 256 | cut -d' ' -f1
)"
if [ -f "$PASS" ] && [ "$(cat "$PASS")" = "$KEY" ]; then
  echo "check-openapi-warnings: no generator warnings (unchanged inputs)"
  exit 0
fi

swift build --package-path "$KIT" --force-resolved-versions --disable-index-store --product swift-openapi-generator >/dev/null
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
mkdir -p "$(dirname "$PASS")"
echo "$KEY" >"$PASS"
echo "check-openapi-warnings: no generator warnings"
