import type { ProjectPortfolioAnalyticsOut } from "@cubby/schemas/project";
import { ListChecksIcon } from "@phosphor-icons/react/dist/csr/ListChecks";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import { RankedBarBreakdown } from "~/app/_components/charts/kit";
import { entityDetailLink } from "~/entities/entities";

import {
  ProjectChartLabel,
  ProjectChartTick,
  useProjectIconById,
} from "../project-mark";
import { ChartTooltip } from "./ChartTooltip";

/**
 * The Analytics tab's "Open Tasks by Project" — `data` is
 * `portfolioAnalytics`'s `taskHeatmap`: open (non-done) top-level task count
 * per project matching the dashboard's filter scope (see
 * repo/project/portfolio-analytics.ts). Replaces the old calendar heatmap of
 * task due dates that used to live in the "Overview"/"Charts" tabs — the
 * server aggregate has no per-day granularity, only an open-count per
 * project, so this reads as "where is the open work concentrated" rather
 * than "when is work due".
 */
export function OpenTasksByProject({
  data: rows,
}: {
  data: ProjectPortfolioAnalyticsOut["taskHeatmap"];
}) {
  const navigate = useNavigate();
  const { iconById } = useProjectIconById();

  const openRows = useMemo(
    () => rows.filter((r) => r.openTaskCount > 0),
    [rows],
  );
  const identityById = useMemo(
    () =>
      new Map<string, { name: string; icon: string | null }>(
        openRows.map((row) => [
          row.projectId,
          { name: row.projectName, icon: iconById.get(row.projectId) ?? null },
        ]),
      ),
    [openRows, iconById],
  );

  return (
    <RankedBarBreakdown
      data={openRows}
      valueKey="openTaskCount"
      labelKey="projectName"
      idKey="projectId"
      topN={15}
      minHeight={220}
      margin={{ top: 10, right: 30, bottom: 30, left: 180 }}
      color={() => "var(--chart-2)"}
      showValueLabel
      labelSkipWidth={16}
      formatValue={(v) => `${v}`}
      axisBottomFormat={(v) => `${v}`}
      renderTick={(tick) => (
        <ProjectChartTick {...tick} identityById={identityById} />
      )}
      tooltip={(row) => (
        <ChartTooltip>
          <strong>
            <ProjectChartLabel
              identity={
                identityById.get(row.projectId) ?? {
                  name: row.projectName,
                  icon: null,
                }
              }
            />
          </strong>
          : {row.openTaskCount} open task{row.openTaskCount !== 1 ? "s" : ""}
        </ChartTooltip>
      )}
      onClick={(row) =>
        navigate(entityDetailLink("project", String(row.projectId)))
      }
      emptyIcon={ListChecksIcon}
      emptyTitle="No open tasks."
    />
  );
}
