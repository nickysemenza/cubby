#!/usr/bin/env bash
# Builds the recipebridge wasm packages into packages/wasm. Used by `pnpm wasm`
# and by CI's setup-node-with-deps, which runs before `pnpm install` — so this
# stays dependency-free.
#
#   packages/wasm           full build (`html` feature): the Worker and Vitest
#   packages/wasm/browser   --no-default-features: what the browser loads
#   packages/wasm/cookbook  recipebridge-cookbook: the browser's EPUB import
#
# wasm-pack recreates each --out-dir, so the root build runs first and the
# tracked package.json (which adds the `./cookbook` export) is restored last.
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

manifest="$(cat "$OUT/package.json")"
wasm-pack build --scope cubby --out-dir "$OUT" "$ROOT/recipebridge"
wasm-pack build --scope cubby --out-dir "$OUT/browser" "$ROOT/recipebridge" -- --no-default-features
wasm-pack build --scope cubby --out-dir "$OUT/cookbook" "$ROOT/recipebridge-cookbook"
printf '%s\n' "$manifest" >"$OUT/package.json"
