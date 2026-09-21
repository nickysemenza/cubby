#!/usr/bin/env bash
# Ensures CubbyFFI.xcframework/the UniFFI shim are current and regenerates
# Cubby.xcodeproj from apps/apple/project.yml. Extracted from
# scripts/apple-check.sh so its `full`/`app`/`ci` modes and anything else
# that needs a ready-to-build checkout share one path. Run from the
# workspace root.
set -euo pipefail

# The xcframework + shim come from the Nx cache when the Rust tree is
# unchanged; a stale committed shim shows up as a dirty path afterwards. In
# CI, .github/actions/setup-apple-ffi has already restored or built the
# xcframework for the current fingerprint before this runs, so
# ensure-apple-ffi.ts's no-arg mode matches the marker inside it and returns
# without touching Nx (which needs node_modules — see runNxTarget in
# scripts/rust-fingerprint.ts). If the marker IS stale and node_modules is
# missing, say so plainly instead of leaving only Nx's generic "cannot
# resolve nx" error as the diagnostic.
if ! node scripts/ensure-apple-ffi.ts; then
  if [ ! -d node_modules/nx ]; then
    echo "CubbyFFI.xcframework is stale and node_modules is missing; run \`pnpm install --frozen-lockfile\` (or the setup-apple-ffi action) first" >&2
  fi
  exit 1
fi

shim="apps/apple/CubbyKit/Sources/CubbyFFI/cubby_ffi.swift"
if [ -n "$(git status --porcelain -- "$shim")" ]; then
  echo "$shim is stale for the current Rust sources; commit the regenerated file." >&2
  exit 1
fi

xcodegen generate --spec apps/apple/project.yml --use-cache
