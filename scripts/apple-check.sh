#!/usr/bin/env bash
# Body of the former `runAppleCheck` (scripts/ci-scope.ts, deleted): native
# formatting, tests, OpenAPI drift, and a simulator build. Backs the `apple`
# Nx target (apps/apple/project.json) and `pnpm apple check`. Run from the
# workspace root.
set -euo pipefail

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Skipping apple checks: Xcode not installed (xcode-select -p failed)."
  exit 0
fi

# The xcframework + shim come from the Nx cache when the Rust tree is
# unchanged; a stale committed shim shows up as a dirty path afterwards.
node scripts/ensure-apple-ffi.ts
shim="apps/apple/CubbyKit/Sources/CubbyFFI/cubby_ffi.swift"
if [ -n "$(git status --porcelain -- "$shim")" ]; then
  echo "$shim is stale for the current Rust sources; commit the regenerated file." >&2
  exit 1
fi

xcodegen generate --spec apps/apple/project.yml --use-cache

# swift-format's --recursive can't exclude a subdirectory, and
# CubbyKit/Sources/CubbyKit/Generated is emitter-owned (apps/apple/AGENTS.md)
# and must never be reformatted or linted; Sources/CubbyAPI (the whole
# swift-openapi-generator target) is a sibling of Sources/CubbyKit and is
# never enumerated either — it is generated end to end.
kit_dir="apps/apple/CubbyKit/Sources/CubbyKit"
targets=()
for entry in "$kit_dir"/*; do
  name="$(basename "$entry")"
  [ "$name" = "Generated" ] && continue
  targets+=("$entry")
done
targets+=(apps/apple/App apps/apple/CubbyKit/Sources/cubby apps/apple/CubbyKit/Sources/CubbyAPISupport apps/apple/CubbyKit/Tests)
swift format lint --strict --configuration apps/apple/.swift-format --recursive "${targets[@]}"

# --force-resolved-versions: a bare `swift test` re-resolves and rewrites
# CubbyKit/Package.resolved (only the originHash), leaving the tree dirty
# after every run. Pins change only via a deliberate `swift package update`.
swift test --package-path apps/apple/CubbyKit --force-resolved-versions

# Fails when the committed CubbyAPI client no longer matches the OpenAPI document.
apps/apple/scripts/generate-openapi.sh --check

# Same DerivedData as `pnpm apple`, so this build is incremental over the dev
# loop's instead of a second full compile of CubbyKit.
xcodebuild \
  -project apps/apple/Cubby.xcodeproj \
  -scheme Cubby-iOS \
  -destination "generic/platform=iOS Simulator" \
  -derivedDataPath apps/apple/DerivedData \
  COMPILER_INDEX_STORE_ENABLE=NO \
  build
