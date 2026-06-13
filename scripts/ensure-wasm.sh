#!/usr/bin/env sh
# Rebuild the gitignored @cubby/recipebridge WASM only when recipebridge/ is newer
# than the built binary. cargo does the real incremental compile (kept warm across
# worktrees by the shared CARGO_TARGET_DIR in the root `wasm` script) — this is just
# the staleness gate so git hooks skip the ~4s wasm-bindgen/opt when nothing changed.
# Wired into .husky/post-merge and post-checkout. Fresh worktree: `pnpm run wasm`.
ROOT=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
ART="$ROOT/packages/wasm/recipebridge_bg.wasm"

if [ -f "$ART" ] && [ -z "$(find "$ROOT/recipebridge" -name target -prune -o \
  -type f \( -name '*.rs' -o -name '*.toml' -o -name '*.lock' \) -newer "$ART" -print | head -1)" ]; then
  exit 0 # up to date
fi

echo "[ensure-wasm] recipebridge/ changed (or no build) — building…" >&2
cd "$ROOT" && pnpm run wasm
