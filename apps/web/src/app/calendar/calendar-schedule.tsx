import type { CalendarScheduleOut } from "@cubby/schemas/calendar";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import {
  ScheduleGrid,
  type ScheduleRow,
  type ScheduleSegment,
  type ScheduleWindow,
} from "~/app/_components/schedule/schedule-grid";
import { TASK_STATUS_LABELS } from "~/app/tasks/task-options";
import { Description } from "~/components/ui/description";
import { entityDetailLink } from "~/entities/entities";

const milestoneFields = [
  ["sowedOn", "Sowed"],
  ["transplantedOn", "Transplanted"],
  ["finishedOn", "Finished"],
] as const;

/** Preserve one record row while rendering each known lifecycle date. */
export function calendarScheduleRows(data: CalendarScheduleOut): ScheduleRow[] {
  const tasks: ScheduleRow[] = data.tasks.map((task) => {
    const first = task.dueDate ?? task.dueEndDate;
    const last = task.dueEndDate ?? task.dueDate;
    const segments: ScheduleSegment[] =
      first && last
        ? [
            {
              id: `task:${task.id}:due`,
              label: "Due",
              startDate: first < last ? first : last,
              endDate: first < last ? last : first,
              variant: "range",
            },
          ]
        : [];
    return {
      id: `task:${task.id}`,
      name: task.name,
      depth: 1,
      meta: [TASK_STATUS_LABELS[task.status], task.projectName]
        .filter(Boolean)
        .join(" · "),
      segments,
      noDateLabel: "No due date",
    };
  });
  const plantings: ScheduleRow[] = data.plantings.map((planting) => ({
    id: `planting:${planting.id}`,
    name: planting.displayName,
    depth: 1,
    meta: [planting.locationName, planting.plannedWindow]
      .filter(Boolean)
      .join(" · "),
    segments: milestoneFields.flatMap(([field, label]) => {
      const date = planting[field];
      return date
        ? [
            {
              id: `planting:${planting.id}:${field}`,
              label,
              startDate: date,
              variant: "milestone" as const,
            },
          ]
        : [];
    }),
    noDateLabel: "No milestone date",
  }));
  return [
    {
      id: "group:tasks",
      name: "Tasks",
      depth: 0,
      group: true,
      meta: `${tasks.length}`,
      segments: [],
    },
    ...tasks,
    {
      id: "group:plantings",
      name: "Plantings",
      depth: 0,
      group: true,
      meta: `${plantings.length}`,
      segments: [],
    },
    ...plantings,
  ];
}

interface CalendarScheduleProps {
  data: CalendarScheduleOut;
  window: ScheduleWindow;
}

export function CalendarSchedule({ data, window }: CalendarScheduleProps) {
  const navigate = useNavigate();
  const rows = useMemo(() => calendarScheduleRows(data), [data]);
  const renderLabel = (row: ScheduleRow) => {
    if (row.id.startsWith("task:")) {
      return (
        <Link
          {...entityDetailLink("task", row.id.slice("task:".length))}
          title={row.name}
          className="truncate hover:text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {row.name}
        </Link>
      );
    }
    if (row.id.startsWith("planting:")) {
      return (
        <Link
          {...entityDetailLink("planting", row.id.slice("planting:".length))}
          title={row.name}
          className="truncate hover:text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {row.name}
        </Link>
      );
    }
    return row.name;
  };
  const onRowActivate = (row: ScheduleRow) => {
    if (row.id.startsWith("task:")) {
      void navigate(entityDetailLink("task", row.id.slice("task:".length)));
    } else if (row.id.startsWith("planting:")) {
      void navigate(
        entityDetailLink("planting", row.id.slice("planting:".length)),
      );
    }
  };
  return (
    <div className="space-y-2">
      {data.tasks.length === 0 && data.plantings.length === 0 && (
        <Description>No tasks or plantings in this schedule.</Description>
      )}
      <ScheduleGrid
        rows={rows}
        window={window}
        ariaLabel="Tasks and plantings schedule"
        renderLabel={renderLabel}
        onRowActivate={onRowActivate}
      />
    </div>
  );
}
