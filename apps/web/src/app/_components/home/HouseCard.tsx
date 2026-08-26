import type { ActionableTaskOut, TaskSummaryOut } from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Hammer } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { formatDateRange } from "~/app/projects/project-formatting";
import { task } from "~/app/tasks/task.functions";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { getErrorMessage } from "~/lib/error-utils";

const EMPTY_TASK_FILTERS = {};
const TODAY_TASK_LIMIT = 4;

/**
 * The actual next-work order belongs to `task.listActionable`: it is already
 * overdue-first and explains blocked work in the Tasks route. Today only takes
 * a bounded prefix for a daily briefing; it never invents a client-side score.
 */
export function visibleTodayTasks<T>(rows: readonly T[]): T[] {
  return rows.slice(0, TODAY_TASK_LIMIT);
}

function taskEvidence(summary: TaskSummaryOut | undefined): string | null {
  if (!summary) return null;
  const parts = [
    summary.overdue > 0 ? `${summary.overdue} overdue` : null,
    summary.dueThisWeek > 0 ? `${summary.dueThisWeek} due this week` : null,
    summary.blocked > 0 ? `${summary.blocked} blocked` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "Nothing urgent is due.";
}

function TodayTaskRow({ task: item }: { task: ActionableTaskOut }) {
  return (
    <div className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-border border-b py-2 last:border-b-0 sm:min-h-0 sm:py-1.5">
      <EntityInlineLink
        entity="task"
        data={{ id: item.id, name: item.name, status: item.status }}
        displayImage={undefined}
        truncate
      />
      <span className="font-mono text-2xs text-muted-foreground tabular-nums">
        {formatDateRange(item.dueDate, item.dueEndDate)}
      </span>
      {item.projectId && item.projectName ? (
        <EntityInlineLink
          entity="project"
          data={{ id: item.projectId, name: item.projectName }}
          displayImage={undefined}
          compact
        />
      ) : (
        <span className="font-mono text-2xs text-slate uppercase">
          House task
        </span>
      )}
    </div>
  );
}

/**
 * The daily work briefing keeps its first paint on the small task summary.
 * The complete actionable graph begins only after mount so Home's loader does
 * not become hostage to a larger work queue read.
 */
export function TodayAttention() {
  const [showQueue, setShowQueue] = useState(false);
  const titleId = useId();
  useEffect(() => setShowQueue(true), []);

  const summary = useQuery(task.summary.queryOptions());
  const queue = useQuery({
    ...task.listActionable.queryOptions(EMPTY_TASK_FILTERS),
    enabled: showQueue,
  });
  const next = visibleTodayTasks(queue.data?.next ?? []);
  const hiddenNext = Math.max((queue.data?.next.length ?? 0) - next.length, 0);
  const secondary = [
    hiddenNext > 0 ? `${hiddenNext} more ready` : null,
    (queue.data?.later.length ?? 0) > 0
      ? `${queue.data?.later.length} later`
      : null,
    (queue.data?.blocked.length ?? 0) > 0
      ? `${queue.data?.blocked.length} blocked`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section aria-labelledby={titleId} className="min-w-0">
      <div className="flex items-start justify-between gap-3 border-border border-b pb-2">
        <div className="flex min-w-0 items-start gap-2">
          <Hammer className="mt-0.5 size-4 shrink-0 text-slate" aria-hidden />
          <div className="min-w-0">
            <h2 id={titleId} className="font-heading font-semibold text-base">
              Next up
            </h2>
            <p className="text-muted-foreground text-xs">
              Unblocked household work, in its existing priority order.
            </p>
          </div>
        </div>
        <Button
          render={<Link to="/tasks" search={{ view: "next" }} />}
          nativeButton={false}
          variant="ghost"
          size="sm"
          className="h-11 shrink-0 text-xs sm:h-7"
        >
          All tasks
        </Button>
      </div>

      {summary.isLoading ? (
        <Skeleton className="mt-2 h-4 w-44" />
      ) : summary.isError ? (
        <p className="mt-2 text-muted-foreground text-xs">
          Task summary is unavailable right now.
          <Button
            type="button"
            variant="link"
            size="sm"
            className="ml-1 h-auto px-0 text-xs"
            onClick={() => summary.refetch()}
          >
            Retry
          </Button>
        </p>
      ) : (
        <p className="mt-2 font-mono text-2xs text-muted-foreground uppercase">
          {taskEvidence(summary.data)}
        </p>
      )}

      <div className="mt-2 border-border border-y">
        {!showQueue || queue.isLoading ? (
          <div
            className="space-y-2 py-2"
            role="status"
            aria-label="Loading next tasks"
          >
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-4/5" />
          </div>
        ) : queue.isError ? (
          <div className="flex min-h-16 items-center justify-between gap-3 py-2">
            <p className="text-muted-foreground text-xs">
              Couldn&apos;t load the next task queue:{" "}
              {getErrorMessage(queue.error)}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => queue.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : next.length === 0 ? (
          <p className="min-h-16 content-center py-2 text-muted-foreground text-sm">
            Nothing ready right now. Open work is blocked or set aside.
          </p>
        ) : (
          next.map((item) => <TodayTaskRow key={item.id} task={item} />)
        )}
      </div>

      {secondary && (
        <p className="mt-2 font-mono text-2xs text-muted-foreground uppercase">
          {secondary}
        </p>
      )}
    </section>
  );
}
