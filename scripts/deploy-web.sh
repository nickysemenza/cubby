#!/usr/bin/env bash
set -euo pipefail

: "${PRODUCTION_DIRECT_DATABASE_URL:?Production deployment needs PRODUCTION_DIRECT_DATABASE_URL}"
args=(--target=production)
if [[ -n "${PRODUCTION_MIGRATION_THROUGH:-}" ]]; then
  args+=("--through=$PRODUCTION_MIGRATION_THROUGH")
fi
pnpm --filter @cubby/web db:migrate "${args[@]}"

# A migration can outlive a newer main push, just as the build can.
current="$(git ls-remote origin refs/heads/main | cut -f1)"
[[ -n "$current" ]] || { echo "::error::Could not resolve refs/heads/main"; exit 1; }
if [[ "$current" != "$GITHUB_SHA" ]]; then
  echo "::notice::Skipping stale deployment for $GITHUB_SHA; main is $current"
  exit 0
fi
pnpm --filter @cubby/web exec wrangler deploy --config dist/server/wrangler.json
