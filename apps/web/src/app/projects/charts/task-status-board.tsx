import type {
  ProjectOut,
  ProjectTaskStatusBreakdown,
  TaskStatus,
} from "@cubby/schemas/project";
import { taskStatusValues } from "@cubby/schemas/project";
import { ListChecksIcon as ListChecks } from "@phosphor-icons/react/dist/csr/ListChecks";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { NoneValue } from "~/components/ui/none-value";
import { entities, entityDetailParams } from "~/entities/entities";
import { getStatusChartColor } from "~/lib/status-colors";

import { ProjectMark } from "../project-mark";
import { TASK_STATUS_LABELS } from "../shared";
import { ChartEmpty } from "./chart-empty";

/** `breakdown` -> per-status count lookup, in column order. */
function counts(row: ProjectTaskStatusBreakdown, status: TaskStatus): number {
  switch (status) {
    case "not_started":
      return row.notStarted;
    case "later":
      return row.later;
    case "in_progress":
      return row.inProgress;
    case "blocked":
      return row.blocked;
    case "done":
      return row.done;
  }
}

/**
 * `breakdown` is `dashboardSummary`'s `taskStatusByProject` — a per-project ×
 * status count computed server-side (see repo/project/dashboard-summary.ts),
 * one row per project already in `dashboardSummary`'s (active-by-default)
 * scope. `projects` supplies display names/start dates. Tasks with no
 * project ("Unassigned") aren't represented — `taskStatusByProject` is keyed
 * strictly by project id — a scope reduction from the old client-computed
 * version, which folded unassigned tasks into their own row.
 */
export function TaskStatusBoard({
  breakdown,
  projects,
}: {
  breakdown: ProjectTaskStatusBreakdown[];
  projects: ProjectOut[];
}) {
  const { rows, statuses } = useMemo(() => {
    const projectMap = new Map(projects.map((p) => [p.id, p]));
    const statusSet = new Set<TaskStatus>();

    const rows = breakdown
      .map((row) => {
        const proj = projectMap.get(row.projectId);
        const total = row.notStarted + row.later + row.inProgress + row.blocked;
        for (const status of taskStatusValues) {
          if (counts(row, status) > 0) statusSet.add(status);
        }
        return {
          projectId: row.projectId,
          projectShortcode: proj?.id ?? null,
          name: proj?.name ?? "Unknown project",
          icon: proj?.icon,
          date: proj?.startDate ?? "",
          breakdown: row,
          remaining: total,
        };
      })
      // Most open work first, then most recently started.
      .filter((row) => row.remaining > 0)
      .sort((a, b) => {
        if (a.remaining !== b.remaining) return b.remaining - a.remaining;
        if (a.date && b.date) return b.date.localeCompare(a.date);
        if (a.date) return -1;
        if (b.date) return 1;
        return 0;
      })
      .slice(0, 15);

    const statuses = taskStatusValues.filter((s) => statusSet.has(s));

    return { rows, statuses };
  }, [breakdown, projects]);

  if (rows.length === 0) {
    return (
      <ChartEmpty
        icon={ListChecks}
        title={
          breakdown.length === 0
            ? "No task data."
            : "No active projects with open tasks."
        }
      />
    );
  }

  const maxCount = Math.max(
    1,
    ...rows.flatMap((r) => statuses.map((s) => counts(r.breakdown, s))),
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr>
            <th className="pr-2 pb-2 text-left font-medium text-muted-foreground">
              Project
            </th>
            {statuses.map((s) => (
              <th
                key={s}
                className="px-2 pb-2 text-center font-medium text-muted-foreground"
              >
                {TASK_STATUS_LABELS[s]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.projectId} className="border-t border-border/50">
              <td className="max-w-[150px] truncate py-2 pr-2 font-medium">
                {row.projectShortcode ? (
                  <Link
                    to={entities.project.routes.detail}
                    params={entityDetailParams(row.projectShortcode)}
                    className="hover:underline"
                    title={row.name}
                  >
                    <span className="inline-flex max-w-full items-center gap-1">
                      <ProjectMark icon={row.icon} size={12} />
                      <span className="truncate">{row.name}</span>
                    </span>
                  </Link>
                ) : (
                  <span
                    title={row.name}
                    className="inline-flex max-w-full items-center gap-1"
                  >
                    <ProjectMark icon={row.icon} size={12} />
                    <span className="truncate">{row.name}</span>
                  </span>
                )}
              </td>
              {statuses.map((status) => {
                const count = counts(row.breakdown, status);
                const intensity = count / maxCount;
                const color = getStatusChartColor(status);

                return (
                  <td key={status} className="px-2 py-2 text-center">
                    {count > 0 ? (
                      <span
                        className="inline-flex h-6 w-8 items-center justify-center text-xs font-medium text-background"
                        style={{
                          backgroundColor: color,
                          opacity: 0.3 + intensity * 0.7,
                        }}
                      >
                        {count}
                      </span>
                    ) : (
                      <NoneValue />
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
