import type { ProjectPortfolioAnalyticsOut } from "@cubby/schemas/project";
import { CalendarClock } from "lucide-react";
import { useMemo } from "react";

import { SpendTrend } from "~/app/_components/charts/kit";

import { ChartEmpty } from "./chart-empty";

const SERIES_COLORS: Record<string, string> = {
  Actual: "var(--chart-1)",
  Committed: "var(--chart-7)", // light ink — reads as "not yet real"
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
        icon={CalendarClock}
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
      colors={(datum) => SERIES_COLORS[String(datum.id)] ?? "var(--chart-1)"}
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
