import type { ProjectPortfolioAnalyticsOut } from "@cubby/schemas/project";
import { ResponsiveBar } from "@nivo/bar";
import { CalendarClock } from "lucide-react";
import { useMemo } from "react";
import { formatCurrency } from "~/lib/utils";
import {
  monthLabel,
  nivoBarChrome,
  nivoChartTheme,
  nivoCurrencyAxis,
} from "../shared";
import { ChartTooltip } from "./ChartTooltip";
import { ChartEmpty } from "./chart-empty";

type PlannedDatum = {
  month: string;
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
 * The Analytics tab's "Planned vs Actual" — `data` is `portfolioAnalytics`'s
 * `plannedVsActual`: committed (future-flagged) vs actual spend per month,
 * across every project matching the dashboard's filter scope (see
 * repo/project/portfolio-analytics.ts). A sibling of the project detail
 * page's `PlannedVsActual` (`./planned-vs-actual.tsx`, grouped by cost type
 * over one project's raw purchases) — kept as a separate component rather
 * than repurposing that one, since the detail page consumes it with a
 * different prop shape and is out of scope for this change.
 */
export function PlannedVsActualByMonth({
  data: rows,
}: {
  data: ProjectPortfolioAnalyticsOut["plannedVsActual"];
}) {
  const data = useMemo(
    () =>
      rows
        .map(
          (r): PlannedDatum => ({
            month: monthLabel(r.month),
            actual: r.actual,
            planned: r.planned,
          }),
        )
        .filter((d) => d.actual > 0 || d.planned > 0),
    [rows],
  );

  if (data.length === 0) {
    return <ChartEmpty icon={CalendarClock} title="No purchase data." />;
  }

  const chartHeight = Math.max(220, data.length * 56 + 80);

  return (
    <div style={{ height: chartHeight }}>
      <ResponsiveBar
        data={data}
        keys={["actual", "planned"]}
        indexBy="month"
        layout="horizontal"
        groupMode="grouped"
        margin={{ top: 10, right: 60, bottom: 60, left: 110 }}
        padding={0.25}
        innerPadding={2}
        colors={(bar) =>
          SERIES_COLORS[bar.id as string] ?? "var(--chart-neutral)"
        }
        {...nivoBarChrome}
        axisBottom={nivoCurrencyAxis}
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
