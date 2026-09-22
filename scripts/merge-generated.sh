#!/usr/bin/env sh
# Git merge driver for generated files (`merge=cubby-generated` in
# .gitattributes; `pnpm install` registers it via scripts/install-merge-driver.sh).
# Generated outputs conflict on nearly every parallel branch because they are
# derived from inputs both sides touched. Hand-merging them is pointless: keep
# the current side (%A, already in place), record the path, and let the
# post-merge/post-rewrite hook regenerate from the merged inputs
# (scripts/regenerate-after-merge.sh).
#
#   merge-generated.sh <%P path>
set -eu
marker="$(git rev-parse --git-path cubby-generated-merges)"
printf '%s\n' "$1" >> "$marker"
exit 0
