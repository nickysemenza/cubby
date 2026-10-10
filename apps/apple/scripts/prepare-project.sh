#!/usr/bin/env bash
# Ensures CubbyFFI.xcframework/the UniFFI shim and the generated Swift are
# current and regenerates Cubby.xcodeproj from apps/apple/project.yml, so
# scripts/apple-check.sh and anything else that needs a ready-to-build checkout
# share one path. `--sources` stops before the Xcode project, for SwiftPM-only
# builds. Run from the workspace root.
set -euo pipefail

# The xcframework + shim come from the Nx cache locally. In native CI, setup-apple-ffi has
# already verified the artifact. Its fingerprint is authoritative for the job:
# a second Cargo metadata resolution can differ after the Rust build.
if [ -n "${CUBBY_FFI_SETUP_FINGERPRINT:-}" ]; then
  marker="apps/apple/CubbyKit/Frameworks/CubbyFFI.xcframework/.fingerprint"
  if [ ! -f "$marker" ] || [ "$(cat "$marker")" != "$CUBBY_FFI_SETUP_FINGERPRINT" ]; then
    echo "CubbyFFI.xcframework does not match setup-apple-ffi's fingerprint" >&2
    exit 1
  fi
elif ! node scripts/ensure-apple-ffi.ts; then
  if [ ! -d node_modules/nx ]; then
    echo "CubbyFFI.xcframework is stale and node_modules is missing; run \`pnpm install --frozen-lockfile\` (or the setup-apple-ffi action) first" >&2
  fi
  exit 1
fi

# Generated Swift (CubbyKit/Generated, the CubbyAPI OpenAPI inputs) is
# gitignored. The TestFlight release legs have no node_modules and download it
# as an artifact from their Linux `Apple generated inputs` job instead.
if [ -d node_modules/.bin ]; then
  node scripts/generator/ensure.ts
elif [ ! -f apps/apple/CubbyKit/Sources/CubbyAPI/openapi.json ]; then
  echo "Generated Swift inputs are missing; run \`pnpm install\` (it runs pnpm generate) first" >&2
  exit 1
fi

[ "${1:-}" = --sources ] && exit 0
xcodegen generate --spec apps/apple/project.yml --use-cache
