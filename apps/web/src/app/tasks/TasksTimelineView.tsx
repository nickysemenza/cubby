import type { TaskFilters, TaskOut } from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CalendarClock } from "lucide-react";
import { lazy, type ReactNode, Suspense, useCallback, useMemo } from "react";
import { ChartEmpty } from "~/app/projects/charts/chart-empty";
import { toDayIndex, todayPlain } from "~/app/projects/charts/gantt/gantt-date";
import type {
  DayRange,
  GanttRow,
} from "~/app/projects/charts/gantt/gantt-model";
import { TaskHeatmap } from "~/app/projects/charts/task-heatmap";
import { Section, Stack } from "~/components/layout";
import { Skeleton } from "~/components/ui/skeleton";
import { entities, entityDetailParams } from "~/entities/entities";
import { useTRPC } from "~/integrations/trpc/react";
import { TasksAgenda } from "./TasksAgenda";

/** Stable empty default — never a fresh `[]` per render (would churn memos). */
const NO_TASKS: TaskOut[] = [];

/** Breathing room on each side of the data extent for the initial window. */
const WINDOW_PAD_DAYS = 7;
/** Fallback window when there's no dated content at all: a rolling quarter,
 * mirroring `ProjectGantt`'s fallback. */
const FALLBACK_LEAD_DAYS = 14;
const FALLBACK_TRAIL_DAYS = 75;
const LazyCubbyGantt = lazy(() =>
  import("~/app/projects/charts/gantt/CubbyGantt").then(({ CubbyGantt }) => ({
    default: CubbyGantt,
  })),
);

function hasDueDate(t: TaskOut): t is TaskOut & { dueDate: string } {
  return t.dueDate != null;
}

/**
 * Flat (unranked, ungrouped) Gantt rows straight off `TaskOut` — no project
 * hierarchy involved, unlike `buildProjectRows`/`buildPortfolioRows`, since
 * this is a cross-project "everything with a due date" view. A task with
 * `dueDate` + `dueEndDate` is a multi-day bar; a bare `dueDate` is a 1-day
 * milestone (`startDay === endDay`, same convention as `buildTaskRow`).
 */
function buildFlatTaskRows(tasks: TaskOut[]): {
  rows: GanttRow[];
  extent: DayRange | null;
} {
  const dated = tasks
    .filter(hasDueDate)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  let min: number | null = null;
  let max: number | null = null;
  const rows: GanttRow[] = dated.map((t): GanttRow => {
    const startDay = toDayIndex(t.dueDate);
    const endDay = t.dueEndDate ? toDayIndex(t.dueEndDate) : startDay;
    min = min == null || startDay < min ? startDay : min;
    max = max == null || endDay > max ? endDay : max;
    return {
      kind: "task",
      id: t.id,
      name: t.name,
      depth: 0,
      status: t.status,
      startDay,
      endDay,
      trade: t.trade,
      blockedByIds: t.blockedByIds,
      blockingIds: t.blockingIds,
    };
  });

  return {
    rows,
    extent: min != null && max != null ? { startDay: min, endDay: max } : null,
  };
}

function paddedWindow(extent: DayRange | null): DayRange {
  if (extent == null) {
    const today = toDayIndex(todayPlain());
    return {
      startDay: today - FALLBACK_LEAD_DAYS,
      endDay: today + FALLBACK_TRAIL_DAYS,
    };
  }
  return {
    startDay: extent.startDay - WINDOW_PAD_DAYS,
    endDay: extent.endDay + WINDOW_PAD_DAYS,
  };
}

/** A cross-project, flat Gantt over every dated task — the range-aware
 * counterpart to the day-bucketed heatmap above it. Reuses the shared
 * `CubbyGantt` renderer (see `ProjectGantt`/`PortfolioGantt`) with a local,
 * hierarchy-free row builder instead of `gantt-model`'s project-coupled ones. */
function TasksGanttTimeline({ tasks }: { tasks: TaskOut[] }) {
  const { rows, extent } = useMemo(() => buildFlatTaskRows(tasks), [tasks]);
  const defaultWindow = useMemo(() => paddedWindow(extent), [extent]);

  const renderName = useCallback((row: GanttRow): ReactNode => {
    if (row.kind !== "task") return null;
    return (
      <Link
        to={entities.task.routes.detail}
        params={entityDetailParams(row.id)}
        className="hover:underline"
      >
        {row.name}
      </Link>
    );
  }, []);

  return (
    <Suspense fallback={<Skeleton className="h-[34rem] w-full" />}>
      <LazyCubbyGantt
        rows={rows}
        window={defaultWindow}
        renderName={renderName}
        emptyMessage="No tasks with due dates yet."
      />
    </Suspense>
  );
}

function TimelineSkeleton() {
  return (
    <Stack gap="lg">
      <Skeleton className="h-48 w-full" />
      <Skeleton className="h-64 w-full" />
    </Stack>
  );
}

/** The `/tasks?view=timeline` surface: a calendar heatmap of due-date density
 * plus a flat Gantt for tasks that span a range (`dueDate` + `dueEndDate`).
 * Fetch-all, same convention as the board (`TasksBoardView`). */
export function TasksTimelineView({ filters }: { filters: TaskFilters }) {
  const api = useTRPC();
  const { data, isLoading } = useQuery(api.task.timeline.queryOptions(filters));
  const datedTasks = data?.tasks ?? NO_TASKS;

  if (isLoading) {
    return <TimelineSkeleton />;
  }

  if (datedTasks.length === 0) {
    return (
      <ChartEmpty icon={CalendarClock} title="No tasks have due dates yet." />
    );
  }

  return (
    <Stack gap="lg">
      <p className="text-muted-foreground text-xs">
        Timeline intrinsically shows dated tasks only.{" "}
        {data && data.undatedCount > 0 && (
          <>
            {data.undatedCount} matching undated task
            {data.undatedCount === 1 ? " is" : "s are"} omitted.{" "}
          </>
        )}
        <Link
          to="/tasks"
          search={{ view: "list" }}
          className="underline underline-offset-2 hover:text-foreground"
        >
          Open the complete List
        </Link>
        .
      </p>
      <Section
        title="Calendar"
        description="Due-date density across every task."
      >
        <TaskHeatmap tasks={datedTasks} />
      </Section>
      <Section
        title="Timeline"
        description="Ranges (dueDate → dueEndDate) as bars; single due dates as milestones."
      >
        {/* Both trees render; the BREAKPOINT decides, not JS — same pattern
            as `unified-calendar.tsx`'s agenda fallback and the task board's
            `BoardAgenda`: a horizontal Gantt has no usable form at phone
            width, so mobile gets chronological rows instead. */}
        <div className="md:hidden">
          <TasksAgenda tasks={datedTasks} />
        </div>
        <div className="hidden md:block">
          <TasksGanttTimeline tasks={datedTasks} />
        </div>
      </Section>
    </Stack>
  );
}
