#!/usr/bin/env bash
# Fails when the committed generated client no longer matches the spec.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMITTED="$HERE/../CubbyKit/Sources/CubbyKit/Generated"
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
fi
exit "$status"
