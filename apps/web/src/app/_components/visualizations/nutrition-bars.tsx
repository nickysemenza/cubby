import {
  hasKnownEstimate,
  type MeasureEstimate,
  type NutritionEstimate,
} from "@cubby/schemas/nutrition";
import { useMemo } from "react";

import { StatTile } from "~/components/ui/stat-tile";
import { aggregateEstimates, scaleNutrition } from "~/lib/nutrition-estimates";
import { estimateStatusText, formatEstimate } from "~/lib/nutrition-format";
import type { IngredientDataItem } from "~/lib/recipe-costing";

import { VisualizationPlaceholder } from "./visualization-placeholder";

const SEGMENT_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
];

const MACROS = [
  { key: "fat", label: "Fat", color: "var(--chart-2)" },
  { key: "carbs", label: "Carbs", color: "var(--chart-3)" },
  { key: "protein", label: "Protein", color: "var(--chart-4)" },
] as const;

const ingredientName = (ingredient: IngredientDataItem): string =>
  ingredient.type === "ingredient"
    ? ingredient.ingredient.name
    : ingredient.recipe.name;

const formatKcal = (estimate: MeasureEstimate): string =>
  formatEstimate(estimate, (value) => `${Math.round(value)} kcal`);

const formatGrams = (estimate: MeasureEstimate): string =>
  formatEstimate(
    estimate,
    (value) => `${Number(value.toFixed(1)).toString()} g`,
  );

const estimateUsesKnownGeometry = (estimate: MeasureEstimate): boolean =>
  hasKnownEstimate(estimate) &&
  (estimate.status === "partial" ||
    (estimate.upper != null && estimate.upper !== estimate.lower));

const noCalorieGeometryMessage = (estimate: MeasureEstimate): string => {
  if (!hasKnownEstimate(estimate)) {
    return estimateStatusText(estimate) ?? "No calorie data available";
  }
  return estimate.lower === 0 &&
    (estimate.upper == null || estimate.upper === 0)
    ? "Known calorie total is 0 kcal"
    : "No ingredient-level calorie contributions available";
};

/**
 * Nutrition breakdown in Cubby's ruled chart style. Text keeps the canonical
 * estimate, including ranges and partial coverage. Bar geometry uses only the
 * known subtotal or lower range bound and says so whenever that differs from a
 * complete point estimate.
 */
export default function NutritionBars({
  ingredients,
  nutrition,
  basisLabel,
  factor = 1,
}: {
  ingredients: IngredientDataItem[];
  nutrition: NutritionEstimate | null;
  basisLabel: string;
  factor?: number;
}) {
  const {
    calorieRows,
    geometryKcal,
    macroTotals,
    maxMacro,
    usesKnownGeometry,
  } = useMemo(() => {
    const knownRows = ingredients
      .map((ingredient) => ({
        key: ingredient.id,
        name: ingredientName(ingredient),
        estimate: scaleNutrition(ingredient.nutrition, factor).kcal,
      }))
      .filter((row) => hasKnownEstimate(row.estimate) && row.estimate.lower > 0)
      .sort((a, b) =>
        hasKnownEstimate(a.estimate) && hasKnownEstimate(b.estimate)
          ? b.estimate.lower - a.estimate.lower
          : 0,
      );

    const topRows = knownRows.slice(0, 5);
    const remainingRows = knownRows.slice(5);
    const calorieRows =
      remainingRows.length === 0
        ? topRows
        : [
            ...topRows,
            {
              key: "other",
              name: "Other",
              estimate: aggregateEstimates(
                remainingRows.map((row) => row.estimate),
              ),
            },
          ];
    const geometryKcal = calorieRows.reduce(
      (total, row) =>
        total + (hasKnownEstimate(row.estimate) ? row.estimate.lower : 0),
      0,
    );
    const macroTotals = MACROS.map((macro) => ({
      ...macro,
      estimate: nutrition?.[macro.key] ?? null,
    }));
    const maxMacro = Math.max(
      ...macroTotals.map((row) =>
        row.estimate != null && hasKnownEstimate(row.estimate)
          ? row.estimate.lower
          : 0,
      ),
      1,
    );
    const usesKnownGeometry =
      calorieRows.some((row) => estimateUsesKnownGeometry(row.estimate)) ||
      (nutrition != null && estimateUsesKnownGeometry(nutrition.kcal));

    return {
      calorieRows,
      geometryKcal,
      macroTotals,
      maxMacro,
      usesKnownGeometry,
    };
  }, [factor, ingredients, nutrition]);

  if (nutrition == null) {
    return (
      <VisualizationPlaceholder
        message="Nutrition totals are not available"
        subMessage="Calculate recipe totals to see the breakdown"
        height={300}
      />
    );
  }

  const calorieTotal = nutrition.kcal;
  const macroUsesKnownGeometry = macroTotals.some(
    (macro) =>
      macro.estimate != null && estimateUsesKnownGeometry(macro.estimate),
  );

  return (
    <div className="space-y-4 p-1">
      <div>
        <StatTile label={`Calories by ingredient, ${basisLabel}`}>
          <span title={estimateStatusText(calorieTotal) ?? undefined}>
            {formatKcal(calorieTotal)}
          </span>
        </StatTile>

        {geometryKcal > 0 ? (
          <>
            <div
              className="mt-2 flex h-7 overflow-hidden border border-[var(--border)] bg-card"
              aria-label="Known calorie contributions by ingredient"
            >
              {calorieRows.map((row, index) => {
                const amount = hasKnownEstimate(row.estimate)
                  ? row.estimate.lower
                  : 0;
                const label = `${row.name}: ${formatKcal(row.estimate)}`;
                return (
                  <div
                    key={row.key}
                    aria-label={label}
                    title={label}
                    className="h-full border-r border-[var(--border)] last:border-r-0"
                    style={{
                      width: `${(amount / geometryKcal) * 100}%`,
                      backgroundColor:
                        SEGMENT_COLORS[index % SEGMENT_COLORS.length],
                    }}
                  />
                );
              })}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              {calorieRows.map((row, index) => (
                <span
                  key={row.key}
                  className="inline-flex items-center gap-2 font-mono text-2xs text-muted-foreground"
                >
                  <span
                    className="size-2 rounded-full border border-[var(--border)]"
                    style={{
                      backgroundColor:
                        SEGMENT_COLORS[index % SEGMENT_COLORS.length],
                    }}
                  />
                  {row.name} · {formatKcal(row.estimate)}
                </span>
              ))}
            </div>
            {usesKnownGeometry && (
              <p className="mt-2 font-mono text-2xs text-muted-foreground">
                Bar widths use known subtotals and lower range bounds; labels
                preserve coverage and ranges.
              </p>
            )}
          </>
        ) : (
          <div className="mt-2 flex min-h-16 items-center border border-[var(--border)] px-3 font-mono text-xs text-muted-foreground">
            {noCalorieGeometryMessage(calorieTotal)}
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 eyebrow">Macros, {basisLabel}</div>
        <div className="space-y-2">
          {macroTotals.map((macro) => {
            const estimate = macro.estimate;
            const knownAmount =
              estimate != null && hasKnownEstimate(estimate)
                ? estimate.lower
                : null;
            return (
              <section key={macro.key} aria-label={macro.label}>
                <div className="mb-1 flex justify-between font-mono text-2xs text-muted-foreground uppercase">
                  <span>{macro.label}</span>
                  <span
                    className="tabular-nums"
                    title={
                      estimate == null
                        ? "Nutrition totals are not available"
                        : (estimateStatusText(estimate) ?? undefined)
                    }
                  >
                    {estimate == null ? "—" : formatGrams(estimate)}
                  </span>
                </div>
                <div className="h-3.5 overflow-hidden border-[1.5px] border-[var(--border)] bg-card">
                  <div
                    className="h-full border-r-[1.5px] border-[var(--border)]"
                    style={{
                      width: `${knownAmount == null ? 0 : Math.min(100, (knownAmount / maxMacro) * 100)}%`,
                      backgroundColor: macro.color,
                      borderRightWidth: knownAmount == null ? 0 : undefined,
                    }}
                  />
                </div>
              </section>
            );
          })}
        </div>
        {macroUsesKnownGeometry && (
          <p className="mt-2 font-mono text-2xs text-muted-foreground">
            Bar lengths use known subtotals and lower range bounds.
          </p>
        )}
      </div>
    </div>
  );
}
