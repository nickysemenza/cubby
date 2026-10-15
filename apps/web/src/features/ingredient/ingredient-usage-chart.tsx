import type { IngredientUsageRow } from "@cubby/schemas/ingredient-usage";
import { countLabel } from "@cubby/shared/pluralize";
import { CarrotIcon } from "@phosphor-icons/react/dist/csr/Carrot";

import { RankedBarBreakdown } from "~/ui/charts/kit";

// Cap the bar count so the chart stays legible; the full list lives in the table.
const MAX_BARS = 25;

export function IngredientUsageChart({
  rows,
  maxBars = MAX_BARS,
}: {
  rows: IngredientUsageRow[];
  maxBars?: number;
}) {
  const top = rows
    .slice(0, 3)
    .map((row) => `${row.name} ${countLabel(row.recipeCount, "recipe")}`)
    .join("; ");
  const summary = `Ingredient usage: ${top}; ${rows.length} ingredients total`;

  return (
    <RankedBarBreakdown
      data={rows.map((row) => ({
        ingredient: row.name,
        recipes: row.recipeCount,
      }))}
      valueKey="recipes"
      labelKey="ingredient"
      topN={maxBars}
      minHeight={300}
      rowHeight={28}
      heightPadding={60}
      margin={{ top: 10, right: 40, bottom: 32, left: 200 }}
      color={() => "var(--chart-2)"}
      showValueLabel
      labelSkipWidth={24}
      formatValue={(value) => countLabel(value, "recipe")}
      formatLabel={(value) => `${value}`}
      axisBottomFormat={(value) => `${value}`}
      emptyIcon={CarrotIcon}
      emptyTitle="No ingredient usage yet."
      summary={summary}
    />
  );
}
