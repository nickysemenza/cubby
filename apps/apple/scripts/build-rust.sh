#!/usr/bin/env bash
# Builds cubby-ffi for iOS device, iOS simulator, and macOS (Apple Silicon),
# generates the UniFFI Swift bindings from the host (macOS) build, and stages
# both into apps/apple/CubbyKit: the xcframework (gitignored build artifact,
# but required on disk for SPM's `binaryTarget(path:)`) and the committed
# `cubby_ffi.swift` shim.
#
# Flags:
#   --check              Diff the generated `cubby_ffi.swift` against the
#                         committed copy instead of overwriting it, exiting
#                         non-zero if they differ. Still builds and assembles
#                         the xcframework (needed for `swift build`/`swift
#                         test` to succeed locally). Skipped entirely (like
#                         everything else) when the content stamp is fresh.
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
#   --force              Rebuild even if the content stamp (see below)
#                         matches and every requested slice is already
#                         present in the xcframework.
#
# Content stamp: a sha256 over every file under cubby-ffi/src/, cubby-ffi's
# Cargo.toml/Cargo.lock/uniffi.toml/build.rs (the latter two only if
# present), the committed cubby_ffi.swift bindings, this script itself, the
# resolved --profile/--targets, and `rustc --version` — written to `.cubby-ffi.stamp` inside the (gitignored)
# xcframework directory after a successful build. When a run starts and that
# stamp matches the freshly computed one, and every slice the run requests is
# already in the xcframework, the whole script (including a `--check` diff)
# is a no-op: this is what makes repeat pre-push `--check` runs fast. Pass
# --force to rebuild anyway.
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
STAMP_FILE="$XCFRAMEWORK_OUT/.cubby-ffi.stamp"
SCRIPT_SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/cubby/cubby-ffi-target}"
export CARGO_TARGET_DIR

CHECK=0
PROFILE="release"
TARGETS_ARG="all"
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)
      CHECK=1
      shift
      ;;
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
    --force)
      FORCE=1
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

# Maps a --targets key to the library-identifier directory name
# `xcodebuild -create-xcframework` gives that slice, so the skip check below
# can confirm a requested slice actually made it into the xcframework (a
# `--targets sim` run followed by `--targets mac` should not report the mac
# slice as already present just because the stamp happens to match).
slice_dir_for() {
  case "$1" in
    sim) echo "ios-arm64-simulator" ;;
    device) echo "ios-arm64" ;;
    mac) echo "macos-arm64" ;;
  esac
}

slice_present() {
  local dir
  dir="$(slice_dir_for "$1")"
  [[ -n "$dir" && -d "$XCFRAMEWORK_OUT/$dir" ]]
}

# Content stamp: hashes every input that can change what this script
# produces (Rust sources, manifest/lockfile/uniffi config, this script, the
# resolved flags, and the compiler version) so an unchanged rerun can be
# skipped outright. File paths are sorted so the hash is deterministic
# regardless of filesystem iteration order; `shasum -a 256` is macOS's stock
# sha256 tool, matching the rest of this script's macOS-only assumptions.
compute_stamp() {
  local files=()
  if [[ -d "$ROOT/cubby-ffi/src" ]]; then
    while IFS= read -r f; do
      files+=("$f")
    done < <(find "$ROOT/cubby-ffi/src" -type f | LC_ALL=C sort)
  fi
  files+=("$CUBBY_FFI_MANIFEST" "$ROOT/cubby-ffi/Cargo.lock")
  [[ -f "$ROOT/cubby-ffi/uniffi.toml" ]] && files+=("$ROOT/cubby-ffi/uniffi.toml")
  [[ -f "$ROOT/cubby-ffi/build.rs" ]] && files+=("$ROOT/cubby-ffi/build.rs")
  files+=("$SCRIPT_SELF")
  # The committed bindings are an output, but hashing them too means a hand
  # edit or a revert of cubby_ffi.swift stales the stamp, so a `--check` run
  # cannot be short-circuited past a shim that no longer matches the build.
  [[ -f "$SWIFT_SHIM_DEST" ]] && files+=("$SWIFT_SHIM_DEST")

  {
    for f in "${files[@]}"; do
      shasum -a 256 "$f"
    done
    printf 'profile=%s\n' "$PROFILE"
    printf 'targets=%s\n' "$TARGETS_ARG"
    printf 'rustc=%s\n' "$(rustc --version)"
  } | shasum -a 256 | awk '{print $1}'
}

NEW_STAMP="$(compute_stamp)"

if [[ "$FORCE" -eq 0 && -f "$STAMP_FILE" && "$(cat "$STAMP_FILE")" == "$NEW_STAMP" ]]; then
  all_present=1
  for key in "${SELECTED_KEYS[@]}"; do
    if ! slice_present "$key"; then
      all_present=0
      break
    fi
  done
  if [[ "$all_present" -eq 1 ]]; then
    echo "build-rust.sh: inputs unchanged, skipping (--force to rebuild)"
    exit 0
  fi
fi

echo "==> cubby-ffi: profile=$PROFILE targets=$TARGETS_ARG"

# No `--features cli` on any of these: that feature pulls in `uniffi_bindgen`
# + `clap`, needed only by the uniffi-bindgen binary invoked below. Compiling
# that for every cross-target roughly doubled each build. The lib target
# never needs it.
for key in "${SELECTED_KEYS[@]}"; do
  triple="$(triple_for "$key")"
  start=$(date +%s)
  cargo build --manifest-path "$CUBBY_FFI_MANIFEST" --profile "$PROFILE" --target "$triple"
  elapsed=$(($(date +%s) - start))
  echo "==> cubby-ffi: $key ($triple, $PROFILE) built in ${elapsed}s"
done

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

if [[ "$CHECK" -eq 1 ]]; then
  if ! diff -u "$SWIFT_SHIM_DEST" "$GENERATED_SWIFT"; then
    echo "error: $SWIFT_SHIM_DEST is stale; run apps/apple/scripts/build-rust.sh" >&2
    exit 1
  fi
  echo "==> cubby-ffi: $SWIFT_SHIM_DEST matches the current Rust source"
else
  mkdir -p "$(dirname "$SWIFT_SHIM_DEST")"
  cp "$GENERATED_SWIFT" "$SWIFT_SHIM_DEST"
  echo "==> cubby-ffi: wrote $SWIFT_SHIM_DEST"
fi

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

# Written only after a fully successful build, inside the gitignored
# xcframework directory (never committed). A future run's early-exit check
# above compares against this.
# Recomputed rather than reusing NEW_STAMP: the shim may have just been
# rewritten above, and the stamp must describe the tree as it is now.
printf '%s' "$(compute_stamp)" > "$STAMP_FILE"

echo "==> cubby-ffi: done"
