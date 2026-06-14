import type { RecipeOut } from "@cubby/schemas/recipe";
import {
  getNutrientValueByKey,
  type NutrientsPer100,
} from "@cubby/usda-schemas";
import { formatCurrencyRange, formatNumberRange } from "~/lib/format-range";
import type { CalculateTotalsResult } from "~/lib/recipe-costing";
import { getRecipeIngredientName } from "~/lib/recipe-graph";
import { wasm } from "~/lib/wasm";

/** The four headline figures every recipe-summary surface shows (table, charts,
 * magazine kicker), pulled from a costing result in one place so all three agree
 * on which numbers they are — and on how calories/protein come out of the
 * nutrient map (by key, not by raw code). Accepts anything totals-shaped, so the
 * table card's RecipeSummaryData works as well as a CalculateTotalsResult. */
export type RecipeHeadlineTotals = {
  cost: number;
  costUpper?: number;
  weight: number;
  weightUpper?: number;
  calories: number;
  caloriesUpper?: number;
  protein: number;
  proteinUpper?: number;
};

// Range upper bound for a nutrient, or undefined when not ranged (a 0 from an
// absent code is meaningless, so collapse it).
const upperNutrient = (
  rec: NutrientsPer100 | undefined,
  key: Parameters<typeof getNutrientValueByKey>[1],
): number | undefined =>
  rec ? getNutrientValueByKey(rec, key) || undefined : undefined;

export const recipeHeadlineTotals = (t: {
  price: number;
  priceUpper?: number;
  weight: number;
  weightUpper?: number;
  nutrients: NutrientsPer100;
  nutrientsUpper?: NutrientsPer100;
}): RecipeHeadlineTotals => ({
  cost: t.price,
  costUpper: t.priceUpper,
  weight: t.weight,
  weightUpper: t.weightUpper,
  calories: getNutrientValueByKey(t.nutrients, "kcal"),
  caloriesUpper: upperNutrient(t.nutrientsUpper, "kcal"),
  protein: getNutrientValueByKey(t.nutrients, "protein"),
  proteinUpper: upperNutrient(t.nutrientsUpper, "protein"),
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
    // Per-portion division is linear, so divide both range bounds by the same
    // divisor (an absent upper stays absent → renders one number).
    const per = (n: number) => (basis ? n / basis.divisor : n);
    const perUpper = (u: number | undefined) =>
      u != null ? per(u) : undefined;
    const round = (n: number) => `${Math.round(n)}`;
    parts.push(
      head.cost && basis
        ? `${formatCurrencyRange(per(head.cost), perUpper(head.costUpper))} ${perUnitSuffix(basis.noun)}`
        : head.cost
          ? `${formatCurrencyRange(head.cost, head.costUpper)} total`
          : null,
      head.calories && basis
        ? `${formatNumberRange(per(head.calories), perUpper(head.caloriesUpper), round)} kcal ${perUnitSuffix(basis.noun)}`
        : null,
      head.protein && basis
        ? `${formatNumberRange(per(head.protein), perUpper(head.proteinUpper), round)}g protein ${perUnitSuffix(basis.noun)}`
        : null,
      head.weight && basis
        ? `${formatNumberRange(per(head.weight), perUpper(head.weightUpper), round)}g ${perUnitSuffix(basis.noun)}`
        : null,
    );
  }

  return parts.filter((p): p is string => Boolean(p));
}

export const getIngredientName = getRecipeIngredientName;
