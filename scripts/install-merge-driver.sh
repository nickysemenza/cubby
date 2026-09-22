#!/usr/bin/env sh
# Registers the `cubby-generated` merge driver named in .gitattributes. Git
# config is not versioned, so `pnpm install` (the `prepare` script) runs this;
# without it, generated files conflict like any other text file.
set -eu
git rev-parse --git-dir >/dev/null 2>&1 || exit 0
git config merge.cubby-generated.name "Cubby generated file (regenerated after merge)"
git config merge.cubby-generated.driver "sh scripts/merge-generated.sh %P"
