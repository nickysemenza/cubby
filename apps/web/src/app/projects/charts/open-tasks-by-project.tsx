import type { ProjectPortfolioAnalyticsOut } from "@cubby/schemas/project";
import { ResponsiveBar } from "@nivo/bar";
import { useNavigate } from "@tanstack/react-router";
import { ListChecks } from "lucide-react";
import { useMemo } from "react";
import { useProjectOptions } from "~/app/_components/hooks/useProjectOptions";
import { entityDetailLink } from "~/entities/entities";
import { ProjectChartLabel, ProjectChartTick } from "../project-mark";
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
  const { iconById } = useProjectOptions();

  const data = useMemo(
    () =>
      rows
        .filter((r) => r.openTaskCount > 0)
        .map((r) => ({
          id: r.projectId,
          name: r.projectName,
          count: r.openTaskCount,
        }))
        .sort((a, b) => a.count - b.count)
        .slice(-15),
    [rows],
  );
  const identityById = useMemo(
    () =>
      new Map<string, { name: string; icon: string | null }>(
        data.map(
          (row) =>
            [
              String(row.id),
              { name: row.name, icon: iconById.get(row.id) ?? null },
            ] as const,
        ),
      ),
    [data, iconById],
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
        indexBy="id"
        layout="horizontal"
        margin={{ top: 10, right: 30, bottom: 30, left: 180 }}
        padding={0.3}
        colors={["var(--chart-2)"]}
        {...nivoBarChrome}
        axisBottom={{
          tickSize: 0,
          tickPadding: 8,
          format: (v: number) => `${v}`,
        }}
        axisLeft={{
          tickSize: 0,
          tickPadding: 8,
          renderTick: (tick) => (
            <ProjectChartTick {...tick} identityById={identityById} />
          ),
        }}
        label={(d) => `${d.value ?? 0}`}
        labelSkipWidth={16}
        labelTextColor="var(--background)"
        enableGridX
        enableGridY={false}
        onClick={(bar) => {
          const id = bar.data.id;
          if (id) navigate(entityDetailLink("project", String(id)));
        }}
        tooltip={({ data: row, value }) => (
          <ChartTooltip>
            <strong>
              <ProjectChartLabel
                identity={
                  identityById.get(String(row.id)) ?? {
                    name: String(row.name),
                    icon: null,
                  }
                }
              />
            </strong>
            : {value} open task
            {value !== 1 ? "s" : ""}
          </ChartTooltip>
        )}
        theme={nivoChartTheme}
      />
    </div>
  );
}
