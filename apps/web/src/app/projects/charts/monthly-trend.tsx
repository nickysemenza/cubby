import { ResponsiveLine } from "@nivo/line";
import { sumBy } from "es-toolkit";
import { useMemo } from "react";
import { formatCurrency } from "~/lib/utils";
import type { NotionPurchase } from "~/server/clients/notion";
import { monthKey, monthLabel, nivoChartTheme } from "../shared";

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

export function MonthlyTrend({ purchases }: { purchases: NotionPurchase[] }) {
  const data = useMemo(() => {
    const dated = purchases.filter((p) => p.date && p.cost != null);
    if (dated.length === 0) return [];

    // Group by project + month
    const months = new Set<string>();
    const byProjectMonth = new Map<string, Map<string, number>>();

    for (const p of dated) {
      const project = p.projectName ?? "Unassigned";
      const month = monthKey(p.date!);
      months.add(month);

      if (!byProjectMonth.has(project)) byProjectMonth.set(project, new Map());
      const map = byProjectMonth.get(project)!;
      map.set(month, (map.get(month) ?? 0) + (p.cost ?? 0));
    }

    const sortedMonths = Array.from(months).sort();
    if (sortedMonths.length < 2) return [];

    return Array.from(byProjectMonth.entries())
      .map(([project, monthMap]) => ({
        id: project,
        data: sortedMonths.map((month) => ({
          x: monthLabel(month),
          y: monthMap.get(month) ?? 0,
        })),
      }))
      .sort((a, b) => {
        const totalA = sumBy(a.data, (d) => d.y);
        const totalB = sumBy(b.data, (d) => d.y);
        return totalB - totalA;
      });
  }, [purchases]);

  if (data.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Not enough data for a trend (need 2+ months).
      </p>
    );
  }

  return (
    <div className="h-[300px]">
      <ResponsiveLine
        data={data}
        margin={{ top: 20, right: 130, bottom: 50, left: 70 }}
        xScale={{ type: "point" }}
        yScale={{ type: "linear", min: 0, stacked: true }}
        axisBottom={{ tickRotation: -45 }}
        axisLeft={{
          format: (v: number) => formatCurrency(v, 0),
        }}
        enableArea
        areaOpacity={0.3}
        colors={(d) => {
          const idx = data.findIndex((s) => s.id === d.id);
          return (
            PROJECT_COLORS[idx % PROJECT_COLORS.length] ?? PROJECT_COLORS[0]!
          );
        }}
        pointSize={5}
        pointColor="white"
        pointBorderWidth={2}
        pointBorderColor={{ from: "serieColor" }}
        useMesh
        enableSlices="x"
        sliceTooltip={({ slice }) => (
          <div className="rounded-md bg-popover px-3 py-2 text-sm shadow-md ring-1 ring-border">
            <div className="mb-1 font-medium">
              {slice.points[0]?.data.xFormatted}
            </div>
            {slice.points
              .filter((p) => (p.data.y as number) > 0)
              .map((point) => (
                <div key={point.id} className="flex items-center gap-2">
                  <div
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: point.seriesColor }}
                  />
                  <span className="max-w-[150px] truncate">
                    {point.seriesId}
                  </span>
                  <strong className="ml-auto">
                    {formatCurrency(point.data.y as number, 0)}
                  </strong>
                </div>
              ))}
          </div>
        )}
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
        theme={nivoChartTheme}
      />
    </div>
  );
}
