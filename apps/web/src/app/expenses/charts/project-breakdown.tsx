import type { ExpenseProjectAggregate } from "@cubby/schemas/project";
import { BuildingsIcon as Building2 } from "@phosphor-icons/react/dist/csr/Buildings";
import { useMemo } from "react";

import { RankedBarBreakdown } from "~/app/_components/charts/kit";
import { useProjectOptions } from "~/app/_components/hooks/useProjectOptions";
import {
  ProjectChartLabel,
  ProjectChartTick,
} from "~/app/projects/project-mark";

/**
 * Net spend by project — sourced from `expense.analytics`'s `byProject`
 * aggregate. Top 12 by absolute net so a household with many small/finished
 * projects doesn't produce an unreadably tall bar list; inbox expenses
 * (`projectId: null`) are already excluded server-side (see
 * `repo/expense/analytics.ts`'s inner join).
 */
export function ProjectBreakdown({
  byProject,
}: {
  byProject: ExpenseProjectAggregate[];
}) {
  const { iconById } = useProjectOptions();
  const identityById = useMemo(
    () =>
      new Map<string, { name: string; icon: string | null }>(
        byProject.map((row) => [
          row.projectId,
          { name: row.projectName, icon: iconById.get(row.projectId) ?? null },
        ]),
      ),
    [byProject, iconById],
  );

  return (
    <RankedBarBreakdown
      data={byProject}
      valueKey="net"
      labelKey="projectName"
      idKey="projectId"
      margin={{ top: 10, right: 40, bottom: 40, left: 180 }}
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
      emptyIcon={Building2}
      emptyTitle="No project-linked expenses."
    />
  );
}
