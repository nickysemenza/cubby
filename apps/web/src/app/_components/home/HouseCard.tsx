import type {
  TaskTodayBriefingItemOut,
  TaskTodayBriefingOut,
} from "@cubby/schemas/project";
import { HammerIcon } from "@phosphor-icons/react/dist/csr/Hammer";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useMemo } from "react";

import {
  EntityDisplayImagesProvider,
  useEntityDisplayImage,
} from "~/app/_components/entity-media/entity-display-images";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { formatDateRange } from "~/app/projects/project-formatting";
import { task } from "~/app/tasks/task.functions";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { getErrorMessage } from "~/lib/error-utils";

export const TODAY_ENTITY_LINK_CLASS = "min-h-11 items-center sm:min-h-0";
type TodayBriefingCounts = Pick<
  TaskTodayBriefingOut,
  | "nextCount"
  | "laterCount"
  | "blockedCount"
  | "overdueCount"
  | "dueThisWeekCount"
> & { next: readonly unknown[] };

/**
 * Today's briefing receives only this already-ranked prefix from the server;
 * it never invents a client-side score or has to fetch the actionable graph.
 */
export function taskBriefingEvidence(
  briefing: TodayBriefingCounts | undefined,
): string | null {
  if (!briefing) return null;
  const parts = [
    briefing.overdueCount > 0 ? `${briefing.overdueCount} overdue` : null,
    briefing.dueThisWeekCount > 0
      ? `${briefing.dueThisWeekCount} due this week`
      : null,
    briefing.blockedCount > 0 ? `${briefing.blockedCount} blocked` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "Nothing urgent is due.";
}

export function taskBriefingSecondary(
  briefing: TodayBriefingCounts | undefined,
): string | null {
  if (!briefing) return null;
  const hiddenNext = Math.max(briefing.nextCount - briefing.next.length, 0);
  const parts = [
    hiddenNext > 0 ? `${hiddenNext} more ready` : null,
    briefing.laterCount > 0 ? `${briefing.laterCount} later` : null,
    briefing.blockedCount > 0 ? `${briefing.blockedCount} blocked` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function TaskBriefingEvidenceLine({
  briefing,
}: {
  briefing: TodayBriefingCounts | undefined;
}) {
  return (
    <p className="mt-2 flex flex-wrap gap-x-2 font-mono text-2xs text-muted-foreground uppercase">
      {taskBriefingEvidence(briefing)
        ?.split(" · ")
        .map((part) => (
          <span key={part} className="whitespace-nowrap">
            {part}
          </span>
        ))}
    </p>
  );
}

function TodayTaskRow({ task: item }: { task: TaskTodayBriefingItemOut }) {
  const taskImage = useEntityDisplayImage({
    entityType: "task",
    entityId: item.id,
  });
  const projectImage = useEntityDisplayImage({
    entityType: "project",
    entityId: item.projectId ?? "",
  });
  return (
    <div className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-b border-border py-2 last:border-b-0 sm:min-h-0 sm:py-1.5">
      <EntityInlineLink
        entity="task"
        data={{ id: item.id, name: item.name, status: item.status }}
        displayImage={taskImage}
        className={TODAY_ENTITY_LINK_CLASS}
        truncate
      />
      <span className="font-mono text-2xs text-muted-foreground tabular-nums">
        {formatDateRange(item.dueDate, item.dueEndDate)}
      </span>
      {item.projectId && item.projectName ? (
        <EntityInlineLink
          entity="project"
          data={{ id: item.projectId, name: item.projectName }}
          displayImage={projectImage}
          className={TODAY_ENTITY_LINK_CLASS}
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
 * The bounded briefing query is safe to preload with the rest of Today's
 * first paint: it shares actionable blocking semantics without hydrating the
 * full graph or its why-chain display data.
 */
export function TodayAttention() {
  const titleId = useId();
  const briefing = useQuery(task.todayBriefing.queryOptions());
  const secondary = taskBriefingSecondary(briefing.data);
  const imageRefs = useMemo(
    () =>
      (briefing.data?.next ?? []).flatMap((item) => [
        { entityType: "task" as const, entityId: item.id },
        ...(item.projectId
          ? [{ entityType: "project" as const, entityId: item.projectId }]
          : []),
      ]),
    [briefing.data?.next],
  );

  return (
    <section aria-labelledby={titleId} className="min-w-0">
      <div className="flex items-start justify-between gap-3 border-b border-border pb-2">
        <div className="flex min-w-0 items-start gap-2">
          <HammerIcon
            className="mt-0.5 size-4 shrink-0 text-slate"
            aria-hidden
          />
          <div className="min-w-0">
            <h2 id={titleId} className="font-heading text-base font-semibold">
              Next up
            </h2>
            <p className="text-xs text-muted-foreground">
              Unblocked household work, in its existing priority order.
            </p>
          </div>
        </div>
        <Button
          render={<Link to="/tasks" search={{ view: "agenda" }} />}
          nativeButton={false}
          variant="ghost"
          size="sm"
          className="h-11 shrink-0 text-xs sm:h-7"
        >
          All tasks
        </Button>
      </div>

      {briefing.isLoading ? (
        <Skeleton className="mt-2 h-4 w-44" />
      ) : briefing.isError ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Task summary is unavailable right now.
          <Button
            type="button"
            variant="link"
            size="sm"
            className="ml-1 min-h-11 px-0 text-xs sm:min-h-0"
            onClick={() => briefing.refetch()}
          >
            Retry
          </Button>
        </p>
      ) : (
        <TaskBriefingEvidenceLine briefing={briefing.data} />
      )}

      <div className="mt-2 border-y border-border">
        {briefing.isLoading ? (
          <output
            className="block space-y-2 py-2"
            aria-label="Loading next tasks"
          >
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-4/5" />
          </output>
        ) : briefing.isError ? (
          <div className="flex min-h-16 items-center justify-between gap-3 py-2">
            <p className="text-xs text-muted-foreground">
              Couldn&apos;t load the next task queue:{" "}
              {getErrorMessage(briefing.error)}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 shrink-0 sm:min-h-0"
              onClick={() => briefing.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : briefing.data?.next.length === 0 ? (
          <p className="min-h-16 content-center py-2 text-sm text-muted-foreground">
            Nothing ready right now. Open work is blocked or set aside.
          </p>
        ) : (
          <EntityDisplayImagesProvider refs={imageRefs}>
            {briefing.data?.next.map((item) => (
              <TodayTaskRow key={item.id} task={item} />
            ))}
          </EntityDisplayImagesProvider>
        )}
      </div>

      {secondary ? (
        <p className="mt-2 font-mono text-2xs text-muted-foreground uppercase">
          {secondary}
        </p>
      ) : null}
    </section>
  );
}
