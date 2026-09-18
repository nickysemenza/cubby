import type { TaskOut } from "@cubby/schemas/project";
import { Link } from "@tanstack/react-router";
import { CalendarClock } from "lucide-react";
import { useMemo } from "react";

import {
  entityDisplayImageKey,
  useEntityDisplayImages,
} from "~/app/_components/entity-media/entity-display-images";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { entities, entityDetailParams } from "~/entities/entities";

import { formatDate, StatusIcon } from "../shared";
import { CalendarHeatmap } from "./calendar-heatmap";
import { ChartEmpty } from "./chart-empty";
import { ChartTooltip } from "./ChartTooltip";

export function TaskHeatmap({ tasks }: { tasks: TaskOut[] }) {
  const projectRefs = useMemo(
    () =>
      tasks.flatMap((task) =>
        task.projectId
          ? [{ entityType: "project" as const, entityId: task.projectId }]
          : [],
      ),
    [tasks],
  );
  const projectImages = useEntityDisplayImages(projectRefs);
  const { data, from, to, itemsByDay } = useMemo(() => {
    const byDay = new Map<string, number>();
    const itemsByDay = new Map<string, TaskOut[]>();
    for (const t of tasks) {
      if (!t.dueDate) continue;
      byDay.set(t.dueDate, (byDay.get(t.dueDate) ?? 0) + 1);
      if (!itemsByDay.has(t.dueDate)) itemsByDay.set(t.dueDate, []);
      itemsByDay.get(t.dueDate)!.push(t);
    }

    const data = Array.from(byDay.entries()).map(([day, value]) => ({
      day,
      value,
    }));

    if (data.length === 0)
      return {
        data: [],
        from: "",
        to: "",
        itemsByDay: new Map<string, TaskOut[]>(),
      };

    const dates = data.map((d) => d.day).sort();
    return {
      data,
      from: dates[0]!,
      to: dates[dates.length - 1]!,
      itemsByDay,
    };
  }, [tasks]);

  if (data.length === 0) {
    return <ChartEmpty icon={CalendarClock} title="No tasks with due dates." />;
  }

  return (
    <CalendarHeatmap
      data={data}
      from={from}
      to={to}
      itemsByDay={itemsByDay}
      tooltip={({ day, value }) => (
        <ChartTooltip>
          <strong>{day}</strong>: {value} task
          {Number(value) !== 1 ? "s" : ""} due
          <div className="text-xs text-muted-foreground">
            Click to see tasks
          </div>
        </ChartTooltip>
      )}
      summary={(day, items) => (
        <>
          {formatDate(day)} — {items.length} task{items.length !== 1 ? "s" : ""}
        </>
      )}
      renderItem={(task) => (
        <div
          key={task.id}
          className="flex items-center gap-2 rounded px-2 py-1 text-xs"
        >
          <StatusIcon status={task.status} />
          <Link
            to={entities.task.routes.detail}
            params={entityDetailParams(task.id)}
            className="truncate hover:underline"
            title={task.name}
          >
            {task.name}
          </Link>
          {task.projectId && task.projectName && (
            <span className="ml-auto max-w-32 min-w-0 text-muted-foreground">
              <EntityInlineLink
                displayImage={
                  projectImages[
                    entityDisplayImageKey({
                      entityType: "project",
                      entityId: task.projectId,
                    })
                  ] ?? null
                }
                entity="project"
                data={{ id: task.projectId, name: task.projectName }}
                truncate
              />
            </span>
          )}
        </div>
      )}
    />
  );
}
