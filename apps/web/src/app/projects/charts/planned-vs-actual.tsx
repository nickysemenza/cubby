import type { PurchaseOut } from "@cubby/schemas/project";
import { ResponsiveBar } from "@nivo/bar";
import { CalendarClock } from "lucide-react";
import { useMemo } from "react";
import { formatCurrency } from "~/lib/utils";
import { capitalize, nivoBarChrome, nivoChartTheme } from "../shared";
import { ChartTooltip } from "./ChartTooltip";
import { ChartEmpty } from "./chart-empty";

type PlannedDatum = {
  category: string;
  actual: number;
  planned: number;
};

const SERIES_COLORS: Record<string, string> = {
  actual: "var(--chart-1)",
  planned: "var(--chart-7)", // light ink — reads as "not yet real"
};

const SERIES_LABELS: Record<string, string> = {
  actual: "Actual",
  planned: "Planned",
};

/**
 * Committed spend vs future-flagged purchases, grouped by category — not by
 * month, because planned purchases usually have no date and a time axis
 * would silently drop them.
 */
export function PlannedVsActual({ purchases }: { purchases: PurchaseOut[] }) {
  const data = useMemo(() => {
    const buckets = new Map<string, { actual: number; planned: number }>();
    for (const p of purchases) {
      const category = p.category ?? "uncategorized";
      const entry = buckets.get(category) ?? { actual: 0, planned: 0 };
      entry[p.future ? "planned" : "actual"] += p.cost ?? 0;
      buckets.set(category, entry);
    }
    return Array.from(buckets.entries())
      .map(
        ([category, { actual, planned }]): PlannedDatum => ({
          category: capitalize(category),
          actual,
          planned,
        }),
      )
      .filter((d) => d.actual > 0 || d.planned > 0)
      .sort((a, b) => a.actual + a.planned - (b.actual + b.planned));
  }, [purchases]);

  if (data.length === 0) {
    return <ChartEmpty icon={CalendarClock} title="No purchase data." />;
  }

  const chartHeight = Math.max(220, data.length * 56 + 80);

  return (
    <div style={{ height: chartHeight }}>
      <ResponsiveBar
        data={data}
        keys={["actual", "planned"]}
        indexBy="category"
        layout="horizontal"
        groupMode="grouped"
        margin={{ top: 10, right: 60, bottom: 60, left: 110 }}
        padding={0.25}
        innerPadding={2}
        colors={(bar) =>
          SERIES_COLORS[bar.id as string] ?? "var(--chart-neutral)"
        }
        {...nivoBarChrome}
        axisBottom={{
          format: (v: number) => formatCurrency(v, 0),
        }}
        axisLeft={{
          tickSize: 0,
          tickPadding: 8,
        }}
        label={(d) =>
          d.value && d.value > 0 ? formatCurrency(d.value, 0) : ""
        }
        labelSkipWidth={40}
        labelTextColor="var(--background)"
        enableGridX
        enableGridY={false}
        tooltip={({ id, value, indexValue, color }) => (
          <ChartTooltip>
            <strong>{indexValue}</strong> — {SERIES_LABELS[id as string] ?? id}:{" "}
            <span style={{ color }}>{formatCurrency(value, 0)}</span>
          </ChartTooltip>
        )}
        legendLabel={(d) => SERIES_LABELS[String(d.id)] ?? String(d.id)}
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
    </div>
  );
}
