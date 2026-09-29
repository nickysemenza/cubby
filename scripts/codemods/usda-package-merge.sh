#!/usr/bin/env sh
# Repoints imports after `@cubby/usda-schemas` and `@cubby/usda-contract` merged
# into `@cubby/usda` (schemas at `.`, the ts-rest contract at `./contract`).
# Idempotent; portable across BSD (macOS) and GNU sed. Run from the repo root
# after merging any branch that still imports the old package names:
#
#   sh scripts/codemods/usda-package-merge.sh
#
# Contract first: `usda-schemas` -> `usda` must not touch `usda-contract`.
# package.json and knip.json are not rewritten (a bare text swap would corrupt
# dependency entries); the script reports leftovers and fails instead.
set -eu

suffix=.usda-merge.bak

grep -rlE '@cubby/usda-(contract|schemas)' apps packages scripts \
  --include='*.ts' --include='*.tsx' --include='*.mts' --include='*.cts' \
  --include='*.js' --include='*.mjs' --include='*.md' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.wrangler \
  --exclude-dir=codemods 2>/dev/null |
  while IFS= read -r file; do
    sed -i"$suffix" \
      -e 's#@cubby/usda-contract#@cubby/usda/contract#g' \
      -e 's#@cubby/usda-schemas#@cubby/usda#g' "$file"
    rm -f "$file$suffix"
  done || true

leftovers=$(grep -rlE '@cubby/usda-(contract|schemas)|packages/usda-(contract|schemas)' \
  apps packages scripts knip.json package.json README.md docs \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=codemods \
  --exclude=pnpm-lock.yaml --exclude=todos.md '--exclude=*.tsbuildinfo' 2>/dev/null || true)
if [ -n "$leftovers" ]; then
  echo "usda-package-merge: old package names remain (edit by hand):" >&2
  echo "$leftovers" >&2
  exit 1
fi
