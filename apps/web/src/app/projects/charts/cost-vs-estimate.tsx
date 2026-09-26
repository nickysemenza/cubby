import type { ProjectPortfolioAnalyticsOut } from "@cubby/schemas/project";
import { CurrencyDollarIcon } from "@phosphor-icons/react/dist/csr/CurrencyDollar";
import { useMemo } from "react";

import { formatCurrency } from "~/lib/utils";

import {
  ProjectChartLabel,
  ProjectChartTick,
  useProjectIconById,
} from "../project-mark";
import { nivoBarChrome, nivoChartTheme } from "../shared";
import { ChartEmpty } from "./chart-empty";
import { ChartTooltip } from "./ChartTooltip";
import { HorizontalBarChart } from "./horizontal-bar-chart";

type Datum = {
  id: string;
  name: string;
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
 * server-side (see repo/project/portfolio-analytics.ts). A matched parent and
 * child each plot their own subtree total, which is correct for per-project
 * bars: the chart compares each project against its own budget and never sums
 * across them. Any consumer that DOES total these rows must filter to
 * `isScopeRoot` first, or a child's money is counted twice. `committed` isn't
 * plotted here — this chart is about money already spent vs budget, not the
 * committed pipeline.
 */
export function CostVsEstimate({
  data: rows,
}: {
  data: ProjectPortfolioAnalyticsOut["costVsEstimate"];
}) {
  const { iconById } = useProjectIconById();
  const data = useMemo(() => {
    return (
      rows
        .flatMap((r): Datum[] =>
          r.estimate != null && r.estimate > 0
            ? [
                {
                  id: r.projectId,
                  name: r.projectName,
                  actual: r.actual,
                  estimate: r.estimate,
                  percent: (r.actual / r.estimate) * 100,
                },
              ]
            : [],
        )
        // No estimate (null or 0) means "% of estimate" is undefined — leave
        // those projects off the chart rather than showing a misleading N/A
        // bar of 0 or infinite height.
        .map((d): Datum => ({
          ...d,
          // Negative `actual` (net contributions exceeding spend) is real —
          // it just yields a negative percent, which reads fine on an axis
          // that already spans through 0.
          percent: (d.actual / d.estimate) * 100,
        }))
        .sort((a, b) => b.percent - a.percent)
        .slice(0, 15)
    );
  }, [rows]);
  const identityById = useMemo(
    () =>
      new Map(
        data.map((row) => [
          row.id,
          { name: row.name, icon: iconById.get(row.id) ?? null },
        ]),
      ),
    [data, iconById],
  );

  if (data.length === 0) {
    return <ChartEmpty icon={CurrencyDollarIcon} title="No cost data." />;
  }

  return (
    <HorizontalBarChart
      data={data}
      minHeight={250}
      rowHeight={40}
      keys={["percent"]}
      indexBy="id"
      margin={{ top: 10, right: 30, bottom: 40, left: 180 }}
      padding={0.3}
      colors={({ data: d }) =>
        Number(d.percent) > 100
          ? "var(--chart-negative)"
          : "var(--chart-positive)"
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
        renderTick: (tick) => (
          <ProjectChartTick {...tick} identityById={identityById} />
        ),
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
          <strong>
            <ProjectChartLabel
              identity={
                identityById.get(String(d.id)) ?? {
                  name: String(d.name),
                  icon: null,
                }
              }
            />
          </strong>{" "}
          — {Math.round(Number(d.percent))}% of estimate
          <div className="mt-1 text-xs text-muted-foreground">
            {formatCurrency(Number(d.actual), 0)} actual /{" "}
            {formatCurrency(Number(d.estimate), 0)} estimate
          </div>
        </ChartTooltip>
      )}
      theme={nivoChartTheme}
    />
  );
}
