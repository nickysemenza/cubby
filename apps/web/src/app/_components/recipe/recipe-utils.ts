import type { NutritionBasis } from "@cubby/schemas/nutrition";
import type { RecipeOut, RecipeTimes } from "@cubby/schemas/recipe";
import { match } from "ts-pattern";

import { scaleTotals } from "~/lib/nutrition-estimates";
import { formatEstimate } from "~/lib/nutrition-format";
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

/** Effective servings: explicit servings, or the yield value when its unit is "servings". */
export const getEffectiveServings = (
  recipe: Pick<RecipeOut, "servings" | "yield">,
): number | null => {
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

/** Shared display basis, independent from the recipe's authored/scaled amounts. */
export function getRecipeNutritionBasis(
  recipe: Pick<RecipeOut, "servings" | "yield">,
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
      `${formatEstimate(estimates.cost, (n) => `$${n.toFixed(2)}`)}${basis ? ` ${perUnitSuffix(basis.noun)}` : " total"}`,
      `${formatEstimate(estimates.nutrition.kcal, (n) => `${Math.round(n)} kcal`)}${basis ? ` ${perUnitSuffix(basis.noun)}` : ""}`,
      `${formatEstimate(estimates.nutrition.protein, (n) => `${Number(n.toFixed(1))} g protein`)}${basis ? ` ${perUnitSuffix(basis.noun)}` : ""}`,
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
    parts.push(formatEstimate(estimates.cost, (n) => `$${n.toFixed(2)}`));
  parts.push(
    formatEstimate(estimates.nutrition.kcal, (n) => `${Math.round(n)} kcal`),
  );
  parts.push(
    formatEstimate(
      estimates.nutrition.protein,
      (n) => `${Number(n.toFixed(1))} g P`,
    ),
  );
  parts.push(
    formatEstimate(
      estimates.nutrition.fat,
      (n) => `${Number(n.toFixed(1))} g F`,
    ),
  );
  parts.push(
    formatEstimate(
      estimates.nutrition.carbs,
      (n) => `${Number(n.toFixed(1))} g C`,
    ),
  );

  return { basisLabel: basis ? `per ${basis.noun}` : "total", parts };
}

interface RecipeMacroSegmentList {
  basisLabel: string;
  parts: string[];
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
