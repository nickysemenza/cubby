import type { ProjectOut, TaskOut, TaskStatus } from "@cubby/schemas/project";
import { sum } from "es-toolkit";
import { ListChecks } from "lucide-react";
import { useMemo } from "react";
import { NoneValue } from "~/components/ui/none-value";
import { getStatusChartColor } from "~/lib/status-colors";
import { TASK_STATUS_LABELS } from "../shared";
import { ChartEmpty } from "./chart-empty";

const STATUS_ORDER: TaskStatus[] = [
  "not_started",
  "later",
  "in_progress",
  "blocked",
  "done",
];

export function TaskStatusBoard({
  tasks,
  projects,
}: {
  tasks: TaskOut[];
  projects: ProjectOut[];
}) {
  const { grid, projectRows, statuses } = useMemo(() => {
    const projectMap = new Map(projects.map((p) => [p.name, p]));

    // Count tasks per project × status
    const counts = new Map<string, Map<TaskStatus, number>>();
    const projectSet = new Set<string>();
    const statusSet = new Set<TaskStatus>();

    for (const t of tasks) {
      const project = t.projectName ?? "Unassigned";
      const status = t.status;
      projectSet.add(project);
      statusSet.add(status);

      if (!counts.has(project)) counts.set(project, new Map());
      const row = counts.get(project)!;
      row.set(status, (row.get(status) ?? 0) + 1);
    }

    // Sort projects by date (most recent first), then by name
    const projectRows = Array.from(projectSet)
      .map((name) => {
        const proj = projectMap.get(name);
        return {
          name,
          date: proj?.startDate ?? "",
          isDone: proj?.status === "done",
          total: sum(Array.from(counts.get(name)?.values() ?? [])),
        };
      })
      .sort((a, b) => {
        // Active first, then done
        if (a.isDone !== b.isDone) return a.isDone ? 1 : -1;
        // Then by date descending
        if (a.date && b.date) return b.date.localeCompare(a.date);
        if (a.date) return -1;
        if (b.date) return 1;
        return b.total - a.total;
      })
      .slice(0, 15);

    const statuses = STATUS_ORDER.filter((s) => statusSet.has(s));

    return { grid: counts, projectRows, statuses };
  }, [tasks, projects]);

  if (projectRows.length === 0) {
    return <ChartEmpty icon={ListChecks} title="No task data." />;
  }

  const maxCount = Math.max(
    1,
    ...projectRows.flatMap((p) =>
      statuses.map((s) => grid.get(p.name)?.get(s) ?? 0),
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
            <tr key={row.name} className="border-border/50 border-t">
              <td
                className={`max-w-[150px] truncate py-2 pr-2 font-medium ${row.isDone ? "text-muted-foreground line-through" : ""}`}
              >
                {row.name}
              </td>
              {statuses.map((status) => {
                const count = grid.get(row.name)?.get(status) ?? 0;
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
