#!/usr/bin/env bash
# Body of the former `runAppleCheck` (scripts/ci-scope.ts, deleted): native
# formatting, tests, OpenAPI drift, and a simulator build. Backs the `apple`
# Nx target (apps/apple/project.json) and `pnpm apple check`. Run from the
# workspace root.
set -euo pipefail

mode="${1:-full}"
case "$mode" in
  full | app) ;;
  *)
    echo "usage: $0 [full|app]" >&2
    exit 2
    ;;
esac

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

# --force-resolved-versions: a bare `swift test` re-resolves and rewrites
# CubbyKit/Package.resolved (only the originHash), leaving the tree dirty
# after every run. Pins change only via a deliberate `swift package update`.
if [ "$mode" = "full" ]; then
  swift test --package-path apps/apple/CubbyKit --force-resolved-versions
fi

# Fails when the committed CubbyAPI client no longer matches the OpenAPI document.
apps/apple/scripts/generate-openapi.sh --check

# Same DerivedData as `pnpm apple`, so this build is incremental over the dev
# loop's instead of a second full compile of CubbyKit.
#
# Keep the hosted Apple Silicon CI build on its native simulator slice while
# explicitly exercising Xcode's batch compiler. Local builds retain Xcode's
# default behavior.
build_settings=(COMPILER_INDEX_STORE_ENABLE=NO)
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  # The macOS-26 hosted runner is Apple Silicon. Restrict the generic
  # Simulator build to its native slice; a release artifact still builds its
  # supported architectures outside this PR gate.
  build_settings+=(SWIFT_ENABLE_BATCH_MODE=YES ARCHS=arm64 ONLY_ACTIVE_ARCH=YES)
fi

xcodebuild \
  -project apps/apple/Cubby.xcodeproj \
  -scheme Cubby-iOS \
  -destination "generic/platform=iOS Simulator" \
  -derivedDataPath apps/apple/DerivedData \
  "${build_settings[@]}" \
  build
