import type { ExpenseCumulativePoint } from "@cubby/schemas/project";
import { ResponsiveLine } from "@nivo/line";
import { TrendingUp } from "lucide-react";
import { useMemo } from "react";
import { ChartTooltip } from "~/app/projects/charts/ChartTooltip";
import { ChartEmpty } from "~/app/projects/charts/chart-empty";
import { monthLabel } from "~/app/projects/project-formatting";
import { nivoChartTheme, nivoMotion } from "~/lib/nivo-theme";
import { formatCurrency } from "~/lib/utils";

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
    <div className="h-[300px]">
      <ResponsiveLine
        {...nivoMotion}
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
        axisLeft={{
          format: (v: number) => formatCurrency(v, 0),
        }}
        enableArea
        areaOpacity={0.1}
        colors={["var(--chart-1)"]}
        pointSize={6}
        pointColor="var(--card)"
        pointBorderWidth={2}
        pointBorderColor="var(--chart-1)"
        useMesh
        enableSlices="x"
        sliceTooltip={({ slice }) => (
          <ChartTooltip>
            {slice.points.map((point) => (
              <div key={point.id}>
                <span className="text-muted-foreground">
                  {point.data.xFormatted}
                </span>
                {": "}
                <strong>{formatCurrency(point.data.y as number, 0)}</strong>
              </div>
            ))}
          </ChartTooltip>
        )}
        theme={nivoChartTheme}
      />
    </div>
  );
}
