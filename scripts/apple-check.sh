#!/usr/bin/env bash
# Body of the former `runAppleCheck` (scripts/ci-scope.ts, deleted): native
# formatting, package tests, OpenAPI drift, and a build or test run. Backs
# the `apple` Nx target (apps/apple/project.json) and `pnpm apple check`. Run
# from the workspace root.
#
#   full  local default: swift test (CubbyKit package) + a generic-simulator build
#   app   local, skips swift test: a generic-simulator build only
#   ci    hosted `Apple checks` job: xcodebuild test on a concrete simulator,
#         which runs CubbyKit's package tests via the Cubby-iOS scheme's local
#         `package: CubbyKit/CubbyKitTests` test target (apps/apple/project.yml)
#         alongside Cubby-iOS-Tests, instead of a separate `swift test` job
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
# `ci` mode instead runs these package tests through the Cubby-iOS scheme
# below, so it does not need this local `swift test` pass.
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

if [ "$mode" = "ci" ]; then
  # Pick a concrete simulator: the booted one if any, else the first iPhone —
  # mirrors scripts/apple.ts's `sim` command. `xcodebuild test` needs a
  # resolved device id; the `app`/`full` build below uses the generic
  # destination instead, which `build` (but not `test`) accepts.
  simulators_json="$(xcrun simctl list devices available -j)"
  udid="$(SIMULATORS_JSON="$simulators_json" node -e '
    const devices = Object.values(JSON.parse(process.env.SIMULATORS_JSON).devices).flat();
    const iphones = devices.filter((d) => d.name.includes("iPhone"));
    const chosen = iphones.find((d) => d.state === "Booted") ?? iphones[0];
    if (!chosen) {
      process.stderr.write("no available iPhone simulator\n");
      process.exit(1);
    }
    process.stdout.write(chosen.udid);
  ')"

  xcodebuild \
    -project apps/apple/Cubby.xcodeproj \
    -scheme Cubby-iOS \
    -destination "platform=iOS Simulator,id=$udid" \
    -derivedDataPath apps/apple/DerivedData \
    -clonedSourcePackagesDirPath apps/apple/SourcePackages \
    -skipPackagePluginValidation \
    -skipMacroValidation \
    -parallel-testing-enabled NO \
    "${build_settings[@]}" \
    test
else
  # No -clonedSourcePackagesDirPath here: local builds keep SPM clones inside the
  # DerivedData `pnpm apple` also uses, so the two never thrash each other.
  xcodebuild \
    -project apps/apple/Cubby.xcodeproj \
    -scheme Cubby-iOS \
    -destination "generic/platform=iOS Simulator" \
    -derivedDataPath apps/apple/DerivedData \
    -skipPackagePluginValidation \
    -skipMacroValidation \
    "${build_settings[@]}" \
    build
fi
