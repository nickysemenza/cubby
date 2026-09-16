#!/usr/bin/env bash
# Builds cubby-ffi for iOS device, iOS simulator, and macOS (Apple Silicon),
# generates the UniFFI Swift bindings from the host (macOS) build, and stages
# both into apps/apple/CubbyKit: the xcframework (gitignored build artifact,
# but required on disk for SPM's `binaryTarget(path:)`) and the committed
# `cubby_ffi.swift` shim.
#
# This script is the builder only. `scripts/ensure-apple-ffi.ts` is the entry
# point: it keys an Nx-cached target (project.json `apple-ffi`) on the Rust
# content fingerprint, so an unchanged tree — including a fresh worktree —
# restores the xcframework and shim instead of running this. There is
# deliberately no stamp or early exit here: a "nothing changed" guess that
# disagreed with the fingerprint would let Nx cache a stale artifact for every
# checkout, and cargo's own fingerprints already make a direct rerun a no-op
# at the compile step (bindgen + -create-xcframework cost seconds).
#
# Flags:
#   --profile release|dist   Default `release` (plain, fast inner-loop build).
#                         `dist` is the size-tuned profile (LTO, one codegen
#                         unit) meant for a framework that actually ships —
#                         use it before a device install, not every rebuild.
#   --targets sim|device|mac|all   Default `all`. Restricting this to one
#                         platform skips the other two cross-builds; the
#                         resulting xcframework only contains the slice(s)
#                         built, which is fine for local simulator/Mac
#                         iteration but not for a real device or App Store
#                         archive — run `--targets all` before either.
#
# Bindgen always runs from a host (macOS, no --target) build regardless of
# --targets: the generated Swift API surface is architecture-independent, so
# introspecting one cdylib is enough, and the host is the one guaranteed to
# both build and run locally. On Apple Silicon that host build is pinned to
# `--target aarch64-apple-darwin` — the same triple the `mac` slice below
# uses — so cargo treats them as the same build graph and reuses every
# dependency artifact between them instead of compiling twice; see the "host
# (bindgen)" section further down. Intel keeps the old untargeted host build.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CUBBY_FFI_MANIFEST="$ROOT/cubby-ffi/Cargo.toml"
APPLE_ROOT="$ROOT/apps/apple"
CUBBYKIT_ROOT="$APPLE_ROOT/CubbyKit"
XCFRAMEWORK_OUT="$CUBBYKIT_ROOT/Frameworks/CubbyFFI.xcframework"
SWIFT_SHIM_DEST="$CUBBYKIT_ROOT/Sources/CubbyFFI/cubby_ffi.swift"

CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/cubby/cubby-ffi-target}"
export CARGO_TARGET_DIR

PROFILE="release"
TARGETS_ARG="all"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      PROFILE="${2:-}"
      shift 2
      ;;
    --profile=*)
      PROFILE="${1#*=}"
      shift
      ;;
    --targets)
      TARGETS_ARG="${2:-}"
      shift 2
      ;;
    --targets=*)
      TARGETS_ARG="${1#*=}"
      shift
      ;;
    *)
      echo "error: unknown argument '$1'" >&2
      exit 1
      ;;
  esac
done

case "$PROFILE" in
  release | dist) ;;
  *)
    echo "error: --profile must be 'release' or 'dist', got '$PROFILE'" >&2
    exit 1
    ;;
esac

# Maps a --targets key to its Rust target triple. A plain function (not an
# associative array) so this stays portable to bash 3.2 (macOS's /bin/bash).
triple_for() {
  case "$1" in
    sim) echo "aarch64-apple-ios-sim" ;;
    device) echo "aarch64-apple-ios" ;;
    mac) echo "aarch64-apple-darwin" ;;
  esac
}

case "$TARGETS_ARG" in
  all) SELECTED_KEYS=(device sim mac) ;;
  sim) SELECTED_KEYS=(sim) ;;
  device) SELECTED_KEYS=(device) ;;
  mac) SELECTED_KEYS=(mac) ;;
  *)
    echo "error: --targets must be one of sim|device|mac|all, got '$TARGETS_ARG'" >&2
    exit 1
    ;;
esac

echo "==> cubby-ffi: profile=$PROFILE targets=$TARGETS_ARG"

# One invocation for every requested triple: cargo builds the shared host
# artifacts (build scripts, proc-macros) once and schedules all targets under
# one job budget, where separate per-target processes would redo that work
# and oversubscribe the cores. Each slice still lands in its own
# `$CARGO_TARGET_DIR/<triple>/$PROFILE/`.
#
# No `--features cli` here: that feature pulls in `uniffi_bindgen` + `clap`,
# needed only by the uniffi-bindgen binary invoked below. Compiling that for
# every cross-target roughly doubled each build. The lib target never needs it.
target_args=()
for key in "${SELECTED_KEYS[@]}"; do
  target_args+=(--target "$(triple_for "$key")")
done
start=$(date +%s)
cargo build --manifest-path "$CUBBY_FFI_MANIFEST" --profile "$PROFILE" "${target_args[@]}"
elapsed=$(($(date +%s) - start))
echo "==> cubby-ffi: ${SELECTED_KEYS[*]} ($PROFILE) built in ${elapsed}s"

# The bindgen introspection target: always a host build, run unconditionally
# even when `mac` is not among --targets. On Apple Silicon this is
# architecturally identical to the aarch64-apple-darwin slice above, but
# cargo does not share build products between a `--target`-qualified build
# and a plain untargeted one even on the same hardware — so without an
# explicit --target here, this would be a second, separate compile. Pinning
# it to the same `--target aarch64-apple-darwin` triple as the mac slice
# makes cargo treat both as the same build graph: every shared dependency
# artifact is reused, and only cubby-ffi itself needs to recompile for the
# `cli` feature this step enables. Intel has no such shared slice, so it
# keeps the old implicit host build.
HOST_TARGET_ARGS=()
HOST_TARGET_DIR=""
if [[ "$(uname -m)" == "arm64" ]]; then
  HOST_TARGET_ARGS=(--target aarch64-apple-darwin)
  HOST_TARGET_DIR="aarch64-apple-darwin/"
fi

start=$(date +%s)
cargo build --manifest-path "$CUBBY_FFI_MANIFEST" --profile "$PROFILE" "${HOST_TARGET_ARGS[@]}"
elapsed=$(($(date +%s) - start))
echo "==> cubby-ffi: host (bindgen) ($PROFILE) built in ${elapsed}s"

HOST_DYLIB="$CARGO_TARGET_DIR/${HOST_TARGET_DIR}$PROFILE/libcubby_ffi.dylib"
if [[ ! -f "$HOST_DYLIB" ]]; then
  echo "error: expected host cdylib at $HOST_DYLIB (did the cdylib crate-type build?)" >&2
  exit 1
fi

BINDINGS_DIR="$(mktemp -d)"
trap 'rm -rf "$BINDINGS_DIR"' EXIT

echo "==> cubby-ffi: generating Swift bindings from the host build"
# uniffi-bindgen's `generate --library` mode shells out to `cargo metadata`
# using the process's current directory (a `--manifest-path` on the outer
# `cargo run` only controls which binary cargo builds/runs, not the cwd the
# resulting process inherits) — so this step alone runs from cubby-ffi/,
# scoped to a subshell so it doesn't change this script's own directory.
(
  cd "$ROOT/cubby-ffi"
  cargo run --profile "$PROFILE" "${HOST_TARGET_ARGS[@]}" --features cli --bin uniffi-bindgen -- \
    generate --library "$HOST_DYLIB" --language swift --out-dir "$BINDINGS_DIR"
)

GENERATED_SWIFT="$(find "$BINDINGS_DIR" -maxdepth 1 -name '*.swift' | head -n1)"
GENERATED_HEADER="$(find "$BINDINGS_DIR" -maxdepth 1 -name '*.h' | head -n1)"
GENERATED_MODULEMAP="$(find "$BINDINGS_DIR" -maxdepth 1 -name '*.modulemap' | head -n1)"
if [[ -z "$GENERATED_SWIFT" || -z "$GENERATED_HEADER" || -z "$GENERATED_MODULEMAP" ]]; then
  echo "error: uniffi-bindgen did not produce the expected .swift/.h/.modulemap trio in $BINDINGS_DIR:" >&2
  ls -la "$BINDINGS_DIR" >&2
  exit 1
fi

# Written unconditionally; the `apple` Nx target (scripts/apple-check.sh)
# detects a stale committed shim as a dirty working tree after this runs.
mkdir -p "$(dirname "$SWIFT_SHIM_DEST")"
cp "$GENERATED_SWIFT" "$SWIFT_SHIM_DEST"
echo "==> cubby-ffi: wrote $SWIFT_SHIM_DEST"

# xcodebuild -create-xcframework refuses to write into an existing directory.
# The xcframework is a gitignored build artifact, so a stale copy is safe to
# discard. Note this means a `--targets sim` run replaces a full 3-slice
# framework with a 1-slice one — intentional for fast simulator iteration,
# but run `--targets all` again before a device build or archive.
rm -rf "$XCFRAMEWORK_OUT"
mkdir -p "$(dirname "$XCFRAMEWORK_OUT")"

# Every platform slice shares the same headers: the C ABI does not vary
# across targets, only the compiled code does. Each slice gets its own copy
# of the headers directory because -create-xcframework wants one per
# -library argument; the modulemap uniffi-bindgen wrote is renamed to the
# name Xcode looks for (module.modulemap) so the binary target's headers
# resolve as a Clang module.
HEADERS_STAGE="$BINDINGS_DIR/Headers"
mkdir -p "$HEADERS_STAGE"
cp "$GENERATED_HEADER" "$HEADERS_STAGE/"
cp "$GENERATED_MODULEMAP" "$HEADERS_STAGE/module.modulemap"

xcframework_args=()
for key in "${SELECTED_KEYS[@]}"; do
  triple="$(triple_for "$key")"
  static_lib="$CARGO_TARGET_DIR/$triple/$PROFILE/libcubby_ffi.a"
  if [[ ! -f "$static_lib" ]]; then
    echo "error: expected static lib at $static_lib" >&2
    exit 1
  fi
  xcframework_args+=(-library "$static_lib" -headers "$HEADERS_STAGE")
done

echo "==> cubby-ffi: creating $XCFRAMEWORK_OUT (${SELECTED_KEYS[*]})"
xcodebuild -create-xcframework "${xcframework_args[@]}" -output "$XCFRAMEWORK_OUT"

echo "==> cubby-ffi: done"
