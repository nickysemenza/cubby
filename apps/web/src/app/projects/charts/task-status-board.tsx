import type { ProjectOut, TaskOut, TaskStatus } from "@cubby/schemas/project";
import { taskStatusValues } from "@cubby/schemas/project";
import { sum } from "es-toolkit";
import { ListChecks } from "lucide-react";
import { useMemo } from "react";
import { NoneValue } from "~/components/ui/none-value";
import { getStatusChartColor } from "~/lib/status-colors";
import { TASK_STATUS_LABELS } from "../shared";
import { ChartEmpty } from "./chart-empty";

export function TaskStatusBoard({
  tasks,
  projects,
}: {
  tasks: TaskOut[];
  projects: ProjectOut[];
}) {
  const { grid, projectRows, statuses } = useMemo(() => {
    const projectMap = new Map<string, ProjectOut>(
      projects.map((p) => [p.id, p]),
    );

    // Count tasks per project × status — keyed by project id (falling back
    // to a fixed "unassigned" sentinel), not name: project names aren't
    // unique, so a name-keyed grid would merge distinct same-named projects
    // into a single row.
    const counts = new Map<string, Map<TaskStatus, number>>();
    const namesByKey = new Map<string, string>();
    const projectKeys = new Set<string>();
    const statusSet = new Set<TaskStatus>();

    for (const t of tasks) {
      const key = t.projectId ?? "unassigned";
      const status = t.status;
      projectKeys.add(key);
      namesByKey.set(key, t.projectName ?? "Unassigned");
      statusSet.add(status);

      if (!counts.has(key)) counts.set(key, new Map());
      const row = counts.get(key)!;
      row.set(status, (row.get(status) ?? 0) + 1);
    }

    // Active projects only, most remaining (non-done) work first. A done
    // project's row is all checked boxes — low signal next to projects with
    // real open work, and previously it could crowd out active projects
    // whenever there weren't 15 of them to fill the board. Tasks with no
    // project ("Unassigned") are always in-scope.
    const projectRows = Array.from(projectKeys)
      .map((key) => {
        const proj = projectMap.get(key);
        const statusCounts = counts.get(key);
        const total = sum(Array.from(statusCounts?.values() ?? []));
        const doneCount = statusCounts?.get("done") ?? 0;
        return {
          key,
          name: namesByKey.get(key) ?? "Unassigned",
          date: proj?.startDate ?? "",
          total,
          remaining: total - doneCount,
        };
      })
      .filter((row) => projectMap.get(row.key)?.status !== "done")
      .sort((a, b) => {
        // Most open work first...
        if (a.remaining !== b.remaining) return b.remaining - a.remaining;
        // ...then most recently started.
        if (a.date && b.date) return b.date.localeCompare(a.date);
        if (a.date) return -1;
        if (b.date) return 1;
        return b.total - a.total;
      })
      .slice(0, 15);

    const statuses = taskStatusValues.filter((s) => statusSet.has(s));

    return { grid: counts, projectRows, statuses };
  }, [tasks, projects]);

  if (projectRows.length === 0) {
    return (
      <ChartEmpty
        icon={ListChecks}
        title={
          tasks.length === 0
            ? "No task data."
            : "No active projects with open tasks."
        }
      />
    );
  }

  const maxCount = Math.max(
    1,
    ...projectRows.flatMap((p) =>
      statuses.map((s) => grid.get(p.key)?.get(s) ?? 0),
    ),
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
          {projectRows.map((row) => (
            <tr key={row.key} className="border-border/50 border-t">
              <td className="max-w-[150px] truncate py-2 pr-2 font-medium">
                {row.name}
              </td>
              {statuses.map((status) => {
                const count = grid.get(row.key)?.get(status) ?? 0;
                const intensity = count / maxCount;
                const color = getStatusChartColor(status);

                return (
                  <td key={status} className="px-2 py-2 text-center">
                    {count > 0 ? (
                      <span
                        className="inline-flex h-6 w-8 items-center justify-center font-medium text-background text-xs"
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
