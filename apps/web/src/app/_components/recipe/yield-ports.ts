import type { SubRecipeBlockReason } from "@cubby/schemas/availability";

import { wasm } from "~/lib/wasm";

import type {
  MassGramsPort,
  YieldFractionPort,
  YieldPorts,
} from "./recipe-tree";

// The wasm adapters behind `recipe-tree`'s injected ports — the one module in
// this folder that imports `~/lib/wasm`. Keeping it separate is what lets
// `recipe-tree` (and through it `recipe-export-markdown`) stay wasm-free while
// the math itself lives entirely in recipebridge.

const yieldFraction: YieldFractionPort = (recipeYield, amounts) => {
  const out = wasm.recipe_yield_fraction({
    recipe_yield: recipeYield ?? null,
    amounts: amounts.map((a) => ({ value: a.value, unit: a.unit })),
  });
  return {
    fraction: out.fraction ?? null,
    // The same verdict the shopping list discloses, so the prep sheet's
    // "batch est." chip can say which fix is needed rather than just that
    // something was guessed.
    reason: (out.reason as SubRecipeBlockReason | undefined) ?? null,
  };
};

const massGrams: MassGramsPort = (amount) => {
  try {
    // No mappings: this asks only whether the unit is a mass on its own terms,
    // which is exactly what a yield denominator needs. A non-mass unit throws.
    return wasm.conv_amount_to_kind([], "weight", amount).value;
  } catch {
    return null;
  }
};

/**
 * Module-level and frozen so passing it into `buildRecipeTree` never
 * destabilizes the caller's `useMemo` deps.
 */
export const WASM_YIELD_PORTS: YieldPorts = { yieldFraction, massGrams };
