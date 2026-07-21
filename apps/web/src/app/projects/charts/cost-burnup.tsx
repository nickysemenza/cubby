import type { PurchaseOut } from "@cubby/schemas/project";
import { ResponsiveLine } from "@nivo/line";
import { Wallet } from "lucide-react";
import { useMemo } from "react";
import { formatCurrency } from "~/lib/utils";
import { nivoChartTheme } from "../shared";
import { ChartTooltip } from "./ChartTooltip";
import { ChartEmpty } from "./chart-empty";

/**
 * Cumulative purchase spend over a project's life, against `costEstimate` as
 * a horizontal reference line. Same nivo-line approach as `SpendingOverTime`
 * (same directory) so the two read as one system — this one adds a
 * budget-crossing signal: the reference line and the points themselves
 * switch from `--positive`/`--warning` to `--destructive` once cumulative
 * spend passes the estimate, so "did this blow the budget, and when" reads
 * at a glance instead of requiring the viewer to eyeball two series.
 *
 * Negative purchases are real (refunds, and large negative family
 * contributions) — never filter to `cost > 0`, or the curve stops
 * reconciling with the project's actual spend. That also means the
 * cumulative curve isn't guaranteed monotonic, so the y-scale's min is
 * clamped to the lowest point (which may be negative), not hardcoded to 0.
 */
export function CostBurnup({
  purchases,
  costEstimate,
}: {
  purchases: PurchaseOut[];
  costEstimate: number | null;
}) {
  const points = useMemo(() => {
    const dated = purchases
      .filter((p) => p.date != null && p.cost != null)
      .sort((a, b) => a.date!.localeCompare(b.date!));

    if (dated.length === 0) return [];

    let cumulative = 0;
    return dated.map((p) => {
      cumulative += p.cost!;
      return { x: p.date!, y: cumulative };
    });
  }, [purchases]);

  if (points.length === 0) {
    return <ChartEmpty icon={Wallet} title="No dated purchase data." />;
  }

  const data = [{ id: "Cumulative Spend", data: points }];

  const ys = points.map((p) => p.y);
  const minY = Math.min(0, ...ys);
  const maxY = Math.max(0, ...ys);
  const finalSpend = points[points.length - 1]!.y;

  const yMax = Math.max(
    costEstimate ? Math.max(maxY * 1.1, costEstimate * 1.15) : maxY * 1.1,
    10,
  );
  const yMin = minY < 0 ? minY * 1.1 : 0;

  // Budget status drives the reference line + point coloring below —
  // destructive once over, warning when close (>=90%), positive otherwise.
  // No estimate at all falls back to the neutral brand accent.
  let statusColor = "var(--chart-1)";
  let statusSuffix = "";
  if (costEstimate != null && costEstimate > 0) {
    const pct = finalSpend / costEstimate;
    if (pct > 1) {
      statusColor = "var(--destructive)";
      statusSuffix = " — over budget";
    } else if (pct >= 0.9) {
      statusColor = "var(--warning)";
      statusSuffix = " — nearly there";
    } else {
      statusColor = "var(--positive)";
    }
  }

  return (
    <div className="h-[300px]">
      <ResponsiveLine
        data={data}
        margin={{ top: 20, right: 30, bottom: 50, left: 70 }}
        xScale={{ type: "time", format: "%Y-%m-%d", precision: "day" }}
        xFormat="time:%b %d"
        yScale={{ type: "linear", min: yMin, max: yMax }}
        axisBottom={{
          format: "%b %d",
          tickRotation: -45,
          tickValues: "every 2 weeks",
        }}
        axisLeft={{
          format: (v: number) => formatCurrency(v, 0),
        }}
        enableArea
        areaOpacity={0.1}
        colors={["var(--chart-1)"]}
        pointSize={6}
        pointColor={({ point }) => {
          if (costEstimate == null) return "var(--card)";
          return (point.data.y as number) > costEstimate
            ? "var(--destructive)"
            : "var(--card)";
        }}
        pointBorderWidth={2}
        pointBorderColor={(point) => {
          if (costEstimate == null) return "var(--chart-1)";
          return (point.data.y as number) > costEstimate
            ? "var(--destructive)"
            : "var(--chart-1)";
        }}
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
        markers={
          costEstimate
            ? [
                {
                  axis: "y",
                  value: costEstimate,
                  lineStyle: {
                    stroke: statusColor,
                    strokeWidth: 2,
                    strokeDasharray: "8 4",
                  },
                  legend: `Estimate ${formatCurrency(costEstimate, 0)}${statusSuffix}`,
                  legendPosition: "top-right",
                  textStyle: {
                    fill: statusColor,
                    fontSize: 11,
                  },
                },
              ]
            : []
        }
        theme={{
          ...nivoChartTheme,
        }}
      />
    </div>
  );
}
