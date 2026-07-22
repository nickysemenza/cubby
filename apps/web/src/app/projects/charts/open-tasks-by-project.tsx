import type { ProjectPortfolioAnalyticsOut } from "@cubby/schemas/project";
import { ResponsiveBar } from "@nivo/bar";
import { useNavigate } from "@tanstack/react-router";
import { ListChecks } from "lucide-react";
import { useMemo } from "react";
import { nivoBarChrome, nivoChartTheme } from "../shared";
import { ChartTooltip } from "./ChartTooltip";
import { ChartEmpty } from "./chart-empty";

/**
 * The Analytics tab's "Open Tasks by Project" — `data` is
 * `portfolioAnalytics`'s `taskHeatmap`: open (non-done) top-level task count
 * per project matching the dashboard's filter scope (see
 * repo/project/portfolio-analytics.ts). Replaces the old calendar heatmap of
 * task due dates that used to live in the "Overview"/"Charts" tabs — the
 * server aggregate has no per-day granularity, only an open-count per
 * project, so this reads as "where is the open work concentrated" rather
 * than "when is work due". The project detail page's own `TaskHeatmap`
 * (`./task-heatmap.tsx`, a calendar heatmap over one project's raw dated
 * tasks) is a different component with a different prop shape — kept
 * separate rather than repurposed, since that page is out of scope here.
 */
export function OpenTasksByProject({
  data: rows,
}: {
  data: ProjectPortfolioAnalyticsOut["taskHeatmap"];
}) {
  const navigate = useNavigate();

  const data = useMemo(
    () =>
      rows
        .filter((r) => r.openTaskCount > 0)
        .map((r) => ({
          project: r.projectName,
          id: r.projectId,
          count: r.openTaskCount,
        }))
        .sort((a, b) => a.count - b.count)
        .slice(-15),
    [rows],
  );

  if (data.length === 0) {
    return <ChartEmpty icon={ListChecks} title="No open tasks." />;
  }

  const chartHeight = Math.max(220, data.length * 32 + 60);

  return (
    <div style={{ height: chartHeight }}>
      <ResponsiveBar
        data={data}
        keys={["count"]}
        indexBy="project"
        layout="horizontal"
        margin={{ top: 10, right: 30, bottom: 30, left: 160 }}
        padding={0.3}
        colors={["var(--chart-2)"]}
        {...nivoBarChrome}
        axisBottom={{
          tickSize: 0,
          tickPadding: 8,
          format: (v: number) => `${v}`,
        }}
        axisLeft={{ tickSize: 0, tickPadding: 8 }}
        label={(d) => `${d.value ?? 0}`}
        labelSkipWidth={16}
        labelTextColor="var(--background)"
        enableGridX
        enableGridY={false}
        onClick={(bar) => {
          const id = bar.data.id;
          if (id) navigate({ to: "/projects/$id", params: { id } });
        }}
        tooltip={({ indexValue, value }) => (
          <ChartTooltip>
            <strong>{indexValue}</strong>: {value} open task
            {value !== 1 ? "s" : ""}
          </ChartTooltip>
        )}
        theme={nivoChartTheme}
      />
    </div>
  );
}
