import { ResponsiveLine } from "@nivo/line";
import { useMemo } from "react";
import { formatCurrency } from "~/lib/utils";
import type { NotionPurchase } from "~/server/clients/notion";
import {
  CATEGORY_COLORS,
  monthKey,
  monthLabel,
  nivoChartTheme,
  normalizeCategoryKey,
} from "../shared";

export function CategoryTrend({ purchases }: { purchases: NotionPurchase[] }) {
  const data = useMemo(() => {
    // Group purchases by month and category
    const dated = purchases.filter((p) => p.date && p.cost != null);
    if (dated.length === 0) return [];

    // Collect all months
    const months = new Set<string>();
    const byCatMonth = new Map<string, Map<string, number>>();

    for (const p of dated) {
      const cat = normalizeCategoryKey(p.category);
      const month = monthKey(p.date!);
      months.add(month);

      if (!byCatMonth.has(cat)) byCatMonth.set(cat, new Map());
      const catMap = byCatMonth.get(cat)!;
      catMap.set(month, (catMap.get(month) ?? 0) + (p.cost ?? 0));
    }

    const sortedMonths = Array.from(months).sort();

    // Build series per category, cumulative within each
    return Array.from(byCatMonth.entries())
      .map(([cat, monthMap]) => {
        let cumulative = 0;
        return {
          id: cat,
          data: sortedMonths.map((month) => {
            cumulative += monthMap.get(month) ?? 0;
            return { x: monthLabel(month), y: cumulative };
          }),
        };
      })
      .sort((a, b) => {
        const lastA = a.data[a.data.length - 1]?.y ?? 0;
        const lastB = b.data[b.data.length - 1]?.y ?? 0;
        return lastB - lastA;
      });
  }, [purchases]);

  // Need at least 2 months for a meaningful trend
  const monthCount = data[0]?.data.length ?? 0;
  if (data.length === 0 || monthCount < 2) {
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
        margin={{ top: 20, right: 110, bottom: 50, left: 70 }}
        xScale={{ type: "point" }}
        yScale={{ type: "linear", min: 0, stacked: true }}
        axisBottom={{
          tickRotation: -45,
        }}
        axisLeft={{
          format: (v: number) => formatCurrency(v, 0),
        }}
        enableArea
        areaOpacity={0.4}
        colors={(d) => CATEGORY_COLORS[d.id] ?? "hsl(0, 0%, 65%)"}
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
            {slice.points.map((point) => (
              <div key={point.id} className="flex items-center gap-2">
                <div
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: point.seriesColor }}
                />
                <span>{point.seriesId}</span>
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
            translateX: 100,
            itemWidth: 90,
            itemHeight: 20,
            symbolSize: 10,
            symbolShape: "circle",
            itemTextColor: "var(--muted-foreground)",
          },
        ]}
        theme={nivoChartTheme}
      />
    </div>
  );
}
