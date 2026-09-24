import type { ProjectPortfolioAnalyticsOut } from "@cubby/schemas/project";
import { CalendarCheckIcon } from "@phosphor-icons/react/dist/csr/CalendarCheck";
import { useMemo } from "react";

import { SpendTrend } from "~/app/_components/charts/kit";

import { ChartEmpty } from "./chart-empty";

const seriesColor = (seriesId: string | number) => {
  if (seriesId === "Actual") return "var(--chart-1)";
  if (seriesId === "Committed") return "var(--chart-7)";
  return "var(--chart-1)";
};

/**
 * `data` is `portfolioAnalytics`'s `monthlySpend` — actual vs committed spend
 * per month, across every project matching the dashboard's filter scope (see
 * repo/project/portfolio-analytics.ts). This replaces the old per-project
 * stacked series (`buildProjectMonthlySeries` over raw expenses) — the
 * server aggregate has no per-project breakdown, only actual/committed
 * totals, so the chart now reads as "when did money move" rather than "which
 * project was spending".
 */
export function MonthlyTrend({
  data: rows,
}: {
  data: ProjectPortfolioAnalyticsOut["monthlySpend"];
}) {
  const data = useMemo(
    () => [
      {
        id: "Actual",
        data: rows.map((r) => ({ x: r.month, y: r.actual })),
      },
      {
        id: "Committed",
        data: rows.map((r) => ({ x: r.month, y: r.committed })),
      },
    ],
    [rows],
  );

  if (rows.length < 2) {
    return (
      <ChartEmpty
        icon={CalendarCheckIcon}
        title="Not enough data for a trend (need 2+ months)."
      />
    );
  }

  return (
    <SpendTrend
      data={data}
      margin={{ top: 20, right: 110, bottom: 50, left: 70 }}
      xScale={{ type: "point" }}
      yScale={{ type: "linear", min: 0, stacked: false }}
      axisBottom={{ tickRotation: -45 }}
      areaOpacity={0.15}
      colors={(datum) => seriesColor(datum.id)}
      filterZeroValues
      legends={[
        {
          anchor: "bottom-right",
          direction: "column",
          translateX: 100,
          itemWidth: 90,
          itemHeight: 18,
          symbolSize: 10,
          symbolShape: "circle",
        },
      ]}
    />
  );
}
