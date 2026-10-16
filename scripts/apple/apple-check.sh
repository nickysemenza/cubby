#!/usr/bin/env bash
# Backs the `apple` Nx targets (apps/apple/project.json) that `pnpm apple
# check` and CI run. Run from the workspace root.
#
#   host  CubbyKit's package tests on the macOS host, then the OpenAPI
#         generator-warning gate
#   app   generic-simulator build of Cubby-iOS
#   lint  native formatting and state-initialization rules
#
# A passing result satisfies the merge gate for its input hash whether CI or a
# developer's Mac produced it, but only for the same execution environment.
set -euo pipefail

mode="${1:-}"
case "$mode" in
  host | app | lint) ;;
  *)
    echo "usage: $0 host|app|lint" >&2
    exit 2
    ;;
esac

# CI first runs the target with this set to ask only for a cached result
# (docs/ci.md). Reaching the script means a miss; Nx never caches a failure.
if [ "${CUBBY_NX_CACHE_PROBE:-}" = 1 ]; then
  echo "apple $mode: no cached result for this input hash" >&2
  exit 1
fi

# Needs only a Swift toolchain, so CI runs it on Linux.
if [ "$mode" = lint ]; then
  lint_status=0
  # @State/@StateObject must never be seeded from an init parameter: a re-presented
  # `.sheet(item:)` can then show the previous item's stale state (apps/apple/AGENTS.md,
  # "Traps that cost real time"). Tag a deliberate exception `// state-init-ok: <reason>`
  # on the same line.
  offenders="$(grep -rn 'State(initialValue:\|StateObject(wrappedValue:' apps/apple/App | grep -v 'state-init-ok' || true)"
  if [ -n "$offenders" ]; then
    echo "Found @State/@StateObject seeded from an init parameter without a state-init-ok tag:" >&2
    echo "$offenders" >&2
    lint_status=1
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
swift format lint --strict --configuration apps/apple/.swift-format --recursive "${targets[@]}" || lint_status=1

exit "$lint_status"
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
  node scripts/apple/apple.ts build-check host 2>&1 | tee "$host_log" || host_status=$?
  apps/apple/scripts/check-openapi-warnings.sh "$host_log" || host_status=1
  exit "$host_status"
fi


apps/apple/scripts/prepare-project.sh

# The existing Apple command owns Xcode paths and flags for launches and checks.
node scripts/apple/apple.ts build-check app
