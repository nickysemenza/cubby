import type { DisplayImageSummary } from "@cubby/schemas/display-images";
import type { EntityRef } from "@cubby/schemas/entity";
import { MAX_PAGE_SIZE } from "@cubby/schemas/pagination";
import type { ProjectOut, TaskOut } from "@cubby/schemas/project";
import { ArrowRightIcon as ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { NetworkIcon as Network } from "@phosphor-icons/react/dist/csr/Network";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";

import type { ListSlotProps } from "~/app/_components/entity-list/list-slot-types";
import {
  entityDisplayImageKey,
  type EntityDisplayImageMap,
  useEntityDisplayImages,
} from "~/app/_components/entity-media/entity-display-images";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { flattenUniquePageItems } from "~/app/_components/hooks/infinite-page-utils";
import {
  ScheduleGrid,
  type ScheduleRow,
} from "~/app/_components/schedule/schedule-grid";
import { task } from "~/app/tasks/task.functions";
import { Button } from "~/components/ui/button";
import { entityDetailParams, entities } from "~/entities/entities";
import {
  compileEntityListInput,
  entityListFor,
} from "~/entities/entity-list.functions";
import type { FilterPatch } from "~/entities/filters";
import { getErrorMessage } from "~/lib/error-utils";

import {
  projectGanttSubtreeQueryParams,
  projectSubtreeTasksFilters,
} from "./project-query-params";
import {
  buildDetailScheduleRows,
  buildPortfolioScheduleRows,
  type ProjectScheduleEntry,
  projectScheduleWindow,
} from "./project-schedule-model";
import { project } from "./project.functions";

const EMPTY_TASKS: TaskOut[] = [];

function seedProjectImages(
  projects: readonly { id: string; displayImages: DisplayImageSummary[] }[],
): EntityDisplayImageMap {
  return Object.fromEntries(
    projects.map((project) => [
      entityDisplayImageKey({ entityType: "project", entityId: project.id }),
      project.displayImages[0] ?? null,
    ]),
  );
}

function useLoadRemainingPages(query: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isError: boolean;
  fetchNextPage: (options: { cancelRefetch: false }) => void;
}) {
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = query;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError) {
      fetchNextPage({ cancelRefetch: false });
    }
  }, [hasNextPage, isFetchingNextPage, isError, fetchNextPage]);
}

function ScheduleError({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-md border border-border bg-card p-4 text-sm"
    >
      <p className="font-medium">Couldn't load the project schedule</p>
      <p className="mt-1 text-muted-foreground">{getErrorMessage(error)}</p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-3"
        onClick={retry}
      >
        Retry
      </Button>
    </div>
  );
}

function ProjectDependencyInspection({
  entry,
  names,
  onClose,
}: {
  entry: ProjectScheduleEntry;
  names: ReadonlyMap<string, string>;
  onClose: () => void;
}) {
  const relation = (label: string, ids: string[]) => (
    <div className="flex flex-wrap items-center gap-2">
      <span className="min-w-20 text-xs text-muted-foreground">{label}</span>
      {ids.length === 0 ? (
        <span className="text-xs text-muted-foreground">None</span>
      ) : (
        ids.map((id) => (
          <Link
            key={id}
            to={entities[entry.entity].routes.detail}
            params={entityDetailParams(id)}
            title={names.get(id) ?? id}
            className="inline-flex min-h-10 items-center rounded-sm border border-border px-2 text-xs text-primary hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:min-h-7"
          >
            {names.get(id) ?? id}
          </Link>
        ))
      )}
    </div>
  );
  return (
    <section
      className="rounded-md border border-border bg-card p-3"
      aria-label={`Dependencies for ${entry.name}`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Dependencies for {entry.name}</h3>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="space-y-2">
        {relation("Blocked by", entry.blockedByIds)}
        {relation("Blocking", entry.blockingIds)}
      </div>
    </section>
  );
}

function ProjectScheduleSurface({
  allRows,
  rows,
  onToggle,
  ariaLabel,
  seededImages,
}: {
  allRows: ProjectScheduleEntry[];
  rows: ProjectScheduleEntry[];
  onToggle: (id: string) => void;
  ariaLabel: string;
  seededImages: EntityDisplayImageMap;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const byId = useMemo(
    () => new Map(allRows.map((row) => [row.id, row])),
    [allRows],
  );
  const names = useMemo(
    () => new Map(allRows.map((row) => [row.id, row.name])),
    [allRows],
  );
  const selected = selectedId ? byId.get(selectedId) : undefined;
  const window = useMemo(() => projectScheduleWindow(allRows), [allRows]);
  const refs = useMemo<EntityRef[]>(
    () => allRows.map((row) => ({ entityType: row.entity, entityId: row.id })),
    [allRows],
  );
  const images = useEntityDisplayImages(refs, seededImages);
  const renderLabel = useCallback(
    (row: ScheduleRow) => {
      const entry = byId.get(row.id);
      if (!entry) return row.name;
      const count = entry.blockedByIds.length + entry.blockingIds.length;
      return (
        <span className="flex w-full min-w-0 items-center gap-1">
          <EntityInlineLink
            entity={entry.entity}
            data={{ id: entry.id, name: entry.name }}
            displayImage={
              images[
                entityDisplayImageKey({
                  entityType: entry.entity,
                  entityId: entry.id,
                })
              ] ?? null
            }
            truncate
            className="min-w-0 flex-1"
          />
          {count > 0 && (
            <button
              type="button"
              aria-label={`Inspect dependencies for ${entry.name}`}
              aria-pressed={selectedId === entry.id}
              title={`${count} dependencies`}
              onClick={() =>
                setSelectedId((current) =>
                  current === entry.id ? null : entry.id,
                )
              }
              className="inline-flex size-10 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:size-6"
            >
              <Network className="size-3.5" aria-hidden="true" />
            </button>
          )}
        </span>
      );
    },
    [byId, images, selectedId],
  );

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {allRows.length} activities ·{" "}
          {allRows.filter((row) => row.segments.length === 0).length} without
          dates
        </span>
        <span className="inline-flex items-center gap-1">
          Open a name for its record{" "}
          <ArrowRight className="size-3" aria-hidden="true" />
        </span>
      </div>
      {selected && (
        <ProjectDependencyInspection
          entry={selected}
          names={names}
          onClose={() => setSelectedId(null)}
        />
      )}
      <ScheduleGrid
        rows={rows}
        window={window}
        ariaLabel={ariaLabel}
        renderLabel={renderLabel}
        onToggle={onToggle}
        onRowActivate={(row) => {
          const entry = byId.get(row.id);
          if (entry && entry.blockedByIds.length + entry.blockingIds.length > 0)
            setSelectedId(entry.id);
        }}
      />
    </div>
  );
}

export function ProjectScheduleListSlot({ search }: ListSlotProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const input = useMemo(() => {
    const routeFilters: FilterPatch = {};
    for (const [key, value] of Object.entries(search)) {
      const parsed = z.string().safeParse(value);
      if (parsed.success) routeFilters[key] = parsed.data;
    }
    const listInput = compileEntityListInput("project", routeFilters, {
      pageSize: MAX_PAGE_SIZE,
    });
    return {
      filters: listInput.filters,
      sort: listInput.sort,
      pagination: { pageIndex: 0, pageSize: MAX_PAGE_SIZE },
    };
  }, [search]);
  const query = useInfiniteQuery(
    project.tree.infiniteQueryOptions(input, {
      pageParamSchema: z.number().int().nonnegative(),
      initialPageParam: 0,
      page: (first, pageIndex) => ({
        ...first,
        pagination: { ...first.pagination, pageIndex },
      }),
      getNextPageParam: (page) => {
        const { pageIndex, pageSize, totalCount } = page.meta;
        return (pageIndex + 1) * pageSize < totalCount
          ? pageIndex + 1
          : undefined;
      },
    }),
  );
  useLoadRemainingPages(query);
  const projects = useMemo(
    () => flattenUniquePageItems(query.data?.pages),
    [query.data],
  );
  const allRows = useMemo(
    () => buildPortfolioScheduleRows(projects, new Set()),
    [projects],
  );
  const rows = useMemo(
    () => buildPortfolioScheduleRows(projects, collapsed),
    [projects, collapsed],
  );
  const seededImages = useMemo(() => seedProjectImages(projects), [projects]);
  const toggle = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  if (query.isError)
    return (
      <ScheduleError
        error={query.error}
        retry={() => {
          void query.refetch();
        }}
      />
    );
  if (query.isPending || query.hasNextPage || query.isFetchingNextPage) {
    return (
      <output className="block p-4 text-sm text-muted-foreground">
        Loading the full project schedule…
      </output>
    );
  }
  return (
    <ProjectScheduleSurface
      allRows={allRows}
      rows={rows}
      onToggle={toggle}
      ariaLabel="Project schedule"
      seededImages={seededImages}
    />
  );
}

export function ProjectScheduleDetail({
  projectId,
  record,
}: {
  projectId: string;
  record: ProjectOut;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const projectsQuery = useInfiniteQuery(
    entityListFor("project").infiniteQueryOptions(
      projectGanttSubtreeQueryParams(projectId),
    ),
  );
  useLoadRemainingPages(projectsQuery);
  const tasksQuery = useQuery(
    task.chartData.queryOptions(projectSubtreeTasksFilters(projectId)),
  );
  const descendants = useMemo(
    () => flattenUniquePageItems(projectsQuery.data?.pages),
    [projectsQuery.data],
  );
  const tasks = tasksQuery.data ?? EMPTY_TASKS;
  const allRows = useMemo(
    () => buildDetailScheduleRows(record, descendants, tasks, new Set()),
    [record, descendants, tasks],
  );
  const rows = useMemo(
    () => buildDetailScheduleRows(record, descendants, tasks, collapsed),
    [record, descendants, tasks, collapsed],
  );
  const seededImages = useMemo(
    () => seedProjectImages(descendants),
    [descendants],
  );
  const toggle = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  if (projectsQuery.isError || tasksQuery.isError) {
    return (
      <ScheduleError
        error={projectsQuery.error ?? tasksQuery.error}
        retry={() => {
          void projectsQuery.refetch();
          void tasksQuery.refetch();
        }}
      />
    );
  }
  if (
    projectsQuery.isPending ||
    projectsQuery.hasNextPage ||
    projectsQuery.isFetchingNextPage ||
    tasksQuery.isPending
  ) {
    return (
      <output className="block p-4 text-sm text-muted-foreground">
        Loading the full project schedule…
      </output>
    );
  }
  return (
    <ProjectScheduleSurface
      allRows={allRows}
      rows={rows}
      onToggle={toggle}
      ariaLabel={`${record.name} schedule`}
      seededImages={seededImages}
    />
  );
}
