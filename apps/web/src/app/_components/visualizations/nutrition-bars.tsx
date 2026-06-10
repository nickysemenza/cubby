import { TIER1_NUTRIENTS } from "@cubby/usda-schemas";
import { useMemo } from "react";
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
 * bordered bar per macro. Same warm ramp and mono labels as the homepage.
 */
export default function NutritionBars({
  ingredients,
}: {
  ingredients: IngredientDataItem[];
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
    const otherKcal = all.slice(5).reduce((acc, r) => acc + r.kcal, 0);
    const kcalRows =
      otherKcal > 0
        ? [...top, { key: "other", name: "other", kcal: otherKcal }]
        : top;

    const totalKcal = all.reduce((acc, r) => acc + r.kcal, 0);

    const macroTotals = MACROS.map((m) => ({
      ...m,
      grams: ingredients.reduce(
        (acc, ing) => acc + nutrientOf(ing, TIER1_NUTRIENTS[m.key].code),
        0,
      ),
    }));
    const maxMacro = Math.max(...macroTotals.map((m) => m.grams), 1);

    return { kcalRows, totalKcal, macroTotals, maxMacro };
  }, [ingredients]);

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
    <div className="space-y-5 p-1">
      <div>
        <div className="font-mono text-2xs text-eyebrow uppercase tracking-wider">
          Calories by ingredient
        </div>
        <div className="mt-1 font-mono font-semibold text-xl tabular-nums">
          {Math.round(totalKcal)} kcal
        </div>
        <div className="mt-2 flex h-7 overflow-hidden rounded-md border-2 border-[var(--border-chunky)] bg-card">
          {kcalRows.map((row, i) => (
            <div
              key={row.key}
              title={`${row.name}: ${Math.round(row.kcal)} kcal`}
              className="h-full border-[var(--border-chunky)] border-r last:border-r-0"
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
              className="inline-flex items-center gap-1.5 font-mono text-2xs text-muted-foreground"
            >
              <span
                className="h-2 w-2 rounded-full border border-[var(--border-chunky)]"
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
        <div className="mb-2 font-mono text-2xs text-eyebrow uppercase tracking-wider">
          Macros, whole recipe
        </div>
        <div className="space-y-2.5">
          {macroTotals.map((m) => (
            <div key={m.key}>
              <div className="mb-0.5 flex justify-between font-mono text-2xs text-muted-foreground uppercase">
                <span>{m.label}</span>
                <span className="tabular-nums">
                  {m.grams > 0 ? `${Math.round(m.grams)} g` : "—"}
                </span>
              </div>
              <div className="h-3.5 overflow-hidden rounded-sm border-[1.5px] border-[var(--border-chunky)] bg-card">
                <div
                  className="h-full border-[var(--border-chunky)] border-r-[1.5px]"
                  style={{
                    width: `${Math.min(100, (m.grams / maxMacro) * 100)}%`,
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
