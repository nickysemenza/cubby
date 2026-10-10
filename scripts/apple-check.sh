#!/usr/bin/env bash
# Backs the `apple` Nx targets (apps/apple/project.json) that `pnpm apple
# check` and CI run. Run from the workspace root.
#
#   host  CubbyKit's package tests on the macOS host, then the OpenAPI
#         generator-warning gate
#   app   native formatting and a generic-simulator build of Cubby-iOS
#
# A passing result satisfies the merge gate for its input hash whether CI or a
# developer's Mac produced it, so neither mode may vary by host.
set -euo pipefail

mode="${1:-}"
case "$mode" in
  host | app) ;;
  *)
    echo "usage: $0 host|app" >&2
    exit 2
    ;;
esac

# CI first runs the target with this set to ask only for a cached result
# (docs/ci.md). Reaching the script means a miss; Nx never caches a failure.
if [ "${CUBBY_NX_CACHE_PROBE:-}" = 1 ]; then
  echo "apple $mode: no cached result for this input hash" >&2
  exit 1
fi

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Skipping apple checks: Xcode not installed (xcode-select -p failed)."
  exit 0
fi

if [ "$mode" = host ]; then
  apps/apple/scripts/prepare-project.sh --sources
  # The package scheme runs host-only tests through Xcode's compilation cache;
  # running them on the iOS Simulator cost about 6 minutes to boot plus ~10
  # minutes of CPU starvation on a hosted runner (measured 2026-09-21).
  (
    cd apps/apple/CubbyKit
    xcodebuild \
      -scheme CubbyKit-Package -configuration Debug \
      -destination 'platform=macOS,arch=arm64' \
      -derivedDataPath .build/xcode \
      -onlyUsePackageVersionsFromResolvedFile \
      -skipPackagePluginValidation -skipMacroValidation \
      COMPILER_INDEX_STORE_ENABLE=NO SWIFT_ENABLE_BATCH_MODE=YES \
      ARCHS=arm64 ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO \
      COMPILATION_CACHE_ENABLE_CACHING=YES \
      COMPILATION_CACHE_ENABLE_DIAGNOSTIC_REMARKS=YES test
  )
  apps/apple/scripts/check-openapi-warnings.sh
  exit 0
fi

apps/apple/scripts/prepare-project.sh

# @State/@StateObject must never be seeded from an init parameter: a re-presented
# `.sheet(item:)` can then show the previous item's stale state (apps/apple/AGENTS.md,
# "Traps that cost real time"). Tag a deliberate exception `// state-init-ok: <reason>`
# on the same line.
offenders="$(grep -rn 'State(initialValue:\|StateObject(wrappedValue:' apps/apple/App | grep -v 'state-init-ok' || true)"
if [ -n "$offenders" ]; then
  echo "Found @State/@StateObject seeded from an init parameter without a state-init-ok tag:" >&2
  echo "$offenders" >&2
  exit 1
fi

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

# Apple Silicon's native simulator slice only: project.yml's simulator
# EXCLUDED_ARCHS covers only the app's own targets, so without ARCHS=arm64
# every SPM package (CubbyAPI included) also compiles for x86_64. Package
# clones live in apps/apple/SourcePackages, which CI caches between runs.
xcodebuild \
  -project apps/apple/Cubby.xcodeproj \
  -scheme Cubby-iOS \
  -configuration Debug \
  -destination "generic/platform=iOS Simulator" \
  -derivedDataPath apps/apple/DerivedData \
  -clonedSourcePackagesDirPath apps/apple/SourcePackages \
  -skipPackagePluginValidation \
  -skipMacroValidation \
  SWIFT_ENABLE_BATCH_MODE=YES \
  ARCHS=arm64 \
  ONLY_ACTIVE_ARCH=YES \
  CODE_SIGNING_ALLOWED=NO \
  COMPILER_INDEX_STORE_ENABLE=NO \
  build
