#!/usr/bin/env bash
# Backs the `apple` Nx targets (apps/apple/project.json) that `pnpm apple
# check` and CI run. Run from the workspace root.
#
#   host  CubbyKit's package tests on the macOS host, then the OpenAPI
#         generator-warning gate
#   app   generic-simulator build of Cubby-iOS
#   lint  native formatting
#
set -euo pipefail

mode="${1:-}"
case "$mode" in
  host | app | lint) ;;
  *)
    echo "usage: $0 host|app|lint" >&2
    exit 2
    ;;
esac

# Needs only a Swift toolchain, so CI runs it on Linux.
if [ "$mode" = lint ]; then
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
swift format lint --parallel --strict --configuration apps/apple/.swift-format --recursive "${targets[@]}"

exit 0
fi

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Apple checks require Xcode (xcode-select -p failed)." >&2
  exit 1
fi

if [ "$mode" = host ]; then
  apps/apple/scripts/prepare-project.sh --sources
  host_log="$(mktemp)"
  trap 'rm -f "$host_log"' EXIT
  host_status=0
  node apps/apple/tooling/apple.ts build-check host 2>&1 | tee "$host_log" || host_status=$?
  apps/apple/scripts/check-openapi-warnings.sh "$host_log" || host_status=1
  exit "$host_status"
fi


apps/apple/scripts/prepare-project.sh

# The existing Apple command owns Xcode paths and flags for launches and checks.
node apps/apple/tooling/apple.ts build-check app
