#!/usr/bin/env sh
# Run by the post-merge and post-rewrite hooks. When scripts/merge-generated.sh
# auto-resolved a generated file during this merge/rebase, regenerate every
# generated surface from the merged inputs so the kept side is not left stale.
# The regenerated files are left for you to commit; Validation's
# `generate:check` and the Apple lane's OpenAPI drift check fail if they are not.
set -eu
ROOT="$(git rev-parse --show-toplevel)"
marker="$(git rev-parse --git-path cubby-generated-merges)"
[ -f "$marker" ] || exit 0
paths="$(sort -u "$marker")"
rm -f "$marker"
echo "cubby-generated: regenerating after auto-resolving:"
printf '  %s\n' $paths
if [ ! -d "$ROOT/node_modules" ]; then
  echo "cubby-generated: node_modules missing; run \`pnpm install && pnpm generate\` and commit the result" >&2
  exit 0
fi
(cd "$ROOT" && pnpm run generate) || {
  echo "cubby-generated: \`pnpm generate\` failed; fix the inputs, rerun it, and commit the result" >&2
  exit 0
}
# CubbyAPI is swift-openapi-generator output over the (now regenerated) spec.
if printf '%s\n' $paths | grep -q '^apps/apple/CubbyKit/Sources/CubbyAPI/\|http-openapi.gen.json$'; then
  if command -v swift >/dev/null 2>&1; then
    "$ROOT/apps/apple/scripts/generate-openapi.sh" \
      || echo "cubby-generated: apps/apple/scripts/generate-openapi.sh failed; rerun it" >&2
  else
    echo "cubby-generated: no Swift toolchain; run apps/apple/scripts/generate-openapi.sh on macOS" >&2
  fi
fi
if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
  echo "cubby-generated: regenerated files differ from HEAD; review and commit them:"
  git -C "$ROOT" status --short
fi
