import type { RecipeOut, RecipeTimes } from "@cubby/schemas/recipe";
import {
  getNutrientValueByKey,
  type NutrientsPer100,
} from "@cubby/usda-schemas";
import { match } from "ts-pattern";

import { formatCurrencyRange, formatNumberRange } from "~/lib/format-range";
import type { CalculateTotalsResult } from "~/lib/recipe-costing";
import { getRecipeIngredientName } from "~/lib/recipe-graph";
import { wasm } from "~/lib/wasm";

import { tryFormatAmount } from "../inventory/format-amount";
import type { RecipeTreeRow } from "./recipe-tree";
import { formatYield } from "./recipe-yield";

/** Format a gram weight as a display amount, e.g. 184.2 → "184 g". The single
 * grams formatter for the prep sheet, matrix, and shopping list. */
export const gramText = (grams: number): string =>
  tryFormatAmount({ value: Math.round(grams * 100) / 100, unit: "g" });

/**
 * A component's full-batch yield for the "makes …" label — the recipe's own
 * yield when set ("8 servings", "1.2 kg"), else the resolved batch weight in
 * grams. One helper so the prep header and the matrix column header always
 * agree on how a batch is described.
 */
export const formatMakes = (
  recipeYield: { value: number; unit: string } | null | undefined,
  batchWeightGrams: number | null,
): string | null => {
  if (recipeYield?.value) return formatYield(recipeYield);
  return batchWeightGrams != null ? gramText(batchWeightGrams) : null;
};

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

export const getServingBasis = (
  recipe: Pick<RecipeOut, "servings" | "yield">,
): ServingBasis | null => {
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

/** Inline suffix for a per-unit figure: "each" (short "ea"), else "/ {noun}".
 * → "$0.29 each", "$0.42 / serving", "$1.10 / cup". */
export const perUnitSuffix = (
  noun: string,
  opts?: { short?: boolean },
): string => (noun === "each" ? (opts?.short ? "ea" : "each") : `/ ${noun}`);

/** Divide a total and its optional range upper by a per-serving divisor.
 * Per-portion division is linear, so both bounds divide by the same number; an
 * absent upper stays absent (renders one number). Shared by the recipe list
 * columns and the entity summary card so the per-portion math lives in one place. */
export const perServingRange = (
  total: number,
  upper: number | undefined,
  divisor: number,
): { value: number; upper: number | undefined } => ({
  value: total / divisor,
  upper: upper != null ? upper / divisor : undefined,
});

/** Divide every value in a nutrients record by a per-serving divisor — the
 * same linear per-portion math as {@link perServingRange}, applied to a whole
 * `NutrientsPer100` record instead of one figure. Used to feed a whole-recipe
 * totals record into a per-serving `NutritionLabel`. */
export const divideNutrients = (
  nutrients: NutrientsPer100,
  divisor: number,
): NutrientsPer100 =>
  Object.fromEntries(
    Object.entries(nutrients).map(([code, value]) => [code, value / divisor]),
  );

/** Coverage of a computed total (cost/calories) by the ingredients that had the
 * underlying data. `complete` drives dimming / caption suppression (unknown
 * coverage counts as complete); `fraction` is the bare "9/13" label shown when
 * partial. Shared by the recipe list cell and the preview card so the predicate
 * and the label can't disagree. */
export const coverageLabel = (
  covered: number | undefined,
  total: number,
): { complete: boolean; fraction: string } => ({
  complete: covered == null || covered >= total,
  fraction: `${covered ?? total}/${total}`,
});

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
    y?.value ? `Makes ${formatYield({ value: y.value, unit: y.unit })}` : null,
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

/**
 * The compact cost + macro segments shown by the Read kicker and (per-serving)
 * the Prep component headers — `["$0.42", "740 kcal", "9g P", "5g F", "6g C"]`.
 * Values are divided by `basis` when one is given (per-serving) and shown as
 * totals otherwise; `basisLabel` ("per serving" / "total") is the single label a
 * caller prepends, so the per-unit noun isn't repeated on every segment. Pulls
 * fat & carbs (which the four-figure {@link recipeHeadlineTotals} omits) so the
 * reader view shows a full macro split. Cost/calories carry their range upper;
 * the gram macros render a single rounded value. */
export function recipeMacroSegments(
  totals: {
    price: number;
    priceUpper?: number;
    weight: number;
    weightUpper?: number;
    nutrients: NutrientsPer100;
    nutrientsUpper?: NutrientsPer100;
  },
  basis: ServingBasis | null,
  opts?: { includeCost?: boolean },
): { basisLabel: string; parts: string[] } {
  const head = recipeHeadlineTotals(totals);
  const fat = getNutrientValueByKey(totals.nutrients, "fat") || undefined;
  const carbs = getNutrientValueByKey(totals.nutrients, "carbs") || undefined;
  const div = basis ? basis.divisor : 1;
  const per = (n: number) => n / div;
  const perUpper = (u: number | undefined) => (u != null ? per(u) : undefined);
  const round = (n: number) => `${Math.round(n)}`;

  const parts: string[] = [];
  if (head.cost && opts?.includeCost !== false)
    parts.push(formatCurrencyRange(per(head.cost), perUpper(head.costUpper)));
  if (head.calories)
    parts.push(
      `${formatNumberRange(per(head.calories), perUpper(head.caloriesUpper), round)} kcal`,
    );
  if (head.protein) parts.push(`${round(per(head.protein))}g P`);
  if (fat) parts.push(`${round(per(fat))}g F`);
  if (carbs) parts.push(`${round(per(carbs))}g C`);

  return { basisLabel: basis ? `per ${basis.noun}` : "total", parts };
}

/** Structured cost + macro numbers (per-serving when a basis is given, else
 * total) for the Read view's vitals card — same figures as
 * {@link recipeMacroSegments} but as raw numbers, so the card can draw a macro
 * proportion bar. Zero/absent values come back null so the card omits them. */
export type RecipeMacroStats = {
  basisLabel: string;
  cost: number | null;
  kcal: number | null;
  protein: number | null;
  fat: number | null;
  carbs: number | null;
};

export function recipeMacroStats(
  totals: { price: number; nutrients: NutrientsPer100 },
  basis: ServingBasis | null,
): RecipeMacroStats {
  const div = basis ? basis.divisor : 1;
  const per = (n: number) => n / div;
  const nz = (n: number): number | null => (n > 0 ? per(n) : null);
  return {
    basisLabel: basis ? `per ${basis.noun}` : "total",
    cost: totals.price > 0 ? per(totals.price) : null,
    kcal: nz(getNutrientValueByKey(totals.nutrients, "kcal")),
    protein: nz(getNutrientValueByKey(totals.nutrients, "protein")),
    fat: nz(getNutrientValueByKey(totals.nutrients, "fat")),
    carbs: nz(getNutrientValueByKey(totals.nutrients, "carbs")),
  };
}

export const getIngredientName = getRecipeIngredientName;

/**
 * The entity a tree row links to: ingredient leaves → their ingredient,
 * sub-recipe rows → their child recipe. Stub rows (cycle/missing) have no
 * target and render as plain text. Drives the link + hover-preview in the prep,
 * matrix, and nested-spec views.
 */
export const entityRefForRow = (
  row: RecipeTreeRow,
): {
  entity: "recipe" | "ingredient";
  id: string;
  shortcode: string;
} | null =>
  match(row)
    .with({ kind: "subrecipe" }, (r) => ({
      entity: "recipe" as const,
      id: r.child.recipe.id,
      shortcode: r.child.recipe.id,
    }))
    .with({ kind: "ingredient" }, (r) =>
      r.row.type === "ingredient"
        ? {
            entity: "ingredient" as const,
            id: r.row.ingredient.id,
            shortcode: r.row.ingredient.id,
          }
        : null,
    )
    .with({ kind: "stub" }, () => null)
    .exhaustive();

// Re-exported so the ~18 existing `formatYield` imports from recipe-utils
// keep working; the implementation lives in the wasm-free module.
export { formatYield };

/**
 * A recipe time for display. The prose string wins whenever it exists — it is
 * verbatim what the source printed ("about 1½ hours, plus overnight chilling"),
 * and re-rendering that from the minute count would both round it and drop the
 * qualifier. The count is the fallback for a time that arrived as a number
 * without prose, and is what the list sorts and filters on.
 */
export const formatRecipeTime = (
  prose: string | null | undefined,
  minutes: number | null | undefined,
): string | null => {
  const trimmed = prose?.trim();
  if (trimmed) return trimmed;
  if (minutes == null) return null;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
};

/** The recipe's times as ordered display rows, skipping the ones the source
 * never printed. Total leads: it is the axis the list sorts on. */
export const recipeTimeEntries = (
  times: RecipeTimes | null | undefined,
): { label: string; value: string }[] =>
  (
    [
      ["Total", times?.total, times?.totalMinutes],
      ["Active", times?.active, times?.activeMinutes],
      ["Prep", times?.prep, times?.prepMinutes],
      ["Cook", times?.cook, times?.cookMinutes],
    ] as const
  ).flatMap(([label, prose, minutes]) => {
    const value = formatRecipeTime(prose, minutes);
    return value ? [{ label, value }] : [];
  });
