import {
  isSlotListView,
  listViewId,
} from "@cubby/schemas/entity-definitions/definition";
import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import {
  type EntityListView,
  entitySummary,
} from "@cubby/schemas/entity-summary";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { z } from "zod";

import { DataTableToolbar } from "~/app/_components/data-table/data-table-toolbar";
import { ListWorkbench } from "~/app/_components/data-table/ListWorkbench";
import { createCubbyColumnHelper } from "~/app/_components/data-table/table-features";
import { useClientEntityList } from "~/app/_components/hooks/useClientEntityList";
import { useDeferredReferenceFilterOptions } from "~/app/_components/hooks/useDeferredReferenceFilterOptions";
import {
  type BaseListRow,
  type EntityListTreeConfig,
  useEntityList,
  type UseEntityListReturn,
} from "~/app/_components/hooks/useEntityList";
import { useFilterOptions } from "~/app/_components/hooks/useFilterOptions";
import type { ListQueryOptionsFn } from "~/app/_components/hooks/usePaginatedTableCore";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { EntityTimeline } from "~/app/_components/timeline/entity-timeline";
import { Stack } from "~/components/layout";
import { usePageCount } from "~/components/page/Page";
import { entities } from "~/entities/entities";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import type { StandardEntity } from "~/entities/entity-contracts";
import { createEntityDisplayColumns } from "~/entities/entity-display";
import { entityListFor } from "~/entities/entity-list.functions";
import {
  type ListEntity,
  listEntities,
} from "~/entities/generated/entity-lists.gen";
import { generatedBrowserCrudEntities } from "~/entities/generated/entity-routes.gen";
import {
  type TimelineEntity,
  timelineEntities,
} from "~/entities/generated/entity-timelines.gen";
import { listOverrides } from "~/entities/list-columns";
import {
  assertSpecialistColumnProvenance,
  type AnyEntityListOverride,
  type EntityListOverrideResult,
  type ListOverrideContext,
  type ListOverrideWorkbenchProps,
} from "~/entities/list-columns/types";

import { EntityShelf } from "./entity-shelf";
import { ListScopeChips } from "./list-scope-chips";
import {
  type ListNavigate,
  type ListSearch,
  listSearchSchema,
  type ListSlotProps,
} from "./list-slot-types";
import { listSlotFor } from "./list-slots";

/* -------------------------------------------------------------------------- */
/* Search + view                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The route's search as a bag plus a merge-navigate over it. Route-agnostic
 * on purpose: this component renders on every generated index route, each
 * with its own generated schema, so a typed `useNavigate` can't fit them all.
 */
export function useListSearch(): ListSlotProps {
  const search = listSearchSchema.parse(useSearch({ strict: false }));
  const routeNavigate = useNavigate();
  const navigate = useCallback<ListNavigate>(
    (patch, options) => {
      // SAFETY: route-specific search keys are intentionally erased here;
      // every generated index route validates the keys a view writes.
      routeNavigate({
        search: (previous: ListSearch) => ({ ...previous, ...patch }),
        replace: options?.replace,
      } as never);
    },
    [routeNavigate],
  );
  return { search, navigate };
}

const viewParam = z.string().optional().catch(undefined);

/** The declared views, and the one `?view=` selects (the first by default). */
export function resolveListView(
  entity: BrowserRoutedEntity,
  search: ListSearch,
) {
  const views: readonly EntityListView[] = entitySummary[entity].list.views;
  const requested = viewParam.parse(search.view);
  const view: EntityListView =
    views.find((candidate) => listViewId(candidate) === requested) ??
    views[0] ??
    "table";
  return { views, view };
}

/* -------------------------------------------------------------------------- */
/* Overrides                                                                   */
/* -------------------------------------------------------------------------- */

const NO_OVERRIDE: AnyEntityListOverride = { use: () => ({}) };
const DEFAULT_PREVIEW = { responsiveInspector: true } as const;
const useNoWorkbenchProps = (
  _list: UseEntityListReturn<BaseListRow>,
): ListOverrideWorkbenchProps<BaseListRow> => ({});

const isListEntity = (entity: BrowserRoutedEntity): entity is ListEntity =>
  listEntities.some((candidate) => candidate === entity);
const isTimelineEntity = (
  entity: BrowserRoutedEntity,
): entity is TimelineEntity =>
  timelineEntities.some((candidate) => candidate === entity);

const isStandardEntity = (
  entity: BrowserRoutedEntity,
): entity is StandardEntity =>
  generatedBrowserCrudEntities.some((candidate) => candidate === entity);

function useListColumns(
  entity: BrowserRoutedEntity,
  parts: EntityListOverrideResult<BaseListRow, object>,
) {
  const helper = useMemo(() => createCubbyColumnHelper<BaseListRow>(), []);
  const { overrides, compose } = parts;
  // Cookbook has a custom client-backed list but no standard update command.
  const mutationEntity = isStandardEntity(entity) ? entity : "product";
  const update = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory(mutationEntity, "update"),
    entity: mutationEntity,
  });
  return useMemo(() => {
    const declared = createEntityDisplayColumns(entity, helper, overrides, {
      onSaveField: async (row, field, value) => {
        if (!isStandardEntity(entity)) return;
        await update.mutateAsync({ id: row.id, data: { [field]: value } });
      },
    });
    return compose
      ? assertSpecialistColumnProvenance(entity, declared, compose(declared))
      : declared;
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- mutation result objects change every render; mutateAsync is the stable operation port.
  }, [entity, helper, overrides, compose, update.mutateAsync]);
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

export interface GenericEntityListProps {
  entity: BrowserRoutedEntity;
  /** Test seam: replaces the entity's generic list read. */
  operations?: { list?: ListQueryOptionsFn<object, BaseListRow> };
}

/**
 * The one list page: rendered from `entitySummary[entity].list` over
 * `useEntityList` + `ListWorkbench`, with the entity's hand-written half
 * (`entities/list-columns/<entity>`) and slot views (`listSlots`) plugged
 * in by registry. The view switcher and header live in `listPage`.
 */
export function GenericEntityList({
  entity,
  operations,
}: GenericEntityListProps) {
  const { search, navigate } = useListSearch();
  const { view } = resolveListView(entity, search);
  const override = listOverrides[entity] ?? NO_OVERRIDE;

  if (isSlotListView(view)) {
    const Slot = listSlotFor(entity, view.id);
    return Slot ? <Slot search={search} navigate={navigate} /> : null;
  }
  if (override.mode === "client") {
    return (
      <ClientListBody
        entity={entity}
        override={override}
        context={{ search, navigate }}
      />
    );
  }
  return (
    <ServerListBody
      entity={entity}
      view={view}
      override={override}
      context={{ search, navigate }}
      operations={operations}
    />
  );
}

function ServerListBody({
  entity,
  view,
  override,
  context,
  operations,
}: {
  entity: BrowserRoutedEntity;
  view: "table" | "shelf" | "timeline";
  override: AnyEntityListOverride;
  context: ListOverrideContext;
  operations: GenericEntityListProps["operations"];
}) {
  const parts = override.use(context);
  const referenceFilterOptions = useDeferredReferenceFilterOptions(entity);
  const filterOptions = useFilterOptions({
    ...referenceFilterOptions,
    ...parts.list?.filterOptions,
  });
  // Shelf/timeline are alternate presentations of the same roster. Keep the
  // selected view in the URL, but borrow the rich table projection while a
  // primary entity search is active; clearing restores the prior view without
  // reconstructing its navigation state.
  const searching = Boolean(context.search.searchQuery);
  const renderedView = searching ? "table" : view;
  const columns = useListColumns(entity, parts);
  const queryOptions = useMemo((): ListQueryOptionsFn<object, BaseListRow> => {
    if (operations?.list) return operations.list;
    if (parts.source) return parts.source;
    if (!isListEntity(entity))
      throw new Error(`${entity} has no list read and no list override source`);
    return entityListFor(entity).listQueryPlan;
  }, [entity, operations?.list, parts.source]);

  // `deletable` defaults ON: a top-level list page owns its entity's rows,
  // where an embedded relationship ledger does not.
  const list = useEntityList<BaseListRow, object, BaseListRow>({
    entity,
    queryOptions,
    columns,
    deletable: true,
    preview: DEFAULT_PREVIEW,
    ...parts.list,
    filterOptions,
    // SAFETY: the flat and tree overloads only differ in whether `tree` is
    // present; the hook branches on it at runtime.
    tree: parts.tree as EntityListTreeConfig<BaseListRow, BaseListRow>,
  });
  usePageCount(list.totalCount);
  // The module's hook or a no-op: one call per render either way.
  const useWorkbenchProps = parts.useWorkbench ?? useNoWorkbenchProps;
  const workbenchProps = useWorkbenchProps(list);
  const {
    onRowClick,
    onRowHover,
    onRowHoverEnd,
    PreviewSheet,
    preview,
    dockedInspector,
    inspectorToggle,
  } = list.inspection;
  const scopeChips = (
    <ListScopeChips
      entity={entity}
      search={context.search}
      onClear={(urlKey) =>
        context.navigate({ [urlKey]: undefined }, { replace: true })
      }
    />
  );
  const contextualStatus =
    workbenchProps.contextualStatus === undefined ? (
      scopeChips
    ) : (
      <>
        {scopeChips}
        {workbenchProps.contextualStatus}
      </>
    );

  const body = (
    <>
      {parts.above?.(list)}
      <Stack gap="sm">
        {renderedView !== "table" && (
          <DataTableToolbar
            table={list.workbench.table}
            entity={entity}
            portalWorkbenchUtilities
          />
        )}
        {renderedView === "table" && (
          <ListWorkbench
            model={list.workbench}
            ariaLabel={`${entities[entity].pluralLabel} table`}
            onRowClick={onRowClick}
            onRowHover={onRowHover}
            onRowHoverEnd={onRowHoverEnd}
            currentRowId={preview?.rowKey ?? preview?.id}
            desktopInspector={dockedInspector}
            inspectorToggle={inspectorToggle}
            {...workbenchProps}
            contextualStatus={contextualStatus}
          />
        )}
        {renderedView === "shelf" && (
          <EntityShelf
            entity={entity}
            // The shelf has no nesting: a tree's child rows (a kit's
            // components, a wish's candidates) are not a second thing on it.
            items={list.workbench.table
              .getRowModel()
              .rows.filter((row) => row.depth === 0)
              .map((row) => row.original)}
            isLoading={list.workbench.isLoading}
            error={list.workbench.error}
            infiniteScroll={list.workbench.infiniteScroll}
          />
        )}
        {renderedView === "timeline" && isTimelineEntity(entity) && (
          <ListTimeline
            entity={entity}
            filters={list.currentFilters}
            context={context}
          />
        )}
      </Stack>
      <PreviewSheet />
      {renderedView !== "table" && list.workbench.deleteDialog}
      {parts.below?.(list)}
    </>
  );
  return <>{parts.wrap ? parts.wrap(body, list) : body}</>;
}

/** The Timeline view: the entity's timeline over the current filters, window in the search keys. */
function ListTimeline({
  entity,
  filters,
  context,
}: {
  entity: TimelineEntity;
  filters: object;
  context: ListOverrideContext;
}) {
  const { search, navigate } = context;
  const controls = z
    .object({
      timelineFrom: z.string().optional(),
      timelineTo: z.string().optional(),
      timelineOrder: z.enum(["asc", "desc"]).optional(),
      timelineMode: z.enum(["events", "lifecycles"]).optional(),
    })
    .catch({})
    .parse(search);
  return (
    <EntityTimeline
      entity={entity}
      // SAFETY: `currentFilters` is the entity's own list filter object, which
      // is what its timeline read takes.
      filters={filters as never}
      from={controls.timelineFrom}
      to={controls.timelineTo}
      order={controls.timelineOrder ?? "desc"}
      mode={controls.timelineMode ?? "events"}
      onControlsChange={(patch) => {
        const next: ListSearch = {};
        if ("from" in patch) next.timelineFrom = patch.from;
        if ("to" in patch) next.timelineTo = patch.to;
        if ("order" in patch) next.timelineOrder = patch.order;
        if ("mode" in patch) next.timelineMode = patch.mode;
        navigate(next, { replace: true });
      }}
    />
  );
}

/** Client-paged rows (cookbook): same columns, workbench and preview seam. */
function ClientListBody({
  entity,
  override,
  context,
}: {
  entity: BrowserRoutedEntity;
  override: AnyEntityListOverride;
  context: ListOverrideContext;
}) {
  const parts = override.use(context);
  const columns = useListColumns(entity, parts);
  const client = parts.client;
  if (!client)
    throw new Error(`${entity} list override declares no client rows`);
  const { workbench, inspection } = useClientEntityList<BaseListRow>({
    entity,
    data: client.data,
    isLoading: client.isLoading,
    error: client.error,
    columns,
    preview: DEFAULT_PREVIEW,
    ...parts.list,
  });
  usePageCount(client.isLoading ? undefined : client.data.length);
  const {
    onRowClick,
    onRowHover,
    onRowHoverEnd,
    PreviewSheet,
    preview,
    dockedInspector,
    inspectorToggle,
  } = inspection;
  return (
    <>
      <ListWorkbench
        model={workbench}
        ariaLabel={`${entities[entity].pluralLabel} table`}
        onRowClick={onRowClick}
        onRowHover={onRowHover}
        onRowHoverEnd={onRowHoverEnd}
        currentRowId={preview?.id}
        desktopInspector={dockedInspector}
        inspectorToggle={inspectorToggle}
      />
      <PreviewSheet />
    </>
  );
}
