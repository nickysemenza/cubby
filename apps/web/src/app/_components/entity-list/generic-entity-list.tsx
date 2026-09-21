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
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import { z } from "zod";

import { DataTablePagination } from "~/app/_components/data-table/data-table-pagination";
import { DataTableToolbar } from "~/app/_components/data-table/data-table-toolbar";
import { ListWorkbench } from "~/app/_components/data-table/ListWorkbench";
import { createCubbyColumnHelper } from "~/app/_components/data-table/table-features";
import {
  identityListConfig,
  identityPatch,
} from "~/app/_components/entity-list/identity-list-config";
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

type CardDensity = "cards" | "compact";
const CardDensityContext = createContext<{
  density: CardDensity;
  setDensity: (density: CardDensity) => void;
} | null>(null);

/**
 * Compactness belongs to the mounted list screen, not the URL or persistence.
 * The provider is shared with the route chrome so its segmented control and
 * the card renderer change together.
 */
export function EntityListCardDensityProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [density, setDensity] = useState<CardDensity>("cards");
  return (
    <CardDensityContext value={{ density, setDensity }}>
      {children}
    </CardDensityContext>
  );
}

export function useEntityListCardDensity() {
  const context = useContext(CardDensityContext);
  if (!context)
    throw new Error("EntityListCardDensityProvider is required for card lists");
  return context;
}

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
  // Retired view ids remain valid URLs while resolving to the shared renderer.
  const aliases: Readonly<Record<string, string>> =
    entitySummary[entity].list.viewAliases;
  const requestedView =
    (requested === undefined ? undefined : aliases[requested]) ?? requested;
  const view: EntityListView =
    views.find((candidate) => listViewId(candidate) === requestedView) ??
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
  allowAutoIdentityEditing: boolean,
) {
  const helper = useMemo(() => createCubbyColumnHelper<BaseListRow>(), []);
  const { overrides, compose } = parts;
  // Cookbook has a custom client-backed list but no standard update command.
  const mutationEntity = isStandardEntity(entity) ? entity : "product";
  const update = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory(mutationEntity, "update"),
    entity: mutationEntity,
  });
  const identity = useMemo(
    () =>
      identityListConfig(entity, {
        generatedCrud: isStandardEntity(entity),
        flatRows:
          allowAutoIdentityEditing &&
          !parts.tree &&
          !parts.source &&
          !parts.client,
      }),
    [allowAutoIdentityEditing, entity, parts.client, parts.source, parts.tree],
  );
  const identityEditable = useMemo(() => {
    if (!identity.canAutoEdit || parts.list?.nameEditable) return undefined;
    return {
      onSave: async (newValue: string, row: BaseListRow) => {
        await update.mutateAsync({
          id: row.id,
          // SAFETY: identityListConfig proves this is the same non-null text
          // field in the generated entity's update roster.
          data: identityPatch(identity.titleField, newValue),
        });
      },
    };
    // oxlint-disable-next-line react/exhaustive-deps -- mutation result objects change every render; mutateAsync is the stable operation port.
  }, [identity, parts.list?.nameEditable, update.mutateAsync]);
  const columns = useMemo(() => {
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
  // The generic column collection is kept separate from the identity adapter
  // so client/custom-source lists can still share the same column compiler.
  return { columns, identityEditable };
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
        view={view}
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

// oxlint-disable-next-line complexity -- one server list owns its shared query, inspector, and three manifest renderers so their state cannot drift.
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
  const { density } = useEntityListCardDensity();
  const parts = override.use(context);
  const referenceFilterOptions = useDeferredReferenceFilterOptions(entity);
  const filterOptions = useFilterOptions({
    ...referenceFilterOptions,
    ...parts.list?.filterOptions,
  });
  // Cards and Compact keep the same query, filtering, ordering, and page as
  // List. A search changes the roster, never the chosen presentation.
  const renderedView = view;
  const { columns, identityEditable } = useListColumns(entity, parts, true);
  const listOptions = useMemo(() => {
    if (parts.list?.nameEditable || !identityEditable) return parts.list;
    return { ...parts.list, nameEditable: identityEditable };
  }, [identityEditable, parts.list]);
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
    ...listOptions,
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
    inspectRow,
    PreviewSheet,
    preview,
    dockedInspector,
    inspectorToggle,
  } = list.inspection;
  // Bulk actions only exist in List. Do not leave a hidden selection behind
  // when Cards or Compact becomes the active presentation.
  useEffect(() => {
    if (
      renderedView !== "table" &&
      Object.keys(list.workbench.table.atoms.rowSelection?.get() ?? {}).length >
        0
    )
      list.workbench.table.resetRowSelection();
  }, [list.workbench.table, renderedView]);
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
          <>
            {inspectorToggle}
            <div
              className={
                dockedInspector
                  ? "grid min-w-0 grid-cols-[minmax(0,1fr)_25rem]"
                  : "min-w-0"
              }
            >
              <div className="min-w-0">
                <EntityShelf
                  entity={entity}
                  // `data` is the canonical flat server projection before
                  // tree nesting and synthetic grouping rows reach the table.
                  // A shelf must never turn either into cards.
                  items={list.data}
                  isLoading={list.workbench.isLoading}
                  error={list.workbench.error}
                  infiniteScroll={list.workbench.infiniteScroll}
                  compact={density === "compact"}
                  onRetry={() =>
                    void list.workbench.refreshControls.onRefresh()
                  }
                  onInspect={(record) =>
                    inspectRow({
                      id: record.id,
                      original:
                        entity === "wish"
                          ? {
                              ...record,
                              entityType: entity,
                              previewId: record.id,
                            }
                          : record,
                    })
                  }
                  onRowHover={(record) =>
                    onRowHover({
                      id: record.id,
                      original:
                        entity === "wish"
                          ? {
                              ...record,
                              entityType: entity,
                              previewId: record.id,
                            }
                          : record,
                    })
                  }
                  onRowHoverEnd={(record) =>
                    onRowHoverEnd({ id: record.id, original: record })
                  }
                  currentRowId={preview?.rowKey ?? preview?.id}
                />
              </div>
              {dockedInspector && (
                <aside className="max-h-[calc(100vh-10rem)] overflow-y-auto border-l border-[var(--border)]">
                  {dockedInspector}
                </aside>
              )}
            </div>
          </>
        )}
        {renderedView === "shelf" && !list.workbench.infiniteScroll && (
          <DataTablePagination
            table={list.workbench.table}
            timing={list.workbench.timing}
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
  view,
  override,
  context,
}: {
  entity: BrowserRoutedEntity;
  view: "table" | "shelf" | "timeline";
  override: AnyEntityListOverride;
  context: ListOverrideContext;
}) {
  const { density } = useEntityListCardDensity();
  const parts = override.use(context);
  const { columns } = useListColumns(entity, parts, false);
  const client = parts.client;
  if (!client)
    throw new Error(`${entity} list override declares no client rows`);
  const { workbench, inspection } = useClientEntityList<BaseListRow>({
    entity,
    data: client.data,
    isLoading: client.isLoading,
    error: client.error,
    refetch: client.refetch,
    isRefreshing: client.isRefreshing,
    matchesSearch: client.matchesSearch,
    columns,
    preview: DEFAULT_PREVIEW,
    ...parts.list,
  });
  usePageCount(
    client.isLoading
      ? undefined
      : workbench.table.getFilteredRowModel().rows.length,
  );
  const {
    onRowClick,
    onRowHover,
    onRowHoverEnd,
    inspectRow,
    PreviewSheet,
    preview,
    dockedInspector,
    inspectorToggle,
  } = inspection;
  useEffect(() => {
    if (
      view !== "table" &&
      Object.keys(workbench.table.atoms.rowSelection?.get() ?? {}).length > 0
    )
      workbench.table.resetRowSelection();
  }, [view, workbench.table]);
  const body = (
    <>
      {view === "table" ? (
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
      ) : (
        <Stack gap="sm">
          <DataTableToolbar table={workbench.table} entity={entity} />
          {inspectorToggle}
          <div
            className={
              dockedInspector
                ? "grid min-w-0 grid-cols-[minmax(0,1fr)_25rem]"
                : "min-w-0"
            }
          >
            <div className="min-w-0">
              <EntityShelf
                entity={entity}
                items={workbench.table
                  .getRowModel()
                  .rows.map((row) => row.original)}
                isLoading={workbench.isLoading}
                error={workbench.error}
                compact={density === "compact"}
                onRetry={
                  workbench.refreshControls
                    ? () => void workbench.refreshControls?.onRefresh()
                    : undefined
                }
                onInspect={(record) =>
                  inspectRow({ id: record.id, original: record })
                }
                onRowHover={(record) =>
                  onRowHover({ id: record.id, original: record })
                }
                onRowHoverEnd={(record) =>
                  onRowHoverEnd({ id: record.id, original: record })
                }
                currentRowId={preview?.rowKey ?? preview?.id}
              />
            </div>
            {dockedInspector && (
              <aside className="max-h-[calc(100vh-10rem)] overflow-y-auto border-l border-[var(--border)]">
                {dockedInspector}
              </aside>
            )}
          </div>
          <DataTablePagination table={workbench.table} />
        </Stack>
      )}
      <PreviewSheet />
    </>
  );
  return <>{parts.wrap ? parts.wrap(body, { data: client.data }) : body}</>;
}
