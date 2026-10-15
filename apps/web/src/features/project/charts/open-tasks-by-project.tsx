import type { ProjectPortfolioAnalyticsOut } from "@cubby/schemas/project";
import { countLabel } from "@cubby/shared/pluralize";
import { ListChecksIcon } from "@phosphor-icons/react/dist/csr/ListChecks";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import {
  RecordChartLabel,
  RecordChartTick,
  useRecordEmojiById,
} from "~/entity/components/record-mark";
import { entityDetailLink } from "~/entity/entities";
import { ChartTooltip } from "~/ui/charts/chart-tooltip";
import { RankedBarBreakdown } from "~/ui/charts/kit";

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
  const { emojiById } = useRecordEmojiById("project");

  const openRows = useMemo(
    () => rows.filter((r) => r.openTaskCount > 0),
    [rows],
  );
  const identityById = useMemo(
    () =>
      new Map<string, { name: string; emoji: string | null }>(
        openRows.map((row) => [
          row.projectId,
          {
            name: row.projectName,
            emoji: emojiById.get(row.projectId) ?? null,
          },
        ]),
      ),
    [openRows, emojiById],
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
        <RecordChartTick
          entity="project"
          {...tick}
          identityById={identityById}
        />
      )}
      tooltip={(row) => (
        <ChartTooltip>
          <strong>
            <RecordChartLabel
              entity="project"
              identity={
                identityById.get(row.projectId) ?? {
                  name: row.projectName,
                  emoji: null,
                }
              }
            />
          </strong>
          : {countLabel(row.openTaskCount, "open task")}
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
