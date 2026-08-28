import { HorizontalBarChart } from "~/app/_components/charts/kit";
import { formatCurrency } from "~/lib/utils";

import { nivoBarChrome, nivoChartTheme, nivoCurrencyAxis } from "../shared";
import { ChartTooltip } from "./ChartTooltip";

export type PlannedActualDatum = {
  category: string;
  actual: number;
  planned: number;
};

const seriesColors = {
  actual: "var(--chart-1)",
  planned: "var(--chart-7)",
} satisfies Record<"actual" | "planned", string>;

const seriesLabels = {
  actual: "Actual",
  planned: "Planned",
} satisfies Record<"actual" | "planned", string>;

const isSeriesName = (value: string): value is keyof typeof seriesColors =>
  Object.hasOwn(seriesColors, value);

type SeriesId = string | number;

const seriesLabelFor = (value: SeriesId): string => {
  const id = String(value);
  return isSeriesName(id) ? seriesLabels[id] : id;
};

/** Shared renderer; callers own only their domain-specific aggregation. */
export function PlannedActualBar({ data }: { data: PlannedActualDatum[] }) {
  return (
    <HorizontalBarChart
      data={data}
      minHeight={220}
      rowHeight={56}
      heightPadding={80}
      keys={["actual", "planned"]}
      indexBy="category"
      groupMode="grouped"
      margin={{ top: 10, right: 60, bottom: 60, left: 110 }}
      padding={0.25}
      innerPadding={2}
      colors={(bar) => {
        const id = String(bar.id);
        return isSeriesName(id) ? seriesColors[id] : "var(--chart-neutral)";
      }}
      {...nivoBarChrome}
      axisBottom={nivoCurrencyAxis}
      axisLeft={{ tickSize: 0, tickPadding: 8 }}
      label={(datum) =>
        datum.value && datum.value > 0 ? formatCurrency(datum.value, 0) : ""
      }
      labelSkipWidth={40}
      labelTextColor="var(--background)"
      enableGridX
      enableGridY={false}
      tooltip={({ id, value, indexValue, color }) => (
        <ChartTooltip>
          <strong>{indexValue}</strong> — {seriesLabelFor(id)}:{" "}
          <span style={{ color }}>{formatCurrency(value, 0)}</span>
        </ChartTooltip>
      )}
      legendLabel={(datum) => seriesLabelFor(datum.id)}
      legends={[
        {
          dataFrom: "keys",
          anchor: "bottom",
          direction: "row",
          translateY: 50,
          itemWidth: 100,
          itemHeight: 20,
          symbolSize: 12,
          symbolShape: "circle",
          itemTextColor: "var(--muted-foreground)",
        },
      ]}
      theme={nivoChartTheme}
    />
  );
}
