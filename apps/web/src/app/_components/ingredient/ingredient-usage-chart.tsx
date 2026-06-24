import type { IngredientUsageRow } from "@cubby/schemas/ingredient-usage";
import { ResponsiveBar } from "@nivo/bar";
import { Carrot } from "lucide-react";
import { ChartEmpty } from "~/app/projects/charts/chart-empty";
import { nivoBarChrome, nivoChartTheme } from "~/lib/nivo-theme";

// Cap the bar count so the chart stays legible; the full list lives in the table.
const MAX_BARS = 25;

export function IngredientUsageChart({ rows }: { rows: IngredientUsageRow[] }) {
  // Nivo draws horizontal bars bottom-up, so reverse to put the most-used on top.
  const data = rows
    .slice(0, MAX_BARS)
    .map((r) => ({ ingredient: r.name, recipes: r.recipeCount }))
    .reverse();

  if (data.length === 0) {
    return <ChartEmpty icon={Carrot} title="No ingredient usage yet." />;
  }

  const chartHeight = Math.max(300, data.length * 28 + 60);

  return (
    <div style={{ height: chartHeight }}>
      <ResponsiveBar
        data={data}
        keys={["recipes"]}
        indexBy="ingredient"
        layout="horizontal"
        margin={{ top: 10, right: 40, bottom: 32, left: 200 }}
        padding={0.25}
        colors={() => "var(--chart-1)"}
        {...nivoBarChrome}
        axisBottom={{ tickSize: 0, tickPadding: 8 }}
        axisLeft={{ tickSize: 0, tickPadding: 8 }}
        label={(d) => (d.value ? String(d.value) : "")}
        labelSkipWidth={24}
        labelTextColor="white"
        enableGridX
        enableGridY={false}
        tooltip={({ value, indexValue }) => (
          <div className="rounded-md bg-popover px-2 py-2 text-sm shadow-md ring-1 ring-border">
            <strong>{indexValue}</strong> — {value} recipe
            {value === 1 ? "" : "s"}
          </div>
        )}
        theme={nivoChartTheme}
      />
    </div>
  );
}
