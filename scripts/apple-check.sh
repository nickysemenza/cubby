#!/usr/bin/env bash
# Body of the former `runAppleCheck` (scripts/ci-scope.ts, deleted): native
# formatting and a build (plus, locally, package tests). Backs
# the `apple` Nx target (apps/apple/project.json) and `pnpm apple check`. Run
# from the workspace root.
#
#   full  local default: swift test (CubbyKit package) + a generic-simulator build
#   app   local, skips swift test: a generic-simulator build only
#   ci    hosted `Apple simulator build` job: a generic-simulator build only, using the
#         CI-cached SPM clone directory (-clonedSourcePackagesDirPath).
#         CubbyKit's package tests run in parallel in `Apple host tests`
#         (the host-only CubbyKit-Package Xcode scheme) — running them on
#         the iOS Simulator inside this build job cost about 6 minutes to
#         boot plus ~10 minutes of CPU starvation on a hosted runner
#         (measured 2026-09-21), so CI tests them on the host.
set -euo pipefail

mode="${1:-full}"
case "$mode" in
  full | app | ci) ;;
  *)
    echo "usage: $0 [full|app|ci]" >&2
    exit 2
    ;;
esac

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Skipping apple checks: Xcode not installed (xcode-select -p failed)."
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

# --force-resolved-versions: a bare `swift test` re-resolves and rewrites
# CubbyKit/Package.resolved (only the originHash), leaving the tree dirty
# after every run. Pins change only via a deliberate `swift package update`.
# `ci` mode skips this: the separate host job owns CubbyKit's package tests.
if [ "$mode" = "full" ]; then
  swift test --package-path apps/apple/CubbyKit --force-resolved-versions --disable-index-store
  # Hosted CI runs this in the separate host-test job.
  apps/apple/scripts/check-openapi-warnings.sh
fi

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
  build_settings+=(SWIFT_ENABLE_BATCH_MODE=YES ARCHS=arm64 ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO)
fi

# CI-only: reuse the SPM clone directory .github/actions/setup-apple-tools
# cached, instead of resolving Sentry/GRDB/Nuke from scratch every run. Local
# builds keep SPM clones inside the DerivedData `pnpm apple` also uses, so the
# two never thrash each other. The expansion below is the bash 3.2 (macOS
# default) spelling that survives `set -u` when the array is empty.
clone_args=()
if [ "$mode" = "ci" ]; then
  clone_args+=(-clonedSourcePackagesDirPath apps/apple/SourcePackages)
fi

build_args=(
  -project apps/apple/Cubby.xcodeproj
  -scheme Cubby-iOS
  -configuration Debug
  -destination "generic/platform=iOS Simulator"
  -derivedDataPath apps/apple/DerivedData
  ${clone_args[@]+"${clone_args[@]}"}
  -skipPackagePluginValidation
  -skipMacroValidation
  "${build_settings[@]}"
)

# The optional harness uses the same compiler profile and certifies its bytes.
if [ "$mode" = "ci" ] && [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  simulator_profile="$(node scripts/apple-simulator-build-cache.ts args)"
  build_args=()
  while IFS= read -r argument; do
    build_args+=("$argument")
  done <<< "$simulator_profile"
fi

simulator_cache_key=""
if [ "$mode" = "ci" ] && [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  xcodebuild "${build_args[@]}" -resolvePackageDependencies
  if ! simulator_cache_key="$(node scripts/apple-simulator-build-cache.ts key)"; then
    echo "Simulator app cannot be certified; retaining the normal build."
  fi
fi

# The required gate still compiles; only optional simulator lanes reuse a
# certified result. Signing is disabled for their temporary plist fixtures.
xcodebuild "${build_args[@]}" build
if [ -n "$simulator_cache_key" ]; then
  node scripts/apple-simulator-build-cache.ts stamp "$simulator_cache_key"
fi
