import { ResponsiveLine } from "@nivo/line";
import { TrendingUp } from "lucide-react";
import { useMemo } from "react";
import { formatCurrency } from "~/lib/utils";
import type { NotionPurchase } from "~/server/clients/notion";
import { nivoChartTheme } from "../shared";
import { ChartEmpty } from "./chart-empty";

export function SpendingOverTime({
  purchases,
  costEstimate,
}: {
  purchases: NotionPurchase[];
  costEstimate: number | null;
}) {
  const data = useMemo(() => {
    // Filter to purchases with dates and costs, sort chronologically
    const dated = purchases
      .filter((p) => p.date && p.cost != null)
      .sort((a, b) => a.date!.localeCompare(b.date!));

    if (dated.length === 0) return [];

    // Build cumulative spend series
    let cumulative = 0;
    const points = dated.map((p) => {
      cumulative += p.cost!;
      return { x: p.date!, y: cumulative };
    });

    return [
      {
        id: "Cumulative Spend",
        data: points,
      },
    ];
  }, [purchases]);

  if (data.length === 0) {
    return <ChartEmpty icon={TrendingUp} title="No dated purchase data." />;
  }

  const maxY = data[0].data[data[0].data.length - 1].y;
  const yMax = costEstimate
    ? Math.max(maxY * 1.1, costEstimate * 1.15)
    : maxY * 1.1;

  return (
    <div className="h-[300px]">
      <ResponsiveLine
        data={data}
        margin={{ top: 20, right: 30, bottom: 50, left: 70 }}
        xScale={{ type: "time", format: "%Y-%m-%d", precision: "day" }}
        xFormat="time:%b %d"
        yScale={{ type: "linear", min: 0, max: yMax }}
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
        pointColor="white"
        pointBorderWidth={2}
        pointBorderColor={{ from: "serieColor" }}
        useMesh
        enableSlices="x"
        sliceTooltip={({ slice }) => (
          <div className="rounded-md bg-popover px-3 py-2 text-sm shadow-md ring-1 ring-border">
            {slice.points.map((point) => (
              <div key={point.id}>
                <span className="text-muted-foreground">
                  {point.data.xFormatted}
                </span>
                {": "}
                <strong>{formatCurrency(point.data.y as number, 0)}</strong>
              </div>
            ))}
          </div>
        )}
        markers={
          costEstimate
            ? [
                {
                  axis: "y",
                  value: costEstimate,
                  lineStyle: {
                    stroke: "hsl(0, 65%, 50%)",
                    strokeWidth: 2,
                    strokeDasharray: "8 4",
                  },
                  legend: `Estimate ${formatCurrency(costEstimate, 0)}`,
                  legendPosition: "top-right",
                  textStyle: {
                    fill: "hsl(0, 65%, 50%)",
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
