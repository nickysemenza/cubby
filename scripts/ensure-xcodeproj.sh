#!/usr/bin/env sh
# Regenerates apps/apple/Cubby.xcodeproj from project.yml when xcodegen is
# installed. The project is gitignored, so a branch switch can leave it pointing
# at files the new tree does not have. Sourced by the post-checkout/post-merge
# hooks; a no-op on machines without xcodegen or without the apple app.
ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
SPEC="$ROOT/apps/apple/project.yml"
if [ -f "$SPEC" ] && command -v xcodegen >/dev/null 2>&1; then
  xcodegen generate --spec "$SPEC" --quiet >/dev/null 2>&1 \
    || echo "ensure-xcodeproj: xcodegen generate failed; run it by hand" >&2
fi
