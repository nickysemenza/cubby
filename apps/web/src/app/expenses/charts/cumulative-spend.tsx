import type { ExpenseCumulativePoint } from "@cubby/schemas/project";
import { TrendUpIcon as TrendingUp } from "@phosphor-icons/react/dist/csr/TrendUp";
import { useMemo } from "react";

import { SpendTrend } from "~/app/_components/charts/kit";
import { ChartEmpty } from "~/app/projects/charts/chart-empty";
import { monthLabel } from "~/app/projects/project-formatting";

/**
 * Monthly cumulative net spend — the analytics-view lens over
 * `expense.analytics`'s `cumulative` aggregate (a running sum the server
 * already computed over `monthly`). Point scale (not time scale) since the
 * server buckets by calendar month, same axis convention as `MonthlySpend`.
 */
export function CumulativeSpend({
  cumulative,
}: {
  cumulative: ExpenseCumulativePoint[];
}) {
  const points = useMemo(
    () =>
      cumulative.map((p) => ({ x: monthLabel(p.month), y: p.cumulativeNet })),
    [cumulative],
  );

  if (points.length === 0) {
    return <ChartEmpty icon={TrendingUp} title="No dated expense data." />;
  }

  const ys = points.map((p) => p.y);
  const minY = Math.min(0, ...ys);
  const maxY = Math.max(0, ...ys);

  const stride = Math.ceil(points.length / 12);
  const monthTicks = points.map((p) => p.x).filter((_, i) => i % stride === 0);

  return (
    <SpendTrend
      data={[{ id: "Cumulative net", data: points }]}
      margin={{ top: 20, right: 30, bottom: 50, left: 70 }}
      xScale={{ type: "point" }}
      yScale={{
        type: "linear",
        min: minY < 0 ? minY * 1.1 : 0,
        max: Math.max(maxY * 1.1, 10),
      }}
      axisBottom={{
        tickRotation: -45,
        tickValues: monthTicks,
      }}
      colors={["var(--chart-1)"]}
    />
  );
}
