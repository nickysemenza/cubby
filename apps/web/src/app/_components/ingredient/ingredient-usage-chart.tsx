import type { IngredientUsageRow } from "@cubby/schemas/ingredient-usage";
import { ResponsiveBar } from "@nivo/bar";
import { Carrot } from "lucide-react";
import { useId, useMemo } from "react";
import { ChartTooltip } from "~/app/projects/charts/ChartTooltip";
import { ChartEmpty } from "~/app/projects/charts/chart-empty";
import { nivoBarChrome, nivoChartTheme } from "~/lib/nivo-theme";

// Cap the bar count so the chart stays legible; the full list lives in the table.
const MAX_BARS = 25;

export function IngredientUsageChart({
  rows,
  maxBars = MAX_BARS,
}: {
  rows: IngredientUsageRow[];
  maxBars?: number;
}) {
  // Nivo draws horizontal bars bottom-up, so reverse to put the most-used on top.
  const data = rows
    .slice(0, maxBars)
    .map((r) => ({ ingredient: r.name, recipes: r.recipeCount }))
    .reverse();

  const summaryId = useId();
  const chartSummary = useMemo(() => {
    const top = rows
      .slice(0, 3)
      .map(
        (row) =>
          `${row.name} ${row.recipeCount} recipe${row.recipeCount === 1 ? "" : "s"}`,
      )
      .join("; ");
    return `Ingredient usage: ${top}; ${rows.length} ingredients total`;
  }, [rows]);

  if (data.length === 0) {
    return <ChartEmpty icon={Carrot} title="No ingredient usage yet." />;
  }

  const chartHeight = Math.max(300, data.length * 28 + 60);

  return (
    <div
      role="img"
      aria-label={chartSummary}
      aria-describedby={summaryId}
      style={{ height: chartHeight }}
    >
      <p id={summaryId} className="sr-only">
        {chartSummary}.
      </p>
      <ResponsiveBar
        data={data}
        keys={["recipes"]}
        indexBy="ingredient"
        layout="horizontal"
        margin={{ top: 10, right: 40, bottom: 32, left: 200 }}
        padding={0.25}
        // --chart-1 is Live Ultramarine, reserved for one live/interactive
        // value (DESIGN.md "One Loud Thing" rule) — a bar chart with every
        // series in the accent decorates the whole panel instead. --chart-2
        // is the darkest neutral ink tone, matching open-tasks-by-project.tsx.
        colors={() => "var(--chart-2)"}
        {...nivoBarChrome}
        axisBottom={{ tickSize: 0, tickPadding: 8 }}
        axisLeft={{ tickSize: 0, tickPadding: 8 }}
        label={(d) => (d.value ? String(d.value) : "")}
        labelSkipWidth={24}
        labelTextColor="var(--background)"
        enableGridX
        enableGridY={false}
        tooltip={({ value, indexValue }) => (
          <ChartTooltip>
            <strong>{indexValue}</strong> — {value} recipe
            {value === 1 ? "" : "s"}
          </ChartTooltip>
        )}
        theme={nivoChartTheme}
      />
    </div>
  );
}
