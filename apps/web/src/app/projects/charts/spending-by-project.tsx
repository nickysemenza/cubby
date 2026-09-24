import type { ProjectPortfolioAnalyticsOut } from "@cubby/schemas/project";
import { WalletIcon as Wallet } from "@phosphor-icons/react/dist/csr/Wallet";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import { RankedBarBreakdown } from "~/app/_components/charts/kit";
import { useProjectOptions } from "~/app/_components/hooks/useProjectOptions";
import { entityDetailLink } from "~/entities/entities";

import { ProjectChartLabel, ProjectChartTick } from "../project-mark";

/**
 * `data` is `portfolioAnalytics`'s `spendingByProject` — subtree `spent`
 * (net actual + committed + credits) per project matching the dashboard's
 * current filter scope, already sorted server-side (see repo/project/
 * portfolio-analytics.ts).
 */
export function SpendingByProject({
  data: rows,
}: {
  data: ProjectPortfolioAnalyticsOut["spendingByProject"];
}) {
  const navigate = useNavigate();
  const { iconById } = useProjectOptions();

  const positiveRows = useMemo(() => rows.filter((r) => r.spend > 0), [rows]);
  const identityById = useMemo(
    () =>
      new Map<string, { name: string; icon: string | null }>(
        positiveRows.map((row) => [
          row.projectId,
          { name: row.projectName, icon: iconById.get(row.projectId) ?? null },
        ]),
      ),
    [positiveRows, iconById],
  );

  return (
    <RankedBarBreakdown
      data={positiveRows}
      valueKey="spend"
      labelKey="projectName"
      idKey="projectId"
      topN={10}
      minHeight={250}
      margin={{ top: 10, right: 80, bottom: 30, left: 180 }}
      showValueLabel
      labelSkipWidth={50}
      renderTick={(tick) => (
        <ProjectChartTick {...tick} identityById={identityById} />
      )}
      renderLabel={(row) => (
        <ProjectChartLabel
          identity={
            identityById.get(row.projectId) ?? {
              name: row.projectName,
              icon: null,
            }
          }
        />
      )}
      onClick={(row) =>
        navigate(entityDetailLink("project", String(row.projectId)))
      }
      emptyIcon={Wallet}
      emptyTitle="No spending data."
    />
  );
}
