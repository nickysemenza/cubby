import type { ProjectPortfolioAnalyticsOut } from "@cubby/schemas/project";
import { ResponsiveBar } from "@nivo/bar";
import { DollarSign } from "lucide-react";
import { useMemo } from "react";
import { formatCurrency } from "~/lib/utils";
import { nivoBarChrome, nivoChartTheme } from "../shared";
import { ChartTooltip } from "./ChartTooltip";
import { ChartEmpty } from "./chart-empty";

type Datum = {
  project: string;
  percent: number;
  actual: number;
  estimate: number;
};

/**
 * Budget health as % of estimate, not raw dollars — Wedding's $175K estimate
 * dwarfs every other project's bar on an absolute scale, so a single outsized
 * project made the rest unreadable slivers. Normalizing to actual/estimate
 * puts every project on the same 0–100%(+) axis regardless of size, with a
 * 100% reference line marking the budget itself.
 *
 * `data` is `portfolioAnalytics`'s `costVsEstimate` — subtree actual/estimate
 * per project matching the dashboard's current filter scope, computed
 * server-side (see repo/project/portfolio-analytics.ts; that scope isn't
 * top-level-only, so a matched parent+child pair can each show their own
 * subtree total, same double-counting judgment call as dashboard-summary.ts's
 * `actualSpend`). `committed` isn't plotted here — this chart is about money
 * already spent vs budget, not the committed pipeline.
 */
export function CostVsEstimate({
  data: rows,
}: {
  data: ProjectPortfolioAnalyticsOut["costVsEstimate"];
}) {
  const data = useMemo(() => {
    return (
      rows
        .map((r) => ({
          project: r.projectName,
          actual: r.actual,
          estimate: r.estimate,
        }))
        // No estimate (null or 0) means "% of estimate" is undefined — leave
        // those projects off the chart rather than showing a misleading N/A
        // bar of 0 or infinite height.
        .filter(
          (d): d is { project: string; actual: number; estimate: number } =>
            d.estimate != null && d.estimate > 0,
        )
        .map(
          (d): Datum => ({
            project: d.project,
            actual: d.actual,
            estimate: d.estimate,
            // Negative `actual` (net contributions exceeding spend) is real —
            // it just yields a negative percent, which reads fine on an axis
            // that already spans through 0.
            percent: (d.actual / d.estimate) * 100,
          }),
        )
        .sort((a, b) => b.percent - a.percent)
        .slice(0, 15)
    );
  }, [rows]);

  if (data.length === 0) {
    return <ChartEmpty icon={DollarSign} title="No cost data." />;
  }

  const chartHeight = Math.max(250, data.length * 40 + 60);

  return (
    <div style={{ height: chartHeight }}>
      <ResponsiveBar
        data={data}
        keys={["percent"]}
        indexBy="project"
        layout="horizontal"
        margin={{ top: 10, right: 30, bottom: 40, left: 160 }}
        padding={0.3}
        colors={({ data: d }) =>
          d.percent > 100 ? "var(--chart-negative)" : "var(--chart-positive)"
        }
        {...nivoBarChrome}
        axisBottom={{
          tickSize: 0,
          tickPadding: 8,
          tickValues: 5,
          format: (v: number) => `${Math.round(v)}%`,
        }}
        axisLeft={{
          tickSize: 0,
          tickPadding: 8,
        }}
        label={(d) => `${Math.round(d.value ?? 0)}%`}
        labelSkipWidth={28}
        labelTextColor="var(--background)"
        enableGridX
        enableGridY={false}
        markers={[
          {
            axis: "x",
            value: 100,
            lineStyle: {
              stroke: "var(--foreground)",
              strokeWidth: 1,
              strokeDasharray: "4 4",
            },
            legend: "100% of estimate",
            legendPosition: "top",
            textStyle: { fill: "var(--muted-foreground)", fontSize: 10 },
          },
        ]}
        tooltip={({ data: d }) => (
          <ChartTooltip>
            <strong>{d.project}</strong> — {Math.round(d.percent)}% of estimate
            <div className="mt-1 text-muted-foreground text-xs">
              {formatCurrency(d.actual, 0)} actual /{" "}
              {formatCurrency(d.estimate, 0)} estimate
            </div>
          </ChartTooltip>
        )}
        theme={nivoChartTheme}
      />
    </div>
  );
}
