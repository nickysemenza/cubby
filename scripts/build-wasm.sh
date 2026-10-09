#!/usr/bin/env bash
# Builds the recipebridge wasm packages into packages/wasm. Used by `pnpm wasm`
# and by CI's setup-node-with-deps, which runs before `pnpm install` — so this
# stays dependency-free.
#
#   packages/wasm/worker    full build (`html`, `ai-usage`): the Worker and Vitest
#   packages/wasm/browser   --no-default-features: what the browser loads
#   packages/wasm/cookbook  recipebridge/cookbook: the browser's EPUB import
#
# wasm-pack replaces its --out-dir's package.json, so none of them is
# packages/wasm itself, whose tracked package.json exports these.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/packages/wasm"

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/cubby/cargo-target}"
# Member profiles are ignored in the workspace and wasm-pack takes only
# --release. Keep in sync with WASM_RELEASE_PROFILE in ensure-wasm.ts.
export CARGO_PROFILE_RELEASE_OPT_LEVEL=z
export CARGO_PROFILE_RELEASE_LTO=true
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1
export CARGO_PROFILE_RELEASE_PANIC=abort
export CARGO_PROFILE_RELEASE_INCREMENTAL=false

# ensure-wasm.ts stamps a fresh marker only after all three builds succeed;
# an interrupted build must not keep the old one.
rm -f "$OUT/.fingerprint"
wasm-pack build --no-pack --out-dir "$OUT/worker" "$ROOT/recipebridge"
wasm-pack build --no-pack --out-dir "$OUT/browser" "$ROOT/recipebridge" -- --no-default-features
wasm-pack build --no-pack --out-dir "$OUT/cookbook" "$ROOT/recipebridge/cookbook"
