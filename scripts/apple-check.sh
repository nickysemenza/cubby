#!/usr/bin/env bash
# Body of the former `runAppleCheck` (scripts/ci-scope.ts, deleted): native
# formatting, OpenAPI drift, and a build (plus, locally, package tests). Backs
# the `apple` Nx target (apps/apple/project.json) and `pnpm apple check`. Run
# from the workspace root.
#
#   full  local default: swift test (CubbyKit package) + a generic-simulator build
#   app   local, skips swift test: a generic-simulator build only
#   ci    hosted `Apple checks` job: a generic-simulator build only, using the
#         CI-cached SPM clone directory (-clonedSourcePackagesDirPath).
#         CubbyKit's package tests run separately, on the macOS host, in the
#         hosted `Apple package tests` job (`swift test`) — running them on
#         the iOS Simulator inside this build job cost about 6 minutes to
#         boot plus ~10 minutes of CPU starvation on a hosted runner
#         (measured 2026-09-21), so they stay out of it.
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

# Hosted CI restores a cached DerivedData (ci.yaml); after xcodegen has
# rewritten its outputs, give tracked sources blob-hash mtimes so unchanged
# files match that build instead of recompiling (scripts/stamp-source-mtimes.ts).
if [ "$mode" = "ci" ]; then
  node scripts/stamp-source-mtimes.ts apps/apple
fi

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
# `ci` mode skips this: hosted CI runs CubbyKit's package tests separately,
# on the host, in the `Apple package tests` job.
if [ "$mode" = "full" ]; then
  swift test --package-path apps/apple/CubbyKit --force-resolved-versions
fi

# Fails when the committed CubbyAPI client no longer matches the OpenAPI document.
apps/apple/scripts/generate-openapi.sh --check

# Fails when the committed preview fixtures no longer match what their zod schemas
# (apps/web/scripts/generate-apple-preview-fixtures.ts) would generate — schema drift
# fails here instead of crashing a `#Preview` at runtime.
pnpm --dir apps/web run gen:apple-preview-fixtures:check

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

# CI-only: reuse the SPM clone directory .github/actions/setup-apple-tools
# cached, instead of resolving Sentry/GRDB/Nuke from scratch every run. Local
# builds keep SPM clones inside the DerivedData `pnpm apple` also uses, so the
# two never thrash each other. The expansion below is the bash 3.2 (macOS
# default) spelling that survives `set -u` when the array is empty.
clone_args=()
if [ "$mode" = "ci" ]; then
  clone_args+=(-clonedSourcePackagesDirPath apps/apple/SourcePackages)
fi

xcodebuild \
  -project apps/apple/Cubby.xcodeproj \
  -scheme Cubby-iOS \
  -destination "generic/platform=iOS Simulator" \
  -derivedDataPath apps/apple/DerivedData \
  ${clone_args[@]+"${clone_args[@]}"} \
  -skipPackagePluginValidation \
  -skipMacroValidation \
  "${build_settings[@]}" \
  build
