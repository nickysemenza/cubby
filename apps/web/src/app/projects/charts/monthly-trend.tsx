import type { PurchaseOut } from "@cubby/schemas/project";
import { useMemo } from "react";
import { CurrencyTrend } from "./currency-trend";
import { buildProjectMonthlySeries } from "./project-chart-data";

const PROJECT_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
  "var(--chart-8)",
];

export function MonthlyTrend({ purchases }: { purchases: PurchaseOut[] }) {
  const data = useMemo(() => buildProjectMonthlySeries(purchases), [purchases]);

  if (data.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Not enough data for a trend (need 2+ months).
      </p>
    );
  }

  return (
    <CurrencyTrend
      data={data}
      margin={{ top: 20, right: 130, bottom: 50, left: 70 }}
      xScale={{ type: "point" }}
      yScale={{ type: "linear", min: 0, stacked: true }}
      axisBottom={{ tickRotation: -45 }}
      areaOpacity={0.3}
      colors={(datum) => {
        const index = data.findIndex((series) => series.id === datum.id);
        return PROJECT_COLORS[index % PROJECT_COLORS.length]!;
      }}
      filterZeroValues
      seriesLabelClassName="max-w-[150px] truncate"
      legends={[
        {
          anchor: "bottom-right",
          direction: "column",
          translateX: 120,
          itemWidth: 110,
          itemHeight: 18,
          symbolSize: 10,
          symbolShape: "circle",
        },
      ]}
    />
  );
}
