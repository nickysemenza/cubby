import type { RecipeOut, SectionIngredientOut } from "@cubby/schemas/recipe";
import { match } from "ts-pattern";

import {
  type CalculateTotalsResult,
  fromWAmount,
  toWAmount,
} from "~/lib/recipe-costing";
import { wasm } from "~/lib/wasm";

// Recipe scaling is a purely derived, client-side transform: scale every
// ingredient amount (plus yield/servings) by a factor and feed the resulting
// RecipeOut through the existing display + costing pipeline. It sits upstream of
// the TS→WASM costing boundary, so the Rust engine reprices the scaled amounts
// for free. No DB writes, no persisted-totals invalidation.
//
// Which amounts actually scale is the WASM engine's call, not this module's —
// see `scale_amount`.

/** How the user anchors the scale; each resolves to a single numeric factor. */
export type ScaleAnchor =
  | { type: "multiplier"; value: number }
  | { type: "totalWeight"; grams: number }
  | { type: "ingredient"; rowId: string; newValue: number };

// Below this the recipe is effectively zeroed out; clamp so a stray 0/blank
// input can't wipe every amount or divide-by-zero.
const MIN_FACTOR = 0.01;

const clampFactor = (f: number): number =>
  Number.isFinite(f) && f > 0 ? Math.max(MIN_FACTOR, f) : 1;

/** Round a display value (yield/servings) to 2 decimals, stripping float noise. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

const findRow = (
  recipe: RecipeOut,
  rowId: string,
): SectionIngredientOut | undefined => {
  for (const section of recipe.sections) {
    const found = section.ingredients.find((i) => i.id === rowId);
    if (found) return found;
  }
  return undefined;
};

/**
 * Resolve an anchor to an absolute scale factor (>0) relative to the *unscaled*
 * recipe, given current costing context. `recipe` must be the original recipe;
 * `totals` reflects the currently-displayed (scaled) recipe, so `currentFactor`
 * is used to back out its unscaled total weight — otherwise a weight target
 * would compound on top of the existing scale.
 */
export const resolveScaleFactor = (
  anchor: ScaleAnchor,
  recipe: RecipeOut,
  totals: CalculateTotalsResult | null,
  currentFactor: number,
): number =>
  match(anchor)
    .with({ type: "multiplier" }, (a) => clampFactor(a.value))
    .with({ type: "totalWeight" }, (a) => {
      const scaledWeight = totals?.weight ?? 0;
      if (scaledWeight <= 0 || currentFactor <= 0) return 1;
      // totals.weight = unscaledWeight × currentFactor; recover the original.
      const unscaledWeight = scaledWeight / currentFactor;
      return clampFactor(a.grams / unscaledWeight);
    })
    .with({ type: "ingredient" }, (a) => {
      const orig = findRow(recipe, a.rowId)?.amounts[0]?.value;
      if (!orig || orig <= 0) return 1;
      return clampFactor(a.newValue / orig);
    })
    .exhaustive();

/**
 * Produce a derived recipe with every amount (and yield/servings) multiplied by
 * `factor`. IDs are preserved so strike-through state and the costing data fetch
 * are unaffected. Returns the input untouched at 1×.
 */
export const scaleRecipe = (recipe: RecipeOut, factor: number): RecipeOut => {
  if (factor === 1) return recipe;

  const sections = recipe.sections.map((section) => ({
    ...section,
    ingredients: section.ingredients.map((row) => ({
      ...row,
      amounts: row.amounts.map((a) => ({
        ...a,
        // Multiplying `value` here would resize the pan: a "(9-inch)" crust, a
        // 350°F oven and a 20-minute rest are amounts too, and none of them
        // scale. `scale_amount` applies the kind rule (and carries the range
        // upper bound, else "2–3 cups" would scale to "4–3 cups").
        ...fromWAmount(wasm.scale_amount(toWAmount(a), factor)),
      })),
    })),
  }));

  return {
    ...recipe,
    sections,
    // Scale yield/servings too so the summary card's "Makes" line stays coherent
    // and per-serving cost/calories stay invariant (both numerator and divisor
    // scale by the same factor).
    yield: recipe.yield
      ? { ...recipe.yield, value: round2(recipe.yield.value * factor) }
      : recipe.yield,
    servings:
      recipe.servings != null
        ? round2(recipe.servings * factor)
        : recipe.servings,
  };
};
