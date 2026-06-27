import type {
  RecipeOut,
  SectionIngredientOut,
} from "@cubby/schemas/recipe-responses";
import { match } from "ts-pattern";
import type { CalculateTotalsResult } from "~/lib/recipe-costing";

// Recipe scaling is a purely derived, client-side transform: multiply every
// ingredient amount (plus yield/servings) by a factor and feed the resulting
// RecipeOut through the existing display + costing pipeline. It sits upstream of
// the TS→WASM costing boundary, so the Rust engine reprices the scaled amounts
// for free. No DB writes, no persisted-totals invalidation.

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
        value: a.value * factor,
        // Scale the range upper bound too, else "2–3 cups" scales to "4–3 cups".
        ...(a.upperValue != null ? { upperValue: a.upperValue * factor } : {}),
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
