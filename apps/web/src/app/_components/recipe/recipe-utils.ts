import type { RecipeOut } from "@cubby/schemas/recipe";
import {
  getNutrientValueByKey,
  type NutrientsPer100,
} from "@cubby/usda-schemas";
import type { CalculateTotalsResult } from "~/lib/recipe-costing";
import { getRecipeIngredientName } from "~/lib/recipe-graph";
import { formatCurrency } from "~/lib/utils";
import { wasm } from "~/lib/wasm";

/** The four headline figures every recipe-summary surface shows (table, charts,
 * magazine kicker), pulled from a costing result in one place so all three agree
 * on which numbers they are — and on how calories/protein come out of the
 * nutrient map (by key, not by raw code). Accepts anything totals-shaped, so the
 * table card's RecipeSummaryData works as well as a CalculateTotalsResult. */
export type RecipeHeadlineTotals = {
  cost: number;
  weight: number;
  calories: number;
  protein: number;
};

export const recipeHeadlineTotals = (t: {
  price: number;
  weight: number;
  nutrients: NutrientsPer100;
}): RecipeHeadlineTotals => ({
  cost: t.price,
  weight: t.weight,
  calories: getNutrientValueByKey(t.nutrients, "kcal"),
  protein: getNutrientValueByKey(t.nutrients, "protein"),
});

/**
 * Format a recipe yield for display, e.g. "18 servings". A unitless yield
 * carries the parser's "whole" sentinel (a bare count); drop it so "18 whole"
 * renders as just "18".
 */
export const formatYield = (y: { value: number; unit: string }): string =>
  y.unit === "whole" ? `${y.value}` : `${y.value} ${y.unit}`;

/** Effective servings: explicit servings, or the yield value when its unit is "servings". */
export const getEffectiveServings = (recipe: RecipeOut): number | null => {
  if (recipe.servings) return recipe.servings;
  if (recipe.yield?.unit === "servings") return recipe.yield.value;
  return null;
};

/** How to express a per-portion figure: the count to divide totals by and the
 * noun to label it. Prefers an explicit servings count ("serving"); otherwise
 * falls back to the yield count, labelled by its unit — so "makes 2 cups" reads
 * "/ cup" and "makes 12 churros" reads "/ churro". A "servings" yield unit reads
 * "serving"; the parser's bare-count sentinel ("whole") and a unitless yield
 * have no noun, so they read "each" (e.g. "$0.29 each"). Returns null when
 * there's nothing meaningful to divide by (no servings/yield, or a count of one
 * — where the per-unit figure would just equal the total). */
export type ServingBasis = { divisor: number; noun: string };

export const getServingBasis = (recipe: RecipeOut): ServingBasis | null => {
  if (recipe.servings && recipe.servings > 1)
    return { divisor: recipe.servings, noun: "serving" };
  const y = recipe.yield;
  if (y?.value && y.value > 1) {
    const noun =
      !y.unit || y.unit === "whole"
        ? "each"
        : y.unit === "servings"
          ? "serving"
          : wasm.singularize_unit(y.unit);
    return { divisor: y.value, noun };
  }
  return null;
};

/** Inline suffix for a per-unit figure: "each", else "/ {noun}".
 * → "$0.29 each", "$0.42 / serving", "$1.10 / cup". */
export const perUnitSuffix = (noun: string): string =>
  noun === "each" ? "each" : `/ ${noun}`;

/**
 * The recipe vitals line — "Makes X · Serves Y · $cost / serving · kcal · g
 * protein" — built once for every surface that shows it. Without `opts.totals`
 * (the draft live-preview, where nothing's costed yet) it degrades to just the
 * Makes/Serves prefix. Callers join the parts with their own separator. The
 * yield label follows `formatYield`'s "whole"-sentinel handling (a bare count
 * drops the unit).
 */
export function buildRecipeKicker(
  input: {
    yield?: { value?: number | null; unit?: string | null } | null;
    servings?: number | null;
  },
  opts?: { totals: CalculateTotalsResult; basis: ServingBasis | null },
): string[] {
  const y = input.yield;
  const parts: Array<string | null> = [
    y?.value
      ? `Makes ${!y.unit || y.unit === "whole" ? y.value : `${y.value} ${y.unit}`}`
      : null,
    input.servings && y?.unit !== "servings"
      ? `Serves ${input.servings}`
      : null,
  ];

  if (opts) {
    const head = recipeHeadlineTotals(opts.totals);
    const { basis } = opts;
    parts.push(
      head.cost && basis
        ? `${formatCurrency(head.cost / basis.divisor)} ${perUnitSuffix(basis.noun)}`
        : head.cost
          ? `${formatCurrency(head.cost)} total`
          : null,
      head.calories && basis
        ? `${Math.round(head.calories / basis.divisor)} kcal ${perUnitSuffix(basis.noun)}`
        : null,
      head.protein && basis
        ? `${Math.round(head.protein / basis.divisor)}g protein ${perUnitSuffix(basis.noun)}`
        : null,
      head.weight && basis
        ? `${Math.round(head.weight / basis.divisor)}g ${perUnitSuffix(basis.noun)}`
        : null,
    );
  }

  return parts.filter((p): p is string => Boolean(p));
}

export const getIngredientName = getRecipeIngredientName;
