import type { NutritionBasis } from "@cubby/schemas/nutrition";
import type { RecipeTimes } from "@cubby/schemas/recipe";
import {
  recipeServingsForRead,
  type RecipeServingBasis,
} from "@cubby/schemas/recipe-shared";

import { scaleTotals } from "~/lib/nutrition-estimates";
import { formatEstimate } from "~/lib/nutrition-format";
import type { CalculateTotalsResult } from "~/lib/recipe-costing";
import { getRecipeIngredientName } from "~/lib/recipe-graph";
import { formatRecipeTime } from "~/lib/recipe-time";
import { roundTo, formatCurrency } from "~/lib/utils";
import { wasm } from "~/lib/wasm";

import { tryFormatAmount } from "../inventory/format-amount";
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

export const getEffectiveServings = recipeServingsForRead;

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
  recipe: RecipeServingBasis,
): ServingBasis | null => {
  const servings = getEffectiveServings(recipe);
  if (servings !== null && servings > 1)
    return { divisor: servings, noun: "serving" };
  const y = recipe.yield;
  if (y?.unit === "servings") return null;
  if (y?.value && y.value > 1) {
    const noun =
      !y.unit || y.unit === "whole" ? "each" : wasm.singularize_unit(y.unit);
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

/** Shared display basis, independent from the recipe's authored/scaled amounts. */
export function getRecipeNutritionBasis(
  recipe: RecipeServingBasis,
  requested: NutritionBasis = "whole",
  recipeScale = 1,
) {
  const servings = getEffectiveServings(recipe);
  if (requested === "serving" && servings && servings > 0)
    return {
      basis: "serving" as const,
      factor: 1 / (servings * recipeScale),
      label: "per serving",
      hasServing: true,
    };
  return {
    basis: "whole" as const,
    factor: 1,
    label: "whole scaled recipe",
    hasServing: servings != null && servings > 0,
  };
}

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
    const { basis } = opts;
    const estimates = scaleTotals(
      opts.totals.estimates,
      basis ? 1 / basis.divisor : 1,
    );
    parts.push(
      `${formatEstimate(estimates.cost, (n) => `${formatCurrency(n)}`)}${basis ? ` ${perUnitSuffix(basis.noun)}` : " total"}`,
      `${formatEstimate(estimates.nutrition.kcal, (n) => `${Math.round(n)} kcal`)}${basis ? ` ${perUnitSuffix(basis.noun)}` : ""}`,
      `${formatEstimate(estimates.nutrition.protein, (n) => `${roundTo(n, 1)} g protein`)}${basis ? ` ${perUnitSuffix(basis.noun)}` : ""}`,
    );
  }

  return parts.filter((p): p is string => Boolean(p));
}

/**
 * The compact cost + macro segments shown by the Read kicker and (per-serving)
 * the Prep component headers — `["$0.42", "740 kcal", "9g P", "5g F", "6g C"]`.
 * Values are divided by `basis` when one is given (per-serving) and shown as
 * totals otherwise; `basisLabel` ("per serving" / "total") is the single label a
 * caller prepends. Each segment retains its known range and completeness. */
export function recipeMacroSegments(
  totals: CalculateTotalsResult,
  basis: ServingBasis | null,
  opts?: { includeCost?: boolean },
): RecipeMacroSegmentList {
  const estimates = scaleTotals(
    totals.estimates,
    basis ? 1 / basis.divisor : 1,
  );

  const parts: string[] = [];
  if (opts?.includeCost !== false)
    parts.push(formatEstimate(estimates.cost, (n) => `${formatCurrency(n)}`));
  parts.push(
    formatEstimate(estimates.nutrition.kcal, (n) => `${Math.round(n)} kcal`),
  );
  parts.push(
    formatEstimate(estimates.nutrition.protein, (n) => `${roundTo(n, 1)} g P`),
  );
  parts.push(
    formatEstimate(estimates.nutrition.fat, (n) => `${roundTo(n, 1)} g F`),
  );
  parts.push(
    formatEstimate(estimates.nutrition.carbs, (n) => `${roundTo(n, 1)} g C`),
  );

  return { basisLabel: basis ? `per ${basis.noun}` : "total", parts };
}

interface RecipeMacroSegmentList {
  basisLabel: string;
  parts: string[];
}

export const getIngredientName = getRecipeIngredientName;

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
