import { TIER1_NUTRIENTS } from "@cubby/usda-schemas";
import { sumBy } from "es-toolkit";
import { useMemo } from "react";
import { StatTile } from "~/components/ui/stat-tile";
import { formatNumberRange, rangeMidpoint } from "~/lib/format-range";
import type {
  CalculateTotalsResult,
  IngredientDataItem,
} from "~/lib/recipe-costing";
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

function nutrientOf(ing: IngredientDataItem, code: string): number {
  const result = ing.priceInfo?.nutrient;
  return result?.isOk() ? (result.value[code] ?? 0) : 0;
}

function ingredientName(ing: IngredientDataItem): string {
  return ing.type === "ingredient"
    ? ing.ingredient.name
    : ing.type === "recipe"
      ? ing.recipe.name
      : "Unknown";
}

/**
 * Nutrition breakdown in the brand's ledger-chart language (replaces the old
 * sunburst): a bordered stacked bar of calories by ingredient, then one
 * bordered bar per macro. Flat ink-ladder fills and mono labels, ruled like a
 * printed figure — same as the homepage.
 */
export default function NutritionBars({
  ingredients,
  totals,
}: {
  ingredients: IngredientDataItem[];
  /** Whole-recipe rollup; macro totals read from here so they can't drift from
   *  the summary card. Null while loading — falls back to summing rows. */
  totals?: CalculateTotalsResult | null;
}) {
  const { kcalRows, totalKcal, macroTotals, maxMacro } = useMemo(() => {
    const kcalCode = TIER1_NUTRIENTS.kcal.code;
    const all = ingredients
      .map((ing) => ({
        key: ing.id,
        name: ingredientName(ing),
        kcal: nutrientOf(ing, kcalCode),
      }))
      .filter((r) => r.kcal > 0)
      .sort((a, b) => b.kcal - a.kcal);

    // Top contributors get their own segment; the tail folds into "other".
    const top = all.slice(0, 5);
    const otherKcal = sumBy(all.slice(5), (r) => r.kcal);
    const kcalRows =
      otherKcal > 0
        ? [...top, { key: "other", name: "other", kcal: otherKcal }]
        : top;

    // Total kcal stays row-derived so the stacked-segment widths sum to 100%.
    const totalKcal = sumBy(all, (r) => r.kcal);

    // Macro grams come from the engine's whole-recipe totals (same source the
    // summary card uses); fall back to summing rows while totals load.
    const macroTotals = MACROS.map((m) => {
      const code = TIER1_NUTRIENTS[m.key].code;
      const grams =
        totals?.nutrients[code] ??
        sumBy(ingredients, (ing) => nutrientOf(ing, code));
      // Upper bound only when the recipe is ranged; bar geometry uses the
      // midpoint so segments stay deterministic, the label shows the range.
      const gramsUpper = totals?.nutrientsUpper?.[code];
      return { ...m, grams, gramsUpper };
    });
    const maxMacro = Math.max(
      ...macroTotals.map((m) => rangeMidpoint(m.grams, m.gramsUpper)),
      1,
    );

    return { kcalRows, totalKcal, macroTotals, maxMacro };
  }, [ingredients, totals]);

  if (totalKcal === 0) {
    return (
      <VisualizationPlaceholder
        message="No nutrition data available"
        subMessage="Link ingredients to USDA foods to see the breakdown"
        height={300}
      />
    );
  }

  return (
    <div className="space-y-4 p-1">
      <div>
        <StatTile label="Calories by ingredient">
          {Math.round(totalKcal)} kcal
        </StatTile>
        <div className="mt-2 flex h-7 overflow-hidden border border-[var(--border)] bg-card">
          {kcalRows.map((row, i) => (
            <div
              key={row.key}
              title={`${row.name}: ${Math.round(row.kcal)} kcal`}
              className="h-full border-[var(--border)] border-r last:border-r-0"
              style={{
                width: `${(row.kcal / totalKcal) * 100}%`,
                backgroundColor: SEGMENT_COLORS[i % SEGMENT_COLORS.length],
              }}
            />
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {kcalRows.map((row, i) => (
            <span
              key={row.key}
              className="inline-flex items-center gap-2 font-mono text-2xs text-muted-foreground"
            >
              <span
                className="h-2 w-2 rounded-full border border-[var(--border)]"
                style={{
                  backgroundColor: SEGMENT_COLORS[i % SEGMENT_COLORS.length],
                }}
              />
              {row.name} · {Math.round(row.kcal)}
            </span>
          ))}
        </div>
      </div>

      <div>
        <div className="eyebrow mb-2">Macros, whole recipe</div>
        <div className="space-y-2">
          {macroTotals.map((m) => (
            <div key={m.key}>
              <div className="mb-1 flex justify-between font-mono text-2xs text-muted-foreground uppercase">
                <span>{m.label}</span>
                <span className="tabular-nums">
                  {m.grams > 0
                    ? `${formatNumberRange(m.grams, m.gramsUpper, (n) => `${Math.round(n)}`)} g`
                    : "—"}
                </span>
              </div>
              <div className="h-3.5 overflow-hidden border-[1.5px] border-[var(--border)] bg-card">
                <div
                  className="h-full border-[var(--border)] border-r-[1.5px]"
                  style={{
                    width: `${Math.min(100, (rangeMidpoint(m.grams, m.gramsUpper) / maxMacro) * 100)}%`,
                    backgroundColor: m.color,
                    borderRightWidth: m.grams > 0 ? undefined : 0,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
